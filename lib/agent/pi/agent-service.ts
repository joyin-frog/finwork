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
import {
  getBundledPluginRoot,
  getPiAgentDir,
  getPiSessionDir,
  getProjectRoot,
} from "@/lib/runtime/paths";
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
import {
  deriveTaskContractForTurn,
  type TaskContract,
} from "@/lib/agent/run-contract";

export type PiAgentServiceOptions = {
  /** AR10 harness 可覆盖到临时目录；生产缺省固定为 Finwork app-data。 */
  sessionRoot?: string;
  agentDir?: string;
  hardTimeoutMs?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /** 验证失败后最多让 Pi 自动修复的回合数。 */
  maxRepairRounds?: number;
  /** 任务级确定性验证的独立预算，避免 finalize 后卡在 verifier。 */
  verificationTimeoutMs?: number;
  /**
   * 调用方可追加任务级确定性验证（历史评测、受控业务工作流）。
   * 通用 CompletionGate 仍负责文件存在性、类型、可打开性与不可变交付。
   */
  completionVerifier?: (input: {
    runId: string;
    taskContract: TaskContract;
  }) => Promise<{
    ok: boolean;
    message?: string;
    fingerprint?: string;
  }>;
  /** Repair 前的最小可交付文件检查；没有候选文件时不得进入长 repair loop。 */
  minimumDeliverableCheck?: () => {
    ok: boolean;
    message?: string;
  };
  /** abort() 可能等待 SDK 的 waitForIdle；为清理设置独立上限。 */
  abortTimeoutMs?: number;
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
  let repairStopReason: FinworkAgentResult["repairStopReason"] =
    taskContract.requiredDeliverables.length ? "max_rounds" : "not_required";
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
      readDocumentAllowedRoots: builtinRoots.readRoots,
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

    const operationAbort = new AbortController();
    const abortSession = () => {
      externallyAborted = true;
      operationAbort.abort();
      void abortSessionWithDeadline(session, serviceOptions.abortTimeoutMs ?? 2_000);
    };
    request.signal?.addEventListener("abort", abortSession, { once: true });
    const hardTimeoutMs =
      serviceOptions.hardTimeoutMs ?? runBudgetForTier(request.executionTier).hardTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      operationAbort.abort();
      void abortSessionWithDeadline(session, serviceOptions.abortTimeoutMs ?? 2_000);
    }, hardTimeoutMs);
    try {
      if (!externallyAborted) {
          const prompt = buildPiPrompt(
            request.messages,
            request.attachments ?? [],
            taskContract,
          );
          try {
            await awaitAbortable(
              session.prompt(prompt.text, { images: prompt.images }),
              operationAbort.signal,
            );
            await awaitAbortable(session.waitForIdle(), operationAbort.signal);

            // 先确保最小可交付文件存在，再允许系统验证失败驱动 repair。
            // 没有文件时继续读资料/调用工具只会放大超时，且没有可评分证据。
            const minimumDeliverableCheck = serviceOptions.minimumDeliverableCheck;
            const minimumCheck = minimumDeliverableCheck?.();
            if (minimumCheck && !minimumCheck.ok) {
              await awaitAbortable(
                session.prompt([
                  "系统硬门槛：当前还没有检测到可交付文件。",
                  minimumCheck.message ?? "请先在当前输出目录生成至少一个真实、可打开且符合合同类型的最小文件。",
                  "不要继续长时间分析；生成后立即调用 finalize_deliverable。",
                ].join("\n")),
                operationAbort.signal,
              );
              await awaitAbortable(session.waitForIdle(), operationAbort.signal);
              const afterMinimumCheck = minimumDeliverableCheck!();
              if (!afterMinimumCheck.ok) {
                const error = new Error(
                  afterMinimumCheck.message ?? "未生成最小可交付文件，停止自动修复。",
                );
                error.name = "MinimumDeliverableError";
                (error as Error & { __terminationReason?: string }).__terminationReason =
                  "minimum_deliverable_missing";
                throw error;
              }
            }

            // Harness completion loop：Pi 的 stop 只代表模型结束了一轮，不代表财务任务完成。
            // finalize_deliverable 内部负责确定性文件验证并提交 CompletionEvidence；这里负责
            // 在没有通过证据时把验证结果反馈给同一个 session，驱动有限次修复。
            const runId = request.requestId ?? request.traceId ?? "unknown";
            const maxRepairRounds = Math.max(0, Math.min(5, serviceOptions.maxRepairRounds ?? 2));
            const completionDecision = async () => {
              const base = decideSettleFromCompletionGate(runId, taskContract);
              if (base.outcome !== "completed" || !serviceOptions.completionVerifier) {
                return base;
              }
              const verificationTimeoutMs = serviceOptions.verificationTimeoutMs ?? 60_000;
              const taskVerification = await withTimeout(
                serviceOptions.completionVerifier({ runId, taskContract }),
                verificationTimeoutMs,
                {
                  ok: false,
                  message: `任务级验证超过 ${verificationTimeoutMs}ms，已停止等待。`,
                  fingerprint: "task-verification-timeout",
                },
              );
              if (taskVerification.ok) return base;
              return {
                outcome: "error" as const,
                qualityStatus: "failed" as const,
                terminationReason: "validation_failed" as const,
                gateMessage:
                  taskVerification.message?.trim() ||
                  "任务级确定性断言未通过",
                diagnosticFingerprint:
                  taskVerification.fingerprint?.trim() ||
                  "task-verification-failed",
              };
            };
            let previousFingerprint: string | undefined;
            while (taskContract.requiredDeliverables.length > 0 && repairRounds < maxRepairRounds) {
              const gate = await completionDecision();
              if (gate.outcome === "completed") {
                repairStopReason = "completed";
                break;
              }
              if (
                previousFingerprint &&
                gate.diagnosticFingerprint === previousFingerprint
              ) {
                repairStopReason = "no_progress";
                break;
              }
              previousFingerprint = gate.diagnosticFingerprint;
              repairRounds += 1;
              await awaitAbortable(
                session.prompt(
                  [
                    `系统验证发现本次任务尚未完成（第 ${repairRounds}/${maxRepairRounds} 次修复）。`,
                    gate.gateMessage,
                    "请按上述具体文件、位置和错误修复当前输出目录中的工作文件。",
                    "完成修复后必须再次调用 finalize_deliverable；不要只回复说明文字。",
                    "如果缺少必要输入或无法安全判断，请明确说明阻塞原因，不要猜测数字。",
                  ].join("\n"),
                ),
                operationAbort.signal,
              );
              await awaitAbortable(session.waitForIdle(), operationAbort.signal);
            }

            const finalGate = taskContract.requiredDeliverables.length
              ? await completionDecision()
              : { outcome: "completed" as const, qualityStatus: "not_applicable" as const };
            if (finalGate.outcome !== "completed") {
              const stopNote = repairStopReason === "no_progress"
                ? "\n自动修复已停止：连续两次验证指纹相同，未检测到文件或错误变化。"
                : repairRounds >= maxRepairRounds
                  ? `\n自动修复已停止：达到 ${maxRepairRounds} 轮上限。`
                  : "";
              const error = new Error(finalGate.gateMessage + stopNote);
              error.name = "ValidationError";
              const meta = error as Error & {
                __repairRounds?: number;
                __repairStopReason?: FinworkAgentResult["repairStopReason"];
                __verificationStatus?: string;
                __terminationReason?: string;
              };
              meta.__repairRounds = repairRounds;
              meta.__repairStopReason = repairStopReason;
              meta.__verificationStatus = "failed";
              meta.__terminationReason = "validation_failed";
              throw error;
            }
            repairStopReason = taskContract.requiredDeliverables.length
              ? "completed"
              : "not_required";
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
      repairStopReason,
      verificationStatus: taskContract.requiredDeliverables.length ? "passed" : "not_applicable",
    };
  } finally {
    liveHandle?.release();
    await disposeSessionWithDeadline(session, serviceOptions.abortTimeoutMs ?? 2_000);
  }
}

async function abortSessionWithDeadline(
  session: AgentSession | null,
  timeoutMs: number,
): Promise<void> {
  if (!session) return;
  try {
    await Promise.race([session.abort(), delay(timeoutMs)]);
  } catch {
    // 清理必须继续执行；SDK abort 的异常不能遮蔽原始 timeout/error。
  }
}

async function disposeSessionWithDeadline(
  session: AgentSession | null,
  timeoutMs: number,
): Promise<void> {
  if (!session) return;
  await abortSessionWithDeadline(session, timeoutMs);
  try {
    session.dispose();
  } catch {
    // dispose 是最后一道清理，不能覆盖原始任务结果。
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Agent operation aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Agent operation aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
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
  taskContract?: TaskContract | null,
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
    const xlsxSkillPath = path.join(
      getBundledPluginRoot(),
      "skills",
      "xlsx",
      "SKILL.md",
    );
    parts.push(
      [
        `这是 Excel/表格任务。请先用 read 加载 xlsx Skill：${xlsxSkillPath}，并遵循其中的读写、公式和验证流程。`,
        // 这里曾写着「用 openpyxl 从附件加载后保存为新文件」——那是一次有损往返:
        // openpyxl 的 load→save 会清空整册公式缓存值(实测 2639 → 2)。模板型任务
        // 的三张报表全由公式驱动,缓存一没就全部读不出数,模型随后会写十几个脚本
        // 反复排查,直到超时(HISTORY-002 实测 27 个脚本、40 分钟、0 交付)。
        "**改动用户上传的表格（含填写模板、工作底稿）必须用 `patch_workbook` 工具，不得用 openpyxl/pandas 打开再保存。** 后者会清空整册公式的缓存值，模板里既有的公式将全部读不出结果，且含外部链接的数据无法恢复。`patch_workbook` 只重写你点名的单元格，其余原样保留，并会自动为新写入的公式补算结果。",
        "附件里若提供了模板或工作底稿，**填它，不要另起炉灶重建一张同名表**：模板自带的公式就是计算逻辑，重建等于把它们全丢掉。",
        "只有**新建空白表格**才用受限 bash 调用 Python/openpyxl/pandas；bash 当前目录就是本次会话输出目录，使用相对目标路径。不要执行 find /、find ~ 或全盘搜索，直接使用提示词提供的附件绝对路径读取。附件在沙箱中只读：确需复制文件时使用 shutil.copyfile 并把输出 chmod 为 0o600，不要用 shutil.copy/copy2（会把沙箱只读权限一并带过去）。",
        "生成脚本较长时，先用 write 创建短骨架，再用多次 edit 分段补充；不要把整个大脚本塞进一次 write，以免模型输出上限截断工具参数。",
        taskContract?.spreadsheetRequirement?.needsRecalc ||
        taskContract?.spreadsheetRequirement?.needsRender
          ? "写入 XLSX 不依赖 LibreOffice：先用 openpyxl/pandas 正常保存候选文件。合同要求的 LibreOffice 重算/渲染由 finalize_deliverable 在沙箱外的受控运行时自动完成；不要在 bash 中自行启动 soffice，也不要手工模拟整套 Excel 公式缓存。你仍需先做静态公式、关键输入值、结构和修改范围检查，然后立即调用 finalize_deliverable；只有该工具明确返回 recalc_unavailable 才能报告重算阻塞。"
          : "",
        "完成后必须检查输出文件，并调用 finalize_deliverable 正式交付。",
      ].filter(Boolean).join("\n"),
    );
  }
  const needsDocx =
    attachments.some(
      (attachment) =>
        attachment.name.toLowerCase().endsWith(".docx") ||
        attachment.mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) ||
    taskContract?.requiredDeliverables.some(
      (deliverable) =>
        deliverable.mime ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  if (needsDocx) {
    const docxSkillPath = path.join(
      getBundledPluginRoot(),
      "skills",
      "docx",
      "SKILL.md",
    );
    parts.push(
      [
        `这是 Word/DOCX 任务。请先用 read 加载 docx Skill：${docxSkillPath}，并遵循其中的读取、编辑、验证和渲染流程。`,
        "只修改本次会话输出目录中的副本，不要覆盖用户上传的原始文档。",
        "产品 Python Runtime 已预装 python-docx；优先用它生成 DOCX。不要运行 npm install/pip install，也不要因为全局 docx-js 不存在而停止。",
        "正文或生成脚本较长时，先用 write 创建短骨架，再用多次 edit 分段补充，避免单个超长工具调用因模型输出上限被截断。",
      ].join("\n"),
    );
  }
  if (taskContract?.requiredDeliverables.length) {
    parts.push(
      [
        "本任务的交付合同由系统冻结，不能用说明文字代替文件：",
        ...taskContract.requiredDeliverables.map(
          (deliverable) =>
            `- contractDeliverableId=${deliverable.id}; MIME=${deliverable.mime}; 数量=${deliverable.count}; qualityProfile=${deliverable.qualityProfile}`,
        ),
        "请按上述 ID 生成最终文件，并在最后一次调用 finalize_deliverable 时逐一声明。",
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

export function lastAssistantError(events: AgentSessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    // 只看最后一条 assistant 结束态。repair 之前的 transient error 已被后续
    // 成功 stop/finalize 覆盖，不能在 Run settle 时重新翻出来误判整个任务失败。
    return event.message.stopReason === "error"
      ? event.message.errorMessage || "Pi Agent 模型调用失败"
      : undefined;
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
