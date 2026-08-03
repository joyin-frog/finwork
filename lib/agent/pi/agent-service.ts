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
import {
  buildSpecialistChatSystemPrompt,
  buildSpecialistDynamicSystemContext,
} from "@/lib/agent/subagent-prompts";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { createFinanceToolAuthorizer } from "@/lib/agent/tools/authorize";
import { createPiFinanceTools } from "@/lib/agent/pi/tool-adapter";
import { createFinworkModelRuntime } from "@/lib/agent/pi/provider";
import { createFinworkPiResourceLoader, resolveFinworkSkillRoots } from "@/lib/agent/pi/resource-loader";
import { PiEventMapper } from "@/lib/agent/pi/event-mapper";
import { runPiSubagent, runPiSubagentsParallel } from "@/lib/agent/pi/subagent-runner";
import { buildReplayMessages } from "@/lib/agent/pi/history-replay";
import { registerLiveSession, type LiveSessionHandle } from "@/lib/agent/pi/live-sessions";
import { createCompactionSummarizer } from "@/lib/agent/pi/compaction-summarizer";
import { runBudgetForTier } from "@/lib/agent/run-budget";
import { isMockAgentEnabled, runMockAgent } from "@/lib/agent/mock-agent";
import { resolveAgentContextPolicy } from "@/lib/agent/context-policy";
import {
  createFinworkBuiltinTools,
  type FinworkBuiltinRoots,
} from "@/lib/agent/pi/builtin-tools";
import { createFinworkExtension } from "@/lib/agent/pi/extension";
import { wrapExternalContext } from "@/lib/agent/external-context";
import { buildDynamicSystemContext } from "@/lib/agent/system-prompt";
import { decideSettleFromCompletionGate } from "@/lib/agent/completion-gate-settle";
import { deriveTaskContractForTurn } from "@/lib/agent/run-contract";

export type PiAgentServiceOptions = {
  /** AR10 harness 可覆盖到临时目录；生产缺省固定为 Finwork app-data。 */
  sessionRoot?: string;
  agentDir?: string;
  hardTimeoutMs?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /** 验证失败后最多让 Pi 自动修复的回合数。 */
  maxRepairRounds?: number;
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

  const roleMemories = role ? safeRoleMemories(role.id) : [];
  const systemPrompt = role
    ? buildSpecialistChatSystemPrompt(role, roleMemories, outputDir)
    : undefined;
  const memoryMarkdown = await readMemoryMarkdown();
  if (!role) await ensureConventionsMigrated().catch(() => undefined);
  const roleDynamicSystemContext = role
    ? () => buildSpecialistDynamicSystemContext(memoryMarkdown, roleMemories, outputDir)
    : undefined;
  const promptContext = role
    ? undefined
    : {
        identity: { companyName: settings.companyName, agentName: settings.agentName },
        memoryMarkdown,
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

  // Query pipeline 会预先注入合同；直接调用 runPiAgent（评测、CLI、测试）也必须有同样的
  // 完成语义，否则模型可以在生成工作文件后直接 stop，绕过质量门。
  const taskContract = request.taskContract ?? deriveTaskContractForTurn({
    intent: request.intent,
    attachments: request.attachments,
  });

  const { modelRuntime, model, pricingKnown } = await createFinworkModelRuntime(settings, modelId);
  const { createAgentSession, SessionManager, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_192 },
    retry: { enabled: false },
  });
  // L1：内置工具按会话目录构造（相对路径不能逃逸），extension 的 tool_call 再兜绝对路径与 bash。
  // L4：技能根只读放行，让 SKILL.md 引用的 references/scripts 真的读得到。
  const skillRoots = await resolveFinworkSkillRoots().catch(() => []);
  const builtinRoots: FinworkBuiltinRoots = {
    writeRoot: outputDir,
    readRoot: path.dirname(outputDir),
    // 附件可能位于会话目录之外（历史评测就是这种布局）。只加入附件所在目录的
    // 只读权限；写权限仍严格限制在本回合 outputDir。
    readRoots: [...new Set(
      (request.attachments ?? [])
        .map((attachment) => attachment.storagePath)
        .filter((storagePath): storagePath is string => Boolean(storagePath))
        .map((storagePath) => path.dirname(path.resolve(storagePath)))
        .filter((root) => root !== path.dirname(outputDir)),
    )],
    skillRoots,
  };
  // 恢复判定要在装扩展之前算：L3b 的历史回放只在「没有可恢复 session」时才注入。
  const resumable = request.resumeSession && request.runtimeSessionId
    ? resolveResumableSession(request.runtimeSessionId, sessionRoot)
    : null;
  // 会话文件已不在（保留期清理、app-data 迁移、历史遗留的假 locator）时按新会话继续，
  // 因此本轮要把 Finwork 侧的历史回放进去。
  const resumedSession = Boolean(resumable);
  const replayHistory = resumedSession
    ? []
    : buildReplayMessages(historyBeforeCurrent(request.messages));

  const resourceLoader = await createFinworkPiResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      createFinworkExtension({
        roots: builtinRoots,
        emit: request.emit,
        traceId: request.traceId ?? request.requestId,
        // 角色会话用完整自定义提示词，没有动态段（与改动前一致）。
        ...(roleDynamicSystemContext
          ? { dynamicSystemContext: roleDynamicSystemContext }
          : promptContext
            ? { dynamicSystemContext: () => buildDynamicSystemContext(promptContext) }
            : {}),
        ...(replayHistory.length ? { replayHistory } : {}),
        // L8：叙述由模型生成，关键事实由规则提取；生成失败自动回落 pi 自带摘要。
        summarizeForCompaction: createCompactionSummarizer(settings, modelId),
      }),
    ],
    ...(systemPrompt
      ? { systemPrompt, skillNames: role?.skills }
      : { promptContext, skillNames: contextPolicy?.skillNames }),
  });
  const sessionManager = resumable
    ? SessionManager.open(resumable, sessionRoot, cwd)
    : SessionManager.create(cwd, sessionRoot);

  let session: AgentSession | null = null;
  let liveHandle: LiveSessionHandle | null = null;
  let timedOut = false;
  let externallyAborted = request.signal?.aborted === true;
  let repairRounds = 0;
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
      ...(taskContract
        ? { finalize: { taskContract, runId: request.requestId ?? request.traceId ?? "unknown" } }
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
  const builtinTools = await createFinworkBuiltinTools(builtinRoots);
  const tools = [
    ...builtinTools,
    ...financeTools,
  ];

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
    // L6a：登记在途 session，让「运行中插话」有落点（steer/followUp）。
    // 回合结束即注销——表里只放正在跑的会话。
    liveHandle = registerLiveSession(
      request.conversationId,
      session,
      request.traceId ?? request.requestId ?? "unknown",
    );
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
          const prompt = buildPiPrompt(request.messages, request.attachments ?? []);
          try {
            await session.prompt(prompt.text, { images: prompt.images });
            await session.waitForIdle();

            // Harness completion loop：Pi 的 stop 只代表模型结束了一轮，不代表财务任务完成。
            // finalize_deliverable 内部负责确定性文件验证并提交 CompletionEvidence；这里负责
            // 在没有通过证据时把验证结果反馈给同一个 session，驱动有限次修复。
            const runId = request.requestId ?? request.traceId ?? "unknown";
            const maxRepairRounds = Math.max(0, Math.min(5, serviceOptions.maxRepairRounds ?? 2));
            while (taskContract.requiredDeliverables.length > 0 && repairRounds < maxRepairRounds) {
              const gate = decideSettleFromCompletionGate(runId, taskContract);
              if (gate.outcome === "completed") break;
              repairRounds += 1;
              await session.prompt(
                [
                  `系统验证发现本次任务尚未完成（第 ${repairRounds}/${maxRepairRounds} 次修复）。`,
                  gate.gateMessage,
                  "请检查当前输出目录中的工作文件，补齐或修复交付物。",
                  "完成修复后必须再次调用 finalize_deliverable；不要只回复说明文字。",
                  "如果缺少必要输入或无法安全判断，请明确说明阻塞原因，不要猜测数字。",
                ].join("\n"),
              );
              await session.waitForIdle();
            }

            const finalGate = taskContract.requiredDeliverables.length
              ? decideSettleFromCompletionGate(runId, taskContract)
              : { outcome: "completed" as const, qualityStatus: "not_applicable" as const };
            if (finalGate.outcome !== "completed") {
              const error = new Error(finalGate.gateMessage);
              error.name = "ValidationError";
              (error as Error & { __repairRounds?: number; __verificationStatus?: string; __terminationReason?: string }).__repairRounds = repairRounds;
              (error as Error & { __repairRounds?: number; __verificationStatus?: string; __terminationReason?: string }).__verificationStatus = "failed";
              (error as Error & { __repairRounds?: number; __verificationStatus?: string; __terminationReason?: string }).__terminationReason = "validation_failed";
              throw error;
            }
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

    const accounting = collectPiAccounting(currentRunMessages, modelId, pricingKnown);
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
      repairRounds,
      verificationStatus: taskContract.requiredDeliverables.length ? "passed" : "not_applicable",
    };
  } finally {
    liveHandle?.release();
    session?.dispose();
  }
}

/**
 * 恢复用的 locator 解析：把「可用性」和「安全」分开。
 *
 * 会话文件不在了是正常损耗（保留期清理、app-data 迁移、历史遗留的自铸 locator），
 * 返回 null 让调用方起新会话；而受控目录之外的路径仍必须硬失败。
 */
export function resolveResumableSession(locator: string, sessionRoot: string): string | null {
  if (!existsSync(path.resolve(locator))) return null;
  return validatePiSessionLocator(locator, sessionRoot);
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

/** 当前用户消息之前的全部历史（用于 L3b 回放）。 */
export function historyBeforeCurrent(messages: AgentMessage[]): AgentMessage[] {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return [];
  return messages.slice(0, Math.max(0, messages.lastIndexOf(lastUser)));
}

/**
 * 提示词只承载**当前**这条用户消息与附件。
 *
 * L3b 之前这里会在新 session 首轮把历史压成 `<对话回顾>…` 前置进来；那条通道可被
 * 消息内容伪造边界，也丢掉了角色归属。历史现在经 extension 的 `context` 钩子作为
 * 真消息注入，见 `history-replay.ts`。
 */
export function buildPiPrompt(
  messages: AgentMessage[],
  attachments: AgentAttachment[],
): { text: string; images: ImageContent[] } {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const current = lastUser?.content ?? messages.at(-1)?.content ?? "";
  const parts = [current];
  const hasSpreadsheet = attachments.some(
    (attachment) =>
      /\.(xlsx|xlsm|xls|csv|tsv)$/i.test(attachment.name) ||
      /spreadsheet|excel|csv/i.test(attachment.mimeType),
  );
  if (hasSpreadsheet) {
    parts.push(
      [
        "这是 Excel/表格任务。请先用 read 加载可用的 xlsx Skill 的 SKILL.md，并遵循其中的读写、公式和验证流程。",
        "如果用户要求生成或修改表格，可以使用受限 bash 调用 Python/openpyxl/pandas 等本地工具；先把输入复制到本次会话输出目录，再修改副本。不要执行 find /、find ~ 或全盘搜索，直接使用提示词提供的附件路径。",
        "完成后必须检查输出文件，并调用 finalize_deliverable 正式交付。",
      ].join("\n"),
    );
  }
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
  pricingKnown: boolean,
): {
  usage: FinworkAgentUsage;
  modelUsage: Record<string, AgentModelUsage>;
  /** undefined = 费率未声明，成本不可知。**不要退化成 0**——那等于宣称本次运行免费。 */
  totalCostUsd: number | undefined;
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
  return {
    usage: total,
    modelUsage,
    totalCostUsd: pricingKnown ? totalCostUsd : undefined,
    numTurns,
    stopReason,
  };
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
