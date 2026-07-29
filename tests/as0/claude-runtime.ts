import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQuestion } from "@/lib/agent/claude-adapter";
import type {
  PhaseBRuntime,
  RuntimeConfirmation,
  RuntimeEventRecord,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  RuntimeUsage,
} from "./types";
import { normalizeToolName } from "./harness-core";

function sumUsage(modelUsage: Record<string, ModelUsage> | undefined): RuntimeUsage {
  const values = Object.values(modelUsage ?? {});
  const sum = (key: keyof ModelUsage): number | null =>
    values.length ? values.reduce((total, usage) => total + Number(usage[key] ?? 0), 0) : null;
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadInputTokens: sum("cacheReadInputTokens"),
    cacheCreationInputTokens: sum("cacheCreationInputTokens"),
    totalCostUsd: null,
    turns: null,
    models: Object.keys(modelUsage ?? {}),
  };
}

function confirmationAnswer(expectation: RuntimeTurnRequest["confirmation"], question: AgentQuestion): string {
  if (question.kind !== "confirm") return "";
  if (expectation === "accept" || expectation === "accept_if_requested") return "确认";
  return "取消";
}

export class ClaudePhaseBRuntime implements PhaseBRuntime {
  readonly id = "claude-agent-sdk";
  readonly providerProtocol = "anthropic-messages";
  readonly capabilities = {
    controlledAbort: true,
    forcedCompaction: false,
  };

  async runTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    const { runClaudeAgent } = await import("@/lib/agent/claude-adapter");
    const controller = new AbortController();
    const events: RuntimeEventRecord[] = [];
    const confirmations: RuntimeConfirmation[] = [];
    let abortTriggered = false;

    const recordEvent = (event: RuntimeEventRecord["event"], instanceId?: string) => {
      events.push({ at: new Date().toISOString(), event, ...(instanceId ? { instanceId } : {}) });
      if (
        !abortTriggered &&
        request.abortControl?.abortAfterEvent === event.type &&
        event.type === "tool_started"
      ) {
        const allowed = request.abortControl.toolNameOneOf ?? [];
        if (allowed.length === 0 || allowed.includes(normalizeToolName(event.toolName)) || allowed.includes(event.toolName)) {
          abortTriggered = true;
          controller.abort();
        }
      }
    };

    const resolveUserQuestion = async (question: AgentQuestion) => {
      const answer = confirmationAnswer(request.confirmation, question);
      confirmations.push({
        at: new Date().toISOString(),
        question: question.question,
        kind: question.kind === "confirm" ? "confirm" : "question",
        answer,
      });
      return answer;
    };

    try {
      const result = await runClaudeAgent(request.messages, {
        requestId: request.runId,
        traceId: request.runId,
        claudeSessionId: request.sessionId,
        resumeSession: request.resumeSession,
        attachments: request.attachments,
        outputDir: request.outputDir,
        taskContract: request.taskContract,
        modelOverride: request.model,
        signal: controller.signal,
        resolveUserQuestion,
        emit: (event) => recordEvent(event),
        onSubagentEvent: (event, instanceId) => recordEvent(event, instanceId),
      });
      if (result.mode === "mock") {
        throw new Error("Phase B live harness refuses mock-agent results");
      }
      const usage = sumUsage(result.modelUsage);
      usage.totalCostUsd = result.totalCostUsd ?? null;
      usage.turns = result.numTurns ?? null;
      const outcome = controller.signal.aborted ? "aborted" : "completed";
      recordEvent({ type: "run_settled", outcome });
      return {
        content: result.content,
        sessionId: result.claudeSessionId,
        outcome,
        terminationReason: controller.signal.aborted ? "user_stop" : null,
        events,
        confirmations,
        usage,
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const partial = (error as { __modelUsage?: Record<string, ModelUsage> }).__modelUsage;
      const outcome = aborted ? "aborted" : "error";
      recordEvent({
        type: "run_settled",
        outcome,
        ...(aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
      });
      return {
        content: "",
        sessionId: request.sessionId,
        outcome,
        terminationReason: aborted ? "user_stop" : "runtime_error",
        events,
        confirmations,
        usage: sumUsage(partial),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
