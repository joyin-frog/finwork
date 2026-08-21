import { randomUUID } from "node:crypto";
import { buildMessagesUrl } from "@/lib/agent/router";
import { readAgentSettings, type AgentSettings } from "@/lib/settings/agent-settings";
import {
  BenchmarkPredictionSchema,
  type BenchmarkExecutionCase,
  type BenchmarkExecutor,
} from "./contracts";

export type DirectModelBenchmarkExecutorOptions = {
  model: string;
  readSettings?: () => Promise<AgentSettings>;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** Layer 3: one provider completion, no Router, Pi loop, tools, memory, repair or artifact delivery. */
export function createDirectModelBenchmarkExecutor(
  options: DirectModelBenchmarkExecutorOptions,
): BenchmarkExecutor {
  const model = options.model.trim();
  if (!model) throw new Error("model evaluation requires one explicit model");
  return async (executionCase, context) => {
    if (!isAnswerOnlyCase(executionCase)) {
      throw new Error(`model evaluation rejects agentic case:${executionCase.id}`);
    }
    const startedAt = (options.now ?? Date.now)();
    const traceId = randomUUID();
    const settings = await (options.readSettings ?? readAgentSettings)();
    try {
      const response = await (options.fetchImpl ?? fetch)(buildMessagesUrl(settings.apiUrl), {
        method: "POST",
        headers: {
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: Math.max(1, Math.min(4_096, context.taskContract.budget.tokenLimit ?? 4_096)),
          system: "Answer the financial question using only the supplied public context. Return the answer and a concise calculation; do not call tools or claim external retrieval.",
          messages: [{ role: "user", content: formatModelPrompt(executionCase) }],
        }),
        signal: context.signal,
      });
      if (!response.ok) throw providerHttpError(response.status);
      const payload: unknown = await response.json();
      const answer = extractText(payload);
      if (!answer) throw Object.assign(new Error("provider response contained no text"), { code: "provider_empty_response" });
      const usage = extractUsage(payload);
      const actualModel = extractActualModel(payload, model);
      return BenchmarkPredictionSchema.parse({
        answer,
        metrics: {
          wallTimeMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
          tokens: usage.inputTokens + usage.outputTokens
            + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
          retries: 0,
          toolCalls: 0,
        },
        execution: executionSummary({ traceId, usage, startedAt, now: options.now ?? Date.now }),
        details: { evaluationLayer: "model", requestedModel: model, actualModel },
      });
    } catch (error) {
      const code = errorCode(error);
      const kind = failureKind(code);
      return BenchmarkPredictionSchema.parse({
        metrics: {
          wallTimeMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
          tokens: 0,
          retries: 0,
          toolCalls: 0,
        },
        failure: {
          kind,
          code,
          source: code.startsWith("provider_") ? "dependency" : "evaluator",
        },
        execution: executionSummary({
          traceId,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          startedAt,
          now: options.now ?? Date.now,
          failureCode: code,
        }),
        details: { evaluationLayer: "model", requestedModel: model },
      });
    }
  };
}

function isAnswerOnlyCase(executionCase: BenchmarkExecutionCase): boolean {
  return executionCase.taskKind === "qa"
    && !executionCase.requirements.artifactOutput
    && !executionCase.requirements.requiresCitations;
}

export function formatModelPrompt(executionCase: BenchmarkExecutionCase): string {
  const blocks = executionCase.context.textBlocks.map((block) =>
    [block.title, block.text].filter(Boolean).join("\n"),
  );
  const tables = executionCase.context.tables.map((table) => [
    table.title ?? table.id,
    table.columns.join(" | "),
    ...table.rows.map((row) => row.join(" | ")),
  ].join("\n"));
  const conversation = executionCase.context.conversation.map((turn) => `${turn.role}: ${turn.text}`);
  return [...blocks, ...tables, ...conversation, executionCase.prompt].filter(Boolean).join("\n\n");
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("").trim();
}

function extractUsage(payload: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
} {
  const usage = payload && typeof payload === "object" && (payload as { usage?: unknown }).usage
    && typeof (payload as { usage?: unknown }).usage === "object"
    ? (payload as { usage: Record<string, unknown> }).usage
    : {};
  const token = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key])
    ? Math.max(0, Math.floor(usage[key] as number))
    : 0;
  return {
    inputTokens: token("input_tokens"),
    outputTokens: token("output_tokens"),
    cacheReadInputTokens: token("cache_read_input_tokens"),
    cacheCreationInputTokens: token("cache_creation_input_tokens"),
  };
}

function extractActualModel(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && typeof (payload as { model?: unknown }).model === "string"
    ? String((payload as { model: string }).model)
    : fallback;
}

function executionSummary(input: {
  traceId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  startedAt: number;
  now: () => number;
  failureCode?: string;
}) {
  return {
    traceId: input.traceId,
    caseId: `model-case-${input.traceId}`,
    taskId: `model-task-${input.traceId}`,
    runId: input.traceId,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
    latencyMs: Math.max(0, input.now() - input.startedAt),
    retries: 0,
    costUsd: null,
    artifactRefs: [],
    evidenceRefs: [],
    validation: {
      assertions: { total: 0, passed: 0, failed: 0 },
      delivery: { required: false, delivered: 0, passed: true },
    },
    termination: { cancelled: false, aborted: false, timedOut: false },
    stableFailureCode: input.failureCode ?? null,
  };
}

function providerHttpError(status: number): Error {
  const code = status === 401 || status === 403
    ? "provider_auth_failed"
    : status === 404
      ? "provider_model_or_endpoint_invalid"
      : status === 429
        ? "provider_rate_limited"
        : "provider_response_failed";
  return Object.assign(new Error(`provider HTTP ${status}`), { code });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code);
  }
  if (error instanceof DOMException && error.name === "AbortError") return "benchmark_aborted";
  return "model_executor_failed";
}

function failureKind(code: string): string {
  if (code === "provider_auth_failed" || code === "provider_model_or_endpoint_invalid") {
    return "dependency_unavailable";
  }
  if (code.startsWith("provider_")) return "transient_external_failure";
  if (code === "benchmark_aborted") return "canceled";
  return "internal_error";
}
