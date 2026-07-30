import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AgentAttachment,
  AgentMessage,
  AgentModelUsage,
  AgentQuestion,
  FinworkAgentRequest,
  FinworkAgentResult,
  FinworkAgentUsage,
} from "@/lib/agent/contracts";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { getPiAgentDir, getPiSessionDir, getProjectRoot } from "@/lib/runtime/paths";
import { ensureConventionsMigrated } from "@/lib/memory/migrate-conventions";
import { readMemoryMarkdown } from "@/lib/memory/file-store";
import { readCompanyProfile } from "@/lib/profile/file-store";
import { listRecentNegativeReasons } from "@/lib/db/sqlite";
import { assertSpecialistRoleUsable } from "@/lib/agent/roles/availability";
import { getRoleMemoryForPrompt } from "@/lib/db/role-memory-store";
import { resolveRoleAllowedTools } from "@/lib/agent/roles/registry";
import { buildSpecialistChatSystemPrompt } from "@/lib/agent/subagent-prompts";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { createFinanceToolAuthorizer } from "@/lib/agent/tools/authorize";
import { createPiFinanceTools } from "@/lib/agent/pi/tool-adapter";
import { createFinworkModelRuntime } from "@/lib/agent/pi/provider";
import { createFinworkPiResourceLoader } from "@/lib/agent/pi/resource-loader";
import { PiEventMapper } from "@/lib/agent/pi/event-mapper";
import { runPiSubagent, runPiSubagentsParallel } from "@/lib/agent/pi/subagent-runner";
import { fallbackFlatRecap } from "@/lib/agent/conversation-recap";
import { runBudgetForTier } from "@/lib/agent/run-budget";
import { isMockAgentEnabled, runMockAgent } from "@/lib/agent/mock-agent";
import { resolveAgentContextPolicy } from "@/lib/agent/context-policy";
import { createPiSkillTool } from "@/lib/agent/pi/skill-tool";
import { wrapExternalContext } from "@/lib/agent/external-context";

export type PiAgentServiceOptions = {
  /** AR10 harness 可覆盖到临时目录；生产缺省固定为 Finwork app-data。 */
  sessionRoot?: string;
  agentDir?: string;
  hardTimeoutMs?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
};

/**
 * Pi-only Finwork Agent Service.
 *
 * Query/UI/DB 看不到 Pi 类型。Service 发射 turn/message/tool/queue/compaction 事实，
 * 但 run_started/run_ended/run_settled 仍由 Query Pipeline 唯一收口。
 */
export async function runPiAgent(
  request: FinworkAgentRequest,
  serviceOptions: PiAgentServiceOptions = {},
): Promise<FinworkAgentResult> {
  const settings = await readAgentSettings();
  const role = request.roleId ? assertSpecialistRoleUsable(request.roleId) : undefined;
  if (isMockAgentEnabled()) {
    return runMockAgent(request.messages, request);
  }
  const modelId = (request.modelOverride || settings.mainModel || "").trim();
  if (!settings.apiKey.trim() || !modelId) {
    return {
      mode: "mock",
      runtimeSessionId: request.runtimeSessionId ?? null,
      content: "API Key 或主模型未配置，当前无法启动 Pi Agent。请在配置中心填写 API URL、API Key 和模型。",
      roleMode: settings.roleMode,
    };
  }

  const cwd = getProjectRoot();
  const sessionRoot = path.resolve(serviceOptions.sessionRoot ?? getPiSessionDir());
  const agentDir = path.resolve(serviceOptions.agentDir ?? getPiAgentDir());
  mkdirSync(sessionRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const outputDir = path.resolve(
    request.outputDir ?? path.join(sessionRoot, "outputs", request.requestId ?? randomUUID()),
  );
  mkdirSync(outputDir, { recursive: true });

  const systemPrompt = role
    ? buildSpecialistChatSystemPrompt(role, safeRoleMemories(role.id), outputDir)
    : undefined;
  if (!role) await ensureConventionsMigrated().catch(() => undefined);
  const promptContext = role
    ? undefined
    : {
        identity: { companyName: settings.companyName, agentName: settings.agentName },
        memoryMarkdown: await readMemoryMarkdown(),
        roleMode: settings.roleMode,
        recentNegativeFeedback: safeRecentNegativeReasons(),
        outputDir,
        companyProfile: await readCompanyProfile().catch(() => ({})),
      };
  const contextPolicy = role
    ? null
    : resolveAgentContextPolicy({
        messages: request.messages,
        attachments: request.attachments,
        intent: request.intent,
      });

  const { modelRuntime, model } = await createFinworkModelRuntime(settings, modelId);
  const { createAgentSession, SessionManager, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_192 },
    retry: { enabled: false },
  });
  const resourceLoader = await createFinworkPiResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...(systemPrompt
      ? { systemPrompt, skillNames: role?.skills }
      : { promptContext, skillNames: contextPolicy?.skillNames }),
  });
  const sessionManager = request.resumeSession && request.runtimeSessionId
    ? SessionManager.open(
        validatePiSessionLocator(request.runtimeSessionId, sessionRoot),
        sessionRoot,
        cwd,
      )
    : SessionManager.create(cwd, sessionRoot);

  let session: AgentSession | null = null;
  let timedOut = false;
  let externallyAborted = request.signal?.aborted === true;
  const mapper = new PiEventMapper();
  const currentRunMessages: AgentSessionEvent[] = [];
  const emitQuestion = wrapQuestionResolver(request.resolveUserQuestion, request.emit);
  const definitions = buildFinanceToolDefinitions(
    outputDir,
    request.traceId ?? request.requestId,
    request.conversationId != null ? String(request.conversationId) : undefined,
    request.onSubagentEvent,
    {
      subagentExecutor: runPiSubagent,
      subagentParallelExecutor: runPiSubagentsParallel,
      ...(request.taskContract
        ? { finalize: { taskContract: request.taskContract, runId: request.requestId ?? request.traceId ?? "unknown" } }
        : {}),
    },
  );
  const allowed = role
    ? new Set(resolveRoleAllowedTools(role.id))
    : contextPolicy?.toolIds
      ? new Set(contextPolicy.toolIds)
      : null;
  const financeTools = createPiFinanceTools(
    allowed ? definitions.filter((definition) => allowed.has(definition.id)) : definitions,
    createFinanceToolAuthorizer({
      outputDir,
      roleId: role?.id,
      conversationId: request.conversationId,
      resolveUserQuestion: emitQuestion,
      emit: request.emit,
    }),
  );
  const skillTool = createPiSkillTool(resourceLoader);
  const tools = skillTool ? [skillTool, ...financeTools] : financeTools;

  try {
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: serviceOptions.thinkingLevel ?? "off",
      noTools: "builtin",
      customTools: tools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    session.subscribe((event) => {
      currentRunMessages.push(event);
      const mapped = mapper.map(event);
      for (const runtimeEvent of mapped.events) {
        if (!isQueryOwnedLifecycleEvent(runtimeEvent.type)) request.emit?.(runtimeEvent);
      }
    });

    const abortSession = () => {
      externallyAborted = true;
      void session?.abort();
    };
    request.signal?.addEventListener("abort", abortSession, { once: true });
    const hardTimeoutMs =
      serviceOptions.hardTimeoutMs ?? runBudgetForTier(request.executionTier).hardTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      void session?.abort();
    }, hardTimeoutMs);
    try {
      if (!externallyAborted) {
        const prompt = buildPiPrompt(request.messages, request.attachments ?? [], Boolean(request.resumeSession));
        try {
          await session.prompt(prompt.text, { images: prompt.images });
          await session.waitForIdle();
        } catch (error) {
          // Pi 版本可能让 abort() 使 prompt reject，也可能正常 resolve。
          // 两种形态都统一在下方转成 Finwork AbortError/TimeoutError。
          if (!timedOut && !externallyAborted) throw error;
        }
      }
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortSession);
    }

    const accounting = collectPiAccounting(currentRunMessages, modelId);
    if (timedOut || externallyAborted) {
      const error = new Error(timedOut ? "Pi Agent 执行超时" : "Pi Agent 执行已取消");
      error.name = timedOut ? "TimeoutError" : "AbortError";
      (error as { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage =
        accounting.modelUsage;
      throw error;
    }
    const assistantError = lastAssistantError(currentRunMessages);
    if (assistantError) {
      const error = new Error(assistantError);
      (error as { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage =
        accounting.modelUsage;
      throw error;
    }
    return {
      mode: "agent",
      runtimeSessionId: session.sessionFile
        ? validatePiSessionLocator(session.sessionFile, sessionRoot)
        : null,
      content: lastAssistantText(currentRunMessages) || "Pi Agent 已执行，但没有返回文本结果。",
      usage: accounting.usage,
      modelUsage: accounting.modelUsage,
      totalCostUsd: accounting.totalCostUsd,
      numTurns: accounting.numTurns,
      roleMode: settings.roleMode,
      terminationReason: accounting.stopReason,
    };
  } finally {
    session?.dispose();
  }
}

export function validatePiSessionLocator(locator: string, sessionRoot: string): string {
  const root = realpathSync(path.resolve(sessionRoot));
  const candidate = path.resolve(locator);
  if (!existsSync(candidate)) throw new Error("Pi session 不存在或已过期");
  const resolved = realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("拒绝恢复 Finwork 受控目录之外的 Pi session");
  }
  if (path.extname(resolved) !== ".jsonl") throw new Error("Pi session locator 格式无效");
  return resolved;
}

export function buildPiPrompt(
  messages: AgentMessage[],
  attachments: AgentAttachment[],
  resumeSession: boolean,
): { text: string; images: ImageContent[] } {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const current = lastUser?.content ?? messages.at(-1)?.content ?? "";
  const history = resumeSession ? [] : messages.slice(0, Math.max(0, messages.lastIndexOf(lastUser!)));
  const parts = [resumeSession ? current : fallbackFlatRecap(history, current)];
  const local = attachments.filter((attachment) => attachment.storagePath);
  const inlinedLocal = local.flatMap((attachment) => {
    const content = readSmallTextAttachment(attachment);
    return content == null ? [] : [{ attachment, content }];
  });
  for (const { attachment, content } of inlinedLocal) {
    parts.push(
      [
        `用户上传文件 ${attachment.name} 的文本内容已直接提供，无需调用工具读取：`,
        wrapExternalContext(content),
      ].join("\n"),
    );
  }
  const inlinedPaths = new Set(inlinedLocal.map(({ attachment }) => attachment.storagePath));
  const localToRead = local.filter((attachment) => !inlinedPaths.has(attachment.storagePath));
  if (localToRead.length) {
    parts.push(
      "用户上传了以下文件，已保存到本地磁盘：\n" +
        localToRead
          .map(
            (attachment) =>
              `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)\n  路径: ${attachment.storagePath}`,
          )
          .join("\n") +
        "\n请用 read_document 读取 Office、PDF 或图片文件。",
    );
  }
  const inlineText = attachments.filter(
    (attachment) => !attachment.storagePath && attachment.text?.trim(),
  );
  for (const attachment of inlineText) {
    parts.push(
      `<attachment name=${JSON.stringify(attachment.name)}>\n${attachment.text!.slice(0, 60_000)}\n</attachment>`,
    );
  }
  return {
    text: parts.filter(Boolean).join("\n\n"),
    images: attachments.flatMap((attachment) => {
      if (attachment.storagePath || !isPiImage(attachment.mimeType)) return [];
      const data = dataUrlBase64(attachment.dataUrl);
      return data ? [{ type: "image" as const, mimeType: attachment.mimeType, data }] : [];
    }),
  };
}

function readSmallTextAttachment(attachment: AgentAttachment): string | null {
  if (!attachment.storagePath || attachment.size > 60_000) return null;
  const extension = path.extname(attachment.name).toLowerCase();
  const textual =
    attachment.mimeType.startsWith("text/") ||
    [".csv", ".tsv", ".txt", ".md", ".json"].includes(extension);
  if (!textual) return null;
  try {
    return readFileSync(attachment.storagePath, "utf8").slice(0, 60_000);
  } catch {
    return null;
  }
}

function wrapQuestionResolver(
  resolver: ((question: AgentQuestion) => Promise<string>) | undefined,
  emit: FinworkAgentRequest["emit"],
): ((question: AgentQuestion) => Promise<string>) | undefined {
  if (!resolver) return undefined;
  return async (question) => {
    const questionId = randomUUID();
    emit?.({ type: "ask_user", questionId, question });
    const answer = await resolver(question);
    emit?.({ type: "ask_user_answered", questionId, answer });
    return answer;
  };
}

function collectPiAccounting(
  events: AgentSessionEvent[],
  fallbackModel: string,
): {
  usage: FinworkAgentUsage;
  modelUsage: Record<string, AgentModelUsage>;
  totalCostUsd: number;
  numTurns: number;
  stopReason?: string;
} {
  const modelUsage: Record<string, AgentModelUsage> = {};
  let totalCostUsd = 0;
  let numTurns = 0;
  let stopReason: string | undefined;
  for (const event of events) {
    if (event.type === "turn_start") numTurns += 1;
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    const message = event.message;
    const key = message.model || fallbackModel;
    const current = modelUsage[key] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    current.inputTokens += message.usage.input;
    current.outputTokens += message.usage.output;
    current.cacheReadInputTokens += message.usage.cacheRead;
    current.cacheCreationInputTokens += message.usage.cacheWrite;
    modelUsage[key] = current;
    totalCostUsd += message.usage.cost.total;
    stopReason = message.stopReason;
  }
  const total = Object.values(modelUsage).reduce(
    (sum, item) => ({
      inputTokens: sum.inputTokens + item.inputTokens,
      outputTokens: sum.outputTokens + item.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + item.cacheReadInputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + item.cacheCreationInputTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  return { usage: total, modelUsage, totalCostUsd, numTurns, stopReason };
}

function lastAssistantText(events: AgentSessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    return event.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function lastAssistantError(events: AgentSessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    if (event.message.stopReason === "error") {
      return event.message.errorMessage || "Pi Agent 模型调用失败";
    }
  }
  return undefined;
}

function isQueryOwnedLifecycleEvent(type: string): boolean {
  return type === "run_started" || type === "run_ended" || type === "run_settled";
}

function safeRoleMemories(roleId: string): string[] {
  try {
    return getRoleMemoryForPrompt(roleId);
  } catch {
    return [];
  }
}

function safeRecentNegativeReasons(): string[] | undefined {
  try {
    const reasons = listRecentNegativeReasons(7, 5);
    return reasons.length ? reasons : undefined;
  } catch {
    return undefined;
  }
}

function isPiImage(mimeType: string): mimeType is ImageContent["mimeType"] {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

function dataUrlBase64(dataUrl: string): string {
  return dataUrl.split(",", 2)[1] ?? "";
}
