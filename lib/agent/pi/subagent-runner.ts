import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { modelConfigFromSettings, resolveExecutionModel } from "@/lib/settings/model-config";
import { getProjectRoot } from "@/lib/runtime/paths";
import { getRoleMemoryForPrompt } from "@/lib/db/role-memory-store";
import * as dispatchStore from "@/lib/db/dispatch-store";
import { getDisabledRoleIds } from "@/lib/agent/roles/availability";
import {
  getRoleDefinition,
  resolveRoleAllowedTools,
} from "@/lib/agent/roles/registry";
import { buildSubagentSystemPrompt } from "@/lib/agent/subagent-prompts";
import {
  buildFinanceToolDefinitions,
  type FinanceMcpServerOptions,
} from "@/lib/agent/mcp-tools";
import { createFinanceToolAuthorizer } from "@/lib/agent/tools/authorize";
import { createPiFinanceTools } from "@/lib/agent/pi/tool-adapter";
import { createFinworkModelRuntime } from "@/lib/agent/pi/provider";
import { createFinworkPiResourceLoader } from "@/lib/agent/pi/resource-loader";
import { PiEventMapper } from "@/lib/agent/pi/event-mapper";
import { Semaphore } from "@/lib/utils/semaphore";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type {
  SubagentParallelExecutor,
  SubagentResult,
  SubagentRunOptions,
  SubagentTask,
} from "@/lib/agent/subagent-contracts";

const SUBAGENT_TIMEOUT_MS = 180_000;

/**
 * Pi-native isolated worker session. This is injected into the neutral finance
 * catalog; the production Claude runner remains untouched until AR10 passes.
 */
export async function runPiSubagent(
  task: SubagentTask,
  options: SubagentRunOptions,
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  const safeLabel = task.label.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + Date.now();
  const outputDir = path.join(options.parentOutputDir, "subagents", safeLabel);
  const sessionRoot = path.join(outputDir, ".pi-session");
  const agentDir = path.join(sessionRoot, "agent-config");
  mkdirSync(sessionRoot, { recursive: true });

  let dispatchId: number | null = null;
  let session: AgentSession | null = null;
  let settled = false;
  let aborted = options.signal?.aborted === true;
  const emit = (event: AgentRuntimeEvent) => {
    if (settled) return;
    options.onEvent?.(decorateSubagentEvent(event, task), instanceId);
    if (event.type === "run_settled") settled = true;
  };

  try {
    const role = getRoleDefinition(task.roleId);
    if (!role) return failure(task, startedAt, `未知角色 "${task.roleId}"：请从 spawn_subagent 的 role 枚举中选择。`);
    if (!role.available) return failure(task, startedAt, `角色 "${task.roleId}"（${role.name}）尚未启用，无法执行任务。`);
    if (getDisabledRoleIds().includes(task.roleId)) {
      return failure(task, startedAt, `角色 "${task.roleId}"（${role.name}）已停用，无法执行任务。如需使用请在「智能体」页面重新启用。`);
    }

    dispatchId = task.existingDispatchId ?? recordDispatchStart(task, options);
    if (aborted) throw new Error("Subagent execution aborted");

    const settings = await readAgentSettings();
    if (!settings.apiKey.trim()) {
      const result = failure(task, startedAt, "API Key 未配置。");
      recordDispatchEnd(dispatchId, result, aborted);
      return result;
    }
    const config = modelConfigFromSettings(settings);
    if (!config) throw new Error("模型配置不完整");
    const modelId = resolveExecutionModel({ config, purpose: "subagent" }).modelId;
    const { modelRuntime, model } = await createFinworkModelRuntime(settings, modelId);
    const {
      createAgentSession,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");

    let memories: string[] = [];
    try {
      memories = getRoleMemoryForPrompt(task.roleId);
    } catch (error) {
      console.warn("[pi-subagent] 角色记忆加载失败，跳过注入：", error);
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_192 },
      retry: { enabled: false },
    });
    const resourceLoader = await createFinworkPiResourceLoader({
      cwd: getProjectRoot(),
      agentDir,
      settingsManager,
      systemPrompt: buildSubagentSystemPrompt(role, memories),
      skillNames: role.skills,
    });

    const serverOptions: FinanceMcpServerOptions = {
      subagentExecutor: runPiSubagent,
      subagentParallelExecutor: runPiSubagentsParallel,
    };
    const allowed = new Set(resolveRoleAllowedTools(task.roleId));
    const definitions = buildFinanceToolDefinitions(
      outputDir,
      options.traceId,
      options.conversationId,
      options.onEvent,
      serverOptions,
    ).filter((definition) => allowed.has(definition.id));
    const tools = createPiFinanceTools(
      definitions,
      createFinanceToolAuthorizer({
        outputDir,
        roleId: task.roleId,
        conversationId: numericConversationId(options.conversationId),
      }),
    );

    const created = await createAgentSession({
      cwd: getProjectRoot(),
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      noTools: "builtin",
      customTools: tools,
      resourceLoader,
      sessionManager: SessionManager.create(getProjectRoot(), sessionRoot),
      settingsManager,
    });
    session = created.session;
    if (aborted) throw new Error("Subagent execution aborted");

    const mapper = new PiEventMapper();
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "error") {
        aborted = event.assistantMessageEvent.reason === "aborted";
      }
      const mapped = mapper.map(event);
      for (const runtimeEvent of mapped.events) {
        if (isSubagentMilestone(runtimeEvent)) emit(runtimeEvent);
      }
    });

    const abortSession = () => {
      aborted = true;
      void session?.abort();
    };
    options.signal?.addEventListener("abort", abortSession, { once: true });
    const timeout = setTimeout(abortSession, SUBAGENT_TIMEOUT_MS);
    try {
      let prompt = task.instructions;
      if (task.files?.length) {
        prompt += `\n\n以下文件供参考：\n${task.files.map((file) => `- ${file}`).join("\n")}`;
      }
      await session.prompt(prompt);
      await session.waitForIdle();
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortSession);
    }

    const content =
      assistantText(session.state.messages) ||
      (aborted ? "子 Agent 执行已取消。" : "子 Agent 已执行，但没有返回文本结果。");
    const result: SubagentResult = {
      label: task.label,
      content,
      success: !aborted,
      durationMs: Date.now() - startedAt,
    };
    recordDispatchEnd(dispatchId, result, aborted);
    return result;
  } catch (error) {
    const result = failure(
      task,
      startedAt,
      aborted ? "子 Agent 执行已取消。" : error instanceof Error ? error.message : String(error),
    );
    recordDispatchEnd(dispatchId, result, aborted);
    if (!settled) {
      emit({
        type: "run_ended",
        kind: "incomplete",
        success: false,
        durationMs: result.durationMs,
      });
      emit({ type: "run_settled", outcome: aborted ? "aborted" : "error", error: result.content });
    }
    return result;
  } finally {
    session?.dispose();
  }
}

export const runPiSubagentsParallel: SubagentParallelExecutor = async (tasks, options) => {
  const semaphore = new Semaphore(options.concurrency ?? 5);
  const settled = await Promise.allSettled(
    tasks.map(async (task) => {
      const release = await semaphore.acquire();
      try {
        return await runPiSubagent(task, options);
      } finally {
        release();
      }
    }),
  );
  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : failure(
          tasks[index],
          Date.now(),
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        ),
  );
};

function isSubagentMilestone(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_started" ||
    event.type === "tool_completed" ||
    event.type === "run_blocked" ||
    event.type === "run_ended" ||
    event.type === "run_settled"
  );
}

function decorateSubagentEvent(
  event: AgentRuntimeEvent,
  task: SubagentTask,
): AgentRuntimeEvent {
  if (
    event.type === "run_started" ||
    event.type === "tool_completed" ||
    event.type === "run_blocked" ||
    event.type === "run_ended"
  ) {
    return { ...event, label: task.label, roleId: task.roleId };
  }
  return event;
}

function assistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (message.role !== "assistant") continue;
    return (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function failure(task: SubagentTask, startedAt: number, content: string): SubagentResult {
  return {
    label: task.label,
    content,
    success: false,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function numericConversationId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordDispatchStart(
  task: SubagentTask,
  options: SubagentRunOptions,
): number | null {
  try {
    return dispatchStore.recordDispatchStart({
      roleId: task.roleId,
      label: task.label,
      conversationId: options.conversationId,
      traceId: options.traceId,
      taskTemplateId: task.taskTemplateId,
      businessObject: task.businessObject,
      period: task.period,
      files: task.files,
    });
  } catch (error) {
    console.warn("[pi-subagent] dispatch-start 失败（不影响任务）：", error);
    return null;
  }
}

function recordDispatchEnd(
  dispatchId: number | null,
  result: SubagentResult,
  aborted: boolean,
): void {
  if (dispatchId == null) return;
  try {
    dispatchStore.recordDispatchEnd(dispatchId, {
      status: result.success ? "success" : "failed",
      summary: result.content.slice(0, 200),
      blockedReasons: aborted ? ["aborted"] : [],
    });
  } catch (error) {
    console.warn("[pi-subagent] dispatch-end 失败（不影响任务）：", error);
  }
}
