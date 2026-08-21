import { randomUUID } from "node:crypto";
import { readAgentSettings, type AgentSettings } from "@/lib/settings/agent-settings";
import { resolveModelMetadata } from "@/lib/agent/pi/model-catalog";
import {
  classifyTransientProviderError,
  withTransientProviderRetry,
} from "@/lib/evaluation/transient-provider-retry";
import type { FaultDomain } from "@/lib/evaluation/contracts";
import { resolveMessagesEndpoint, type RealApiBudgets } from "./preflight";

export type ConnectionSmokeProbe = {
  role: "fast" | "reasoning";
  requestedModel: string;
  responseModel: string;
  responseModelMatchesRequest: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retries: number;
};

export type ConnectionSmokeReport = {
  schemaVersion: 1;
  runId: string;
  status: "passed" | "failed";
  realApi: true;
  publishable: false;
  providerHost: string;
  pricingKnown: boolean;
  costUsd: number | null;
  startedAt: string;
  endedAt: string;
  probes: ConnectionSmokeProbe[];
  totals: { inputTokens: number; outputTokens: number; retries: number; latencyMs: number };
  failure: null | {
    role: "fast" | "reasoning";
    requestedModel: string;
    faultDomain: FaultDomain;
    code: string;
    attempts: number;
    reportedModel?: string;
  };
};

export class ConnectionSmokeExecutionError extends Error {
  readonly report: ConnectionSmokeReport;

  constructor(report: ConnectionSmokeReport) {
    super(report.failure?.code ?? "connection_smoke_failed");
    this.name = "ConnectionSmokeExecutionError";
    this.report = report;
  }
}

class ProviderResponseModelMismatchError extends Error {
  readonly reportedModel: string;

  constructor(reportedModel: string) {
    super("provider response model does not match requested model");
    this.name = "ProviderResponseModelMismatchError";
    this.reportedModel = reportedModel;
  }
}

export interface RunConnectionSmokeOptions {
  budgets: Required<Pick<RealApiBudgets, "maxInputTokens" | "maxOutputTokens" | "maxWallMs">> & { maxCostUsd?: number };
  settings?: AgentSettings;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  pricingKnown: boolean;
}

export async function runConnectionSmoke(options: RunConnectionSmokeOptions): Promise<ConnectionSmokeReport> {
  const settings = options.settings ?? await readAgentSettings();
  const endpoint = resolveMessagesEndpoint(settings.apiUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = `connection-smoke-${randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("connection smoke wall-time budget exceeded")), options.budgets.maxWallMs);
  const probes: ConnectionSmokeProbe[] = [];
  let activeProbe: { role: "fast" | "reasoning"; requestedModel: string; attempts: number } | null = null;
  try {
    const modelRoles = [
      { role: "fast" as const, model: settings.fastModel },
      { role: "reasoning" as const, model: settings.reasoningModel },
    ];
    for (const item of modelRoles) {
      activeProbe = { role: item.role, requestedModel: item.model, attempts: 0 };
      // Keep the echo payload compact. Some OpenAI-compatible gateways include
      // hidden reasoning in output_tokens, so a full UUID can make two probes
      // exceed the Spec's aggregate 64-token gate even though max_tokens is 32.
      // Sixteen hex digits still give each paid probe a 64-bit unique nonce.
      const nonce = `fw-${item.role[0]}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const probeStarted = now();
      const retried = await withTransientProviderRetry(async (attempt) => {
        activeProbe!.attempts = attempt;
        const response = await fetchImpl(endpoint.url, {
          method: "POST",
          headers: {
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: item.model,
            max_tokens: Math.min(32, options.budgets.maxOutputTokens),
            messages: [{ role: "user", content: `Return exactly this nonce and nothing else: ${nonce}` }],
          }),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          const error = Object.assign(new Error(`provider HTTP ${response.status}`), {
            status: response.status,
            retryAfter: response.headers.get("retry-after") ?? undefined,
          });
          throw error;
        }
        const payload = await response.json() as unknown;
        return parseProbePayload(payload, item.model, nonce);
      }, {
        maxAttempts: 2,
        signal: controller.signal,
        deadlineAt: startedMs + options.budgets.maxWallMs,
        now,
        sleep: options.sleep,
        shouldRetry: () => true,
      });
      probes.push({
        role: item.role,
        requestedModel: item.model,
        responseModel: retried.value.model,
        responseModelMatchesRequest: retried.value.model === item.model,
        inputTokens: retried.value.inputTokens,
        outputTokens: retried.value.outputTokens,
        latencyMs: Math.max(0, now() - probeStarted),
        retries: retried.attempts - 1,
      });
      enforceAggregateBudget(probes, options.budgets);
      activeProbe = null;
    }
  } catch (error) {
    if (activeProbe) {
      const classified = classifyConnectionSmokeFailure(error);
      throw new ConnectionSmokeExecutionError(buildReport({
        runId,
        status: "failed",
        settings,
        endpointHost: endpoint.host,
        pricingKnown: options.pricingKnown,
        startedAt,
        endedAt: new Date(now()).toISOString(),
        probes,
        failure: {
          ...activeProbe,
          ...classified,
          ...(error instanceof ProviderResponseModelMismatchError ? { reportedModel: error.reportedModel } : {}),
        },
      }));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const report = buildReport({
    runId,
    status: "passed",
    settings,
    endpointHost: endpoint.host,
    pricingKnown: options.pricingKnown,
    startedAt,
    endedAt: new Date(now()).toISOString(),
    probes,
    failure: null,
  });
  const costUsd = report.costUsd;
  if (costUsd !== null && options.budgets.maxCostUsd !== undefined && costUsd > options.budgets.maxCostUsd) {
    const finalProbe = probes.at(-1)!;
    throw new ConnectionSmokeExecutionError({
      ...report,
      status: "failed",
      failure: {
        role: finalProbe.role,
        requestedModel: finalProbe.requestedModel,
        faultDomain: "resource",
        code: "connection_smoke_cost_budget_exceeded",
        attempts: finalProbe.retries + 1,
      },
    });
  }
  return report;
}

function parseProbePayload(payload: unknown, requestedModel: string, nonce: string): {
  model: string;
  inputTokens: number;
  outputTokens: number;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("provider response is not an object");
  const value = payload as Record<string, unknown>;
  const model = typeof value.model === "string" ? value.model : "";
  if (!model.trim()) throw new Error("provider response model is missing or invalid");
  if (model !== requestedModel) throw new ProviderResponseModelMismatchError(model);
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const record = block as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
  if (!text.includes(nonce)) throw new Error("provider response did not echo the unique nonce");
  const usage = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
    ? value.usage as Record<string, unknown>
    : {};
  const inputTokens = integer(usage.input_tokens);
  const outputTokens = integer(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) throw new Error("provider response usage is missing or invalid");
  return { model, inputTokens, outputTokens };
}

function enforceAggregateBudget(
  probes: readonly ConnectionSmokeProbe[],
  budgets: RunConnectionSmokeOptions["budgets"],
): void {
  const input = probes.reduce((sum, probe) => sum + probe.inputTokens, 0);
  const output = probes.reduce((sum, probe) => sum + probe.outputTokens, 0);
  if (input > budgets.maxInputTokens) throw new Error("connection smoke input token budget exceeded");
  if (output > budgets.maxOutputTokens) throw new Error("connection smoke output token budget exceeded");
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function buildReport(input: {
  runId: string;
  status: "passed" | "failed";
  settings: AgentSettings;
  endpointHost: string;
  pricingKnown: boolean;
  startedAt: string;
  endedAt: string;
  probes: ConnectionSmokeProbe[];
  failure: ConnectionSmokeReport["failure"];
}): ConnectionSmokeReport {
  const totals = input.probes.reduce((sum, probe) => ({
    inputTokens: sum.inputTokens + probe.inputTokens,
    outputTokens: sum.outputTokens + probe.outputTokens,
    retries: sum.retries + probe.retries,
    latencyMs: sum.latencyMs + probe.latencyMs,
  }), { inputTokens: 0, outputTokens: 0, retries: 0, latencyMs: 0 });
  const costUsd = input.pricingKnown
    ? input.probes.reduce((sum, probe) => {
        const rates = resolveModelMetadata(probe.requestedModel, input.settings.modelPricing).cost;
        return sum + (probe.inputTokens * rates.input + probe.outputTokens * rates.output) / 1_000_000;
      }, 0)
    : null;
  return {
    schemaVersion: 1,
    runId: input.runId,
    status: input.status,
    realApi: true,
    publishable: false,
    providerHost: input.endpointHost,
    pricingKnown: input.pricingKnown,
    costUsd,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    probes: input.probes,
    totals,
    failure: input.failure,
  };
}

function classifyConnectionSmokeFailure(error: unknown): { faultDomain: FaultDomain; code: string } {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || /budget|wall-time/i.test(error.message))) {
    return { faultDomain: "resource", code: "connection_smoke_resource_limit" };
  }
  const decision = classifyTransientProviderError(error);
  if (error instanceof ProviderResponseModelMismatchError) {
    return { faultDomain: "dependency", code: "provider_response_model_mismatch" };
  }
  if (decision.status === 401 || decision.status === 403) {
    return { faultDomain: "dependency", code: "provider_auth_failed" };
  }
  if (decision.status === 400 || decision.status === 404) {
    return { faultDomain: "dependency", code: "provider_model_or_endpoint_not_found" };
  }
  if (decision.status === 429) return { faultDomain: "dependency", code: "provider_rate_limited" };
  if (decision.status !== undefined && decision.status >= 500) {
    return { faultDomain: "dependency", code: "provider_unavailable" };
  }
  if (decision.retryable) return { faultDomain: "dependency", code: "provider_transport_failed" };
  return { faultDomain: "dependency", code: "provider_response_invalid" };
}
