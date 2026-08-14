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
import { readCompanyProfile } from "@/lib/profile/file-store";
import { assertSpecialistRoleUsable } from "@/lib/agent/roles/availability";
import { resolveRoleAllowedTools } from "@/lib/agent/roles/registry";
import {
  buildSpecialistChatSystemPrompt,
  buildSpecialistDynamicSystemContext,
} from "@/lib/agent/subagent-prompts";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { createFinanceToolAuthorizer } from "@/lib/agent/tools/authorize";
import { createPiFinanceTools } from "@/lib/agent/pi/tool-adapter";
import { createFinanceCapabilityRuntime } from "@/lib/agent/tools/capability-runtime";
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
import {
  loadGovernedPromptMemory,
  resolveMemoryRuntimeContext,
} from "@/lib/memory-v2/prompt";
import {
  CapabilityExecutionLedger,
  evaluateExecutionRequirements,
  executionRequirementsForSpreadsheetTask,
  type ExecutionRequirement,
} from "@/lib/capability/execution-gate";

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
  /**
   * 受控评测或业务工作流追加的执行合同。门禁只接受成功的 tool_completed 事实，
   * 不接受模型文字、tool_started 或失败调用代替真实执行。
   */
  executionRequirements?: ExecutionRequirement[];
  /** Force every nested Pi worker onto the same model as the parent (used by isolated Agent evaluation). */
  nestedModelOverride?: string;
};

function mergeExecutionRequirements(
  requirements: readonly ExecutionRequirement[],
): ExecutionRequirement[] {
  const unique = new Map<string, ExecutionRequirement>();
  for (const requirement of requirements) {
    const anyOf = [...new Set(requirement.anyOf.map((item) => item.trim()).filter(Boolean))].sort();
    if (!anyOf.length) continue;
    const normalized = {
      ...requirement,
      id: requirement.id.trim(),
      anyOf,
      minimumCount: Math.max(1, requirement.minimumCount ?? 1),
    };
    const key = `${normalized.id}|${normalized.anyOf.join("|")}|${normalized.minimumCount}`;
    unique.set(key, normalized);
  }
  return [...unique.values()];
}

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
  const modelId = (request.modelOverride || settings.fastModel || "").trim();
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

  // Query pipeline normally injects this contract. Direct runPiAgent callers must
  // get the same completion and governed-memory boundary.
  const taskContract = request.taskContract ?? deriveTaskContractForTurn({
    intent: request.intent,
    attachments: request.attachments,
  });
  const executionRequirements = mergeExecutionRequirements([
    ...executionRequirementsForSpreadsheetTask({
      hasSpreadsheet: taskContract.taskKind !== "text",
      needsWrite: taskContract.spreadsheetRequirement?.needsWrite === true,
      needsValidation: taskContract.requiredDeliverables.length > 0,
    }),
    ...(serviceOptions.executionRequirements ?? []),
  ]);
  const executionLedger = new CapabilityExecutionLedger();
  executionLedger.seed("agent.turn");
  const completionRequired =
    taskContract.requiredDeliverables.length > 0 || executionRequirements.length > 0;
  const memoryContext = resolveMemoryRuntimeContext({
    explicit: request.memoryContext,
    taskContract,
  });
  const governedMemory = await loadGovernedPromptMemory({
    roleId: role?.id,
    context: memoryContext,
  });
  if (governedMemory.status === "degraded") {
    console.warn("[pi-agent] governed memory unavailable; legacy fallback forbidden:", governedMemory.reason);
  }

  // Static role prompt must not freeze request-scoped memory. Governed summaries
  // are injected only through the dynamic external-context section below.
  const systemPrompt = role
    ? buildSpecialistChatSystemPrompt(role, [], outputDir)
    : undefined;
  const roleDynamicSystemContext = role
    ? () => buildSpecialistDynamicSystemContext(
        governedMemory.markdown,
        [],
        outputDir,
      )
    : undefined;
  const promptContext = role
    ? undefined
    : {
        identity: { companyName: settings.companyName, agentName: settings.agentName },
        memoryMarkdown: governedMemory.markdown,
        roleMode: settings.roleMode,
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
  let humanDecisionError: Error | null = null;
  let repairRounds = 0;
  let repairStopReason: FinworkAgentResult["repairStopReason"] =
    completionRequired ? "max_rounds" : "not_required";
  const mapper = new PiEventMapper();
  const currentRunMessages: AgentSessionEvent[] = [];
  const operationAbort = new AbortController();
  let askUserQuestionCount = 0;
  const emitQuestion = wrapQuestionResolver(
    request.resolveUserQuestion,
    (event) => {
      if (event.type === "ask_user") askUserQuestionCount += 1;
      request.emit?.(event);
    },
    (error) => {
      if (!(error instanceof Error) || error.name !== "HumanDecisionRequiredError") return;
      humanDecisionError = error;
      operationAbort.abort(error);
      void abortSessionWithDeadline(session, serviceOptions.abortTimeoutMs ?? 2_000);
    },
  );
  const definitions = buildFinanceToolDefinitions(
    outputDir,
    request.traceId ?? request.requestId,
    request.conversationId != null ? String(request.conversationId) : undefined,
    request.onSubagentEvent,
    {
      subagentExecutor: runPiSubagent,
      subagentParallelExecutor: runPiSubagentsParallel,
      readDocumentAllowedRoots: builtinRoots.readRoots,
      memoryContext,
      foundation: request.foundation,
      modelOverride: serviceOptions.nestedModelOverride,
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
  const enabledDefinitions = allowed
    ? definitions.filter((definition) => allowed.has(definition.id))
    : definitions;
  const financeTools = createPiFinanceTools(
    enabledDefinitions,
    createFinanceToolAuthorizer({
      outputDir,
      roleId: role?.id,
      conversationId: request.conversationId,
      resolveUserQuestion: emitQuestion,
      emit: request.emit,
    }),
    createFinanceCapabilityRuntime(enabledDefinitions, {
      runId: request.foundation?.runId ?? request.requestId ?? request.traceId ?? randomUUID(),
      ...(request.foundation ? { caseId: request.foundation.caseId } : {}),
      ...(request.foundation ? { foundation: request.foundation } : {}),
    }),
  );
  const builtinTools = await createFinworkBuiltinTools(builtinRoots, {
    resolveUserQuestion: emitQuestion,
  });
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
        executionLedger.record(runtimeEvent);
        if (!isQueryOwnedLifecycleEvent(runtimeEvent.type)) request.emit?.(runtimeEvent);
      }
    });

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

            // 模型偶尔会把需要用户决策的问题写进普通回复，导致 UI/Harness 无法
            // 区分“已完成”和“等待输入”。仅做一次协议修复，要求它改用结构化工具。
            if (
              emitQuestion
              && askUserQuestionCount === 0
              && needsStructuredQuestionRepair(lastAssistantText(currentRunMessages))
            ) {
              await awaitAbortable(
                session.prompt([
                  "系统交互协议修复：你刚才在普通回复中请求用户补充信息或作出决定。",
                  "必须立即调用 AskUserQuestion 表达这个阻塞点，不要再次只用普通文字提问。",
                  "问题选项只能来自用户已提供的信息或已检索证据；缺失值不得编造具体日期、主体、金额或其它候选值。",
                  "没有有依据的候选项时，使用自由输入问题或中性选项。",
                ].join("\n")),
                operationAbort.signal,
              );
              await awaitAbortable(session.waitForIdle(), operationAbort.signal);
            }

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
              if (base.outcome !== "completed") {
                return base;
              }
              const executionGate = evaluateExecutionRequirements(
                executionRequirements,
                executionLedger.snapshot(),
              );
              if (!executionGate.ok) {
                return {
                  outcome: "error" as const,
                  qualityStatus: "failed" as const,
                  terminationReason: "validation_failed" as const,
                  gateMessage: executionGate.message,
                  diagnosticFingerprint: executionGate.diagnosticFingerprint,
                };
              }
              if (!serviceOptions.completionVerifier) return base;
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
            while (completionRequired && repairRounds < maxRepairRounds) {
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
                    "请成功调用门禁列出的受控工具并完成实际操作；失败调用不计入，不能只回复说明文字。",
                    ...(taskContract.requiredDeliverables.length > 0
                      ? [
                          "请按上述具体文件、位置和错误修复当前输出目录中的工作文件。",
                          "完成修复后必须再次调用 finalize_deliverable。",
                        ]
                      : []),
                    "如果缺少必要输入或无法安全判断，请明确说明阻塞原因，不要猜测数字。",
                  ].join("\n"),
                ),
                operationAbort.signal,
              );
              await awaitAbortable(session.waitForIdle(), operationAbort.signal);
            }

            const finalGate = completionRequired
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
            repairStopReason = completionRequired
              ? "completed"
              : "not_required";
          } catch (error) {
            // Pi 版本可能让 abort() 使 prompt reject，也可能正常 resolve。
            // 两种形态都统一在下方转成 Finwork AbortError/TimeoutError。
            if (humanDecisionError) {
              (humanDecisionError as Error & { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage =
                collectPiAccounting(currentRunMessages, modelId, pricingKnown).modelUsage;
              throw humanDecisionError;
            }
            if (!timedOut && !externallyAborted) {
              // Validation/minimum-deliverable failures happen after one or more
              // paid provider turns. Preserve that accounting on the thrown
              // error so the persistence layer and benchmark budget cannot
              // mistake a charged failure for a zero-token run.
              if (error && typeof error === "object") {
                (error as { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage =
                  collectPiAccounting(currentRunMessages, modelId, pricingKnown).modelUsage;
              }
              throw error;
            }
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
      const providerError = error as Error & {
        code?: string;
        __modelUsage?: Record<string, AgentModelUsage>;
      };
      providerError.code = "PROVIDER_RESPONSE_ERROR";
      providerError.__modelUsage = accounting.modelUsage;
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
      verificationStatus: completionRequired ? "passed" : "not_applicable",
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
        "**新建空白表格必须调用 `create_workbook`**；不要用 Bash、Python、openpyxl 或 pandas 直接生成或改写 XLSX。现有工作簿只用 `patch_workbook` 做受控增量修改。附件在沙箱中只读，不得覆盖原件。",
        "工作簿内容较多时，把创建或修改请求拆成多次受控工具调用；不要用超长脚本绕过工具合同。",
        taskContract?.spreadsheetRequirement?.needsRecalc ||
        taskContract?.spreadsheetRequirement?.needsRender
          ? "写入 XLSX 后，合同要求的重算与渲染由 `finalize_deliverable` 在沙箱外的受控运行时完成；不要在 Bash 中启动 soffice，也不要手工伪造公式缓存。先执行静态公式、关键输入值、结构和修改范围检查，再调用 finalize_deliverable；只有该工具明确返回 recalc_unavailable 才能报告重算阻塞。"
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

export function wrapQuestionResolver(
  resolver: ((question: AgentQuestion) => Promise<string>) | undefined,
  emit: FinworkAgentRequest["emit"],
  onResolverError?: (error: unknown) => void,
): ((question: AgentQuestion) => Promise<string>) | undefined {
  if (!resolver) return undefined;
  return async (question) => {
    const questionId = randomUUID();
    emit?.({ type: "ask_user", questionId, question });
    try {
      const answer = await resolver(question);
      emit?.({ type: "ask_user_answered", questionId, answer });
      return answer;
    } catch (error) {
      onResolverError?.(error);
      throw error;
    }
  };
}

/**
 * 只捕获明显处于“等待用户输入/决策”状态的普通文本，避免把一般性的建议误改成提问。
 */
export function needsStructuredQuestionRepair(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const requiredDecision = /(?:冲突|权威版本|范围变化|写入前)[\s\S]{0,500}(?:请确认|请选择)|(?:请确认|请选择)[\s\S]{0,160}(?:权威版本|采用哪份|修改原始)/;
  if (requiredDecision.test(normalized)) return true;
  const terminalAnswer = /拒绝|不会执行|不予执行|不得执行|不能(?:输出|披露|发送|删除|标记|导出)|无法(?:据此|宣布|判断)|证据不足|没有足够证据|不可信/.test(normalized);
  if (terminalAnswer) return false;
  if (/请明确确认|在[^。！？!?\n]{0,24}前[^。！？!?\n]{0,12}请确认/.test(normalized)) {
    return true;
  }
  if (/(?:^|[。！？!?\n])\s*(?:请补充|请提供|请选择|请确认|请明确)/m.test(normalized)) {
    return true;
  }
  const blocked = /不会|无法|不能|暂不|待[^。！？!?\n]{0,20}确认|如需|若要/.test(normalized);
  const decision = /确认|选择|提供|补充|明确|解除[^。！？!?\n]{0,8}(?:约束|限制)/.test(normalized);
  return blocked && decision;
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

function isPiImage(mimeType: string): mimeType is ImageContent["mimeType"] {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

function dataUrlBase64(dataUrl: string): string {
  return dataUrl.split(",", 2)[1] ?? "";
}
