import type { AgentModelUsage, AgentQuestion } from "@/lib/agent/contracts";
import type {
  PhaseBRuntime,
  RuntimeCompactionRequest,
  RuntimeConfirmation,
  RuntimeEventRecord,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  RuntimeUsage,
} from "./types";
import { normalizeToolName } from "./harness-core";

function sumUsage(modelUsage: Record<string, AgentModelUsage> | undefined): RuntimeUsage {
  const values = Object.values(modelUsage ?? {});
  const sum = (key: keyof AgentModelUsage): number | null =>
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

export class PiPhaseBRuntime implements PhaseBRuntime {
  readonly id = "pi";
  readonly providerProtocol = "anthropic-messages";
  readonly capabilities = {
    controlledAbort: true,
    forcedCompaction: true,
  };

  async forceCompact(request: RuntimeCompactionRequest): Promise<RuntimeEventRecord[]> {
    const path = await import("node:path");
    const { readAgentSettings } = await import("@/lib/settings/agent-settings");
    const {
      getPiAgentDir,
      getPiSessionDir,
      getProjectRoot,
    } = await import("@/lib/runtime/paths");
    const { createFinworkModelRuntime } = await import("@/lib/agent/pi/provider");
    const { createFinworkPiResourceLoader } = await import("@/lib/agent/pi/resource-loader");
    const { PiEventMapper } = await import("@/lib/agent/pi/event-mapper");
    const { validatePiSessionLocator } = await import("@/lib/agent/pi/agent-service");
    const { createAgentSession, SessionManager, SettingsManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const settings = await readAgentSettings();
    const modelId = (request.model || settings.reasoningModel || "").trim();
    const { modelRuntime, model } = await createFinworkModelRuntime(settings, modelId);
    const cwd = getProjectRoot();
    const sessionRoot = path.resolve(getPiSessionDir());
    const agentDir = path.resolve(getPiAgentDir());
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 32 },
      retry: { enabled: false },
    });
    const resourceLoader = await createFinworkPiResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPrompt: "Finwork 受控会话压缩。",
      skillNames: [],
    });
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      noTools: "builtin",
      customTools: [],
      resourceLoader,
      sessionManager: SessionManager.open(
        validatePiSessionLocator(request.sessionId, sessionRoot),
        sessionRoot,
        cwd,
      ),
      settingsManager,
    });
    const events: RuntimeEventRecord[] = [];
    const mapper = new PiEventMapper();
    const unsubscribe = created.session.subscribe((event) => {
      for (const mapped of mapper.map(event).events) {
        events.push({ at: new Date().toISOString(), event: mapped });
      }
    });
    try {
      await created.session.compact(
        "保留用户当前任务、会话内分析口径、关键数字和已完成步骤；不要把会话口径写入长期记忆。",
      );
      await created.session.waitForIdle();
      return events;
    } finally {
      unsubscribe();
      created.session.dispose();
    }
  }

  async runTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    const { runPiAgent } = await import("@/lib/agent/pi/agent-service");
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
      const result = await runPiAgent({
        messages: request.messages,
        requestId: request.runId,
        traceId: request.runId,
        runtimeSessionId: request.sessionId,
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
        sessionId: result.runtimeSessionId,
        outcome,
        terminationReason: controller.signal.aborted ? "user_stop" : null,
        events,
        confirmations,
        usage,
      };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const partial = (error as { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage;
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
