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
  getRunFileWorkspaceDir,
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
  hasSuccessfulArtifactWrite,
  type ExecutionFact,
  type ExecutionRequirement,
} from "@/lib/capability/execution-gate";
import { getDb } from "@/lib/db/sqlite";
import { workPlanPrompt } from "@/lib/task/work-plan";
import { classifyTransientProviderError } from "@/lib/evaluation/transient-provider-retry";

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
    userMessage: [...request.messages].reverse().find((message) => message.role === "user")?.content,
  });
  const executionRequirements = mergeExecutionRequirements([
    ...executionRequirementsForSpreadsheetTask({
      hasSpreadsheet: taskContract.taskKind !== "text",
      needsWrite: taskContract.spreadsheetRequirement?.needsWrite === true,
      needsValidation: taskContract.requiredDeliverables.length > 0,
    }),
    ...(serviceOptions.executionRequirements ?? []),
  ]);
  const needsWorkspaceChangeReview =
    taskContract.spreadsheetRequirement?.needsWrite === true
    && (request.attachments ?? []).some((attachment) =>
      Boolean(attachment.assetId) && (/\.(xlsx|xlsm|xls|csv|tsv)$/i.test(attachment.name) || /spreadsheet|excel|csv/i.test(attachment.mimeType)),
    );
  const executionLedger = new CapabilityExecutionLedger();
  executionLedger.seed("agent.turn");
  const contractCompletionRequired =
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
    readRoots: [...new Set([
      path.join(getRunFileWorkspaceDir(request.traceId ?? request.requestId ?? "broker"), "inputs"),
      ...(request.attachments ?? [])
        .map((attachment) => attachment.storagePath)
        .filter((storagePath): storagePath is string => Boolean(storagePath))
        .map((storagePath) => path.dirname(path.resolve(storagePath)))
        .filter((root) => root !== path.dirname(outputDir)),
    ])],
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
    contractCompletionRequired ? "max_rounds" : "not_required";
  let suppressProtocolRepairText = false;
  let protocolRepairFallbackContent: string | undefined;
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
      workspaceRootIds: request.workspaceRootIds,
      workspaceAssetIds: (request.attachments ?? []).flatMap((attachment) => attachment.assetId ? [attachment.assetId] : []),
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
        if (
          suppressProtocolRepairText &&
          runtimeEvent.type === "message_delta" &&
          runtimeEvent.channel === "text"
        ) {
          continue;
        }
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
            request.workspaceRootIds,
            request.workPlan,
          );
          try {
            const runProviderTurn = async (text: string, images?: ImageContent[]) => {
              await awaitAbortable(
                session!.prompt(text, images ? { images } : undefined),
                operationAbort.signal,
              );
              await awaitAbortable(session!.waitForIdle(), operationAbort.signal);
              throwIfLastAssistantProviderError(currentRunMessages, modelId, pricingKnown);
            };
            try {
              await runProviderTurn(prompt.text, prompt.images);
            } catch (error) {
              if (!canContinueReadOnlyTurnAfterProviderFailure(error, executionLedger.snapshot(), taskContract)) {
                throw error;
              }
              await runProviderTurn([
                "系统恢复：上一轮模型响应因临时传输故障中断。",
                "当前任务是只读且幂等的；已成功完成的工具结果仍在本会话中。",
                "请直接基于现有结果继续未完成的分析，不要重复已成功的只读工具调用；只有证据确实不足时才补充读取。",
                "完成后给出完整最终答复。",
              ].join("\n"));
            }

            // 模型偶尔会把需要用户决策的问题写进普通回复，导致 UI/Harness 无法
            // 区分“已完成”和“等待输入”。仅做一次协议修复，要求它改用结构化工具。
            if (
              emitQuestion
              && askUserQuestionCount === 0
              && needsStructuredQuestionRepair(lastAssistantText(currentRunMessages))
            ) {
              const repairDraft = lastAssistantText(currentRunMessages);
              suppressProtocolRepairText = true;
              try {
                await awaitAbortable(
                  session.prompt([
                    "系统交互协议修复：你刚才在普通回复中请求用户补充信息或作出决定。",
                    "只有该输入是完成当前任务不可缺少的阻塞项时，才调用 AskUserQuestion。",
                    "若只是已完成任务后的可选延伸服务，不要调用工具，也不要输出任何协议判断或内部规则说明。",
                    "确认是阻塞项时，必须立即调用 AskUserQuestion，不要再次只用普通文字提问。",
                    "问题选项只能来自用户已提供的信息或已检索证据；缺失值不得编造具体日期、主体、金额或其它候选值。",
                    "没有有依据的候选项时，使用自由输入问题或中性选项。",
                  ].join("\n")),
                  operationAbort.signal,
                );
                await awaitAbortable(session.waitForIdle(), operationAbort.signal);
                throwIfLastAssistantProviderError(currentRunMessages, modelId, pricingKnown);
              } finally {
                suppressProtocolRepairText = false;
              }
              if (askUserQuestionCount === 0) {
                protocolRepairFallbackContent = repairDraft;
              }
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
              throwIfLastAssistantProviderError(currentRunMessages, modelId, pricingKnown);
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
            const artifactWriteObserved = () => hasSuccessfulArtifactWrite(executionLedger.snapshot());
            const runtimeCompletionRequired = () =>
              contractCompletionRequired || artifactWriteObserved();
            const completionDecision = async () => {
              // 独立保险：模型一旦成功写出文件，本回合就不再是“纯文本”。如果
              // TaskContract 没声明交付物，禁止用 not_applicable 绕过 finalize。
              // 正常路径应由会话承接逻辑在模型运行前冻结正确合同；这里 fail closed。
              if (artifactWriteObserved() && taskContract.requiredDeliverables.length === 0) {
                return {
                  outcome: "error" as const,
                  qualityStatus: "failed" as const,
                  terminationReason: "validation_failed" as const,
                  gateMessage: "检测到文件写入，但当前 TaskContract 未声明交付物；已拒绝把未验证文件标记为完成。",
                  diagnosticFingerprint: "artifact-write-without-delivery-contract",
                };
              }
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
              if (needsWorkspaceChangeReview && !hasCompletedWorkspaceChangeReview(runId)) {
                return {
                  outcome: "error" as const,
                  qualityStatus: "failed" as const,
                  terminationReason: "validation_failed" as const,
                  gateMessage: "受管表格写入尚未形成完整的后端变更证据。请先用 begin_workspace_change 冻结格子级目标，再对最终候选调用 review_workspace_change(planId=冻结计划, final=true)，并根据 pendingTargets 继续修正。",
                  diagnosticFingerprint: "workspace-change-review-missing",
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
            const undeclaredArtifactWrite = () =>
              artifactWriteObserved() && taskContract.requiredDeliverables.length === 0;
            if (undeclaredArtifactWrite()) repairStopReason = "no_progress";
            while (
              runtimeCompletionRequired()
              && !undeclaredArtifactWrite()
              && repairRounds < maxRepairRounds
            ) {
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
                    ...(taskContract.requiredDeliverables.length > 0 || artifactWriteObserved()
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
              throwIfLastAssistantProviderError(currentRunMessages, modelId, pricingKnown);
            }

            const finalCompletionRequired = runtimeCompletionRequired();
            const finalGate = finalCompletionRequired
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
            repairStopReason = finalCompletionRequired
              ? "completed"
              : "not_required";
          } catch (error) {
            // Pi 版本可能让 abort() 使 prompt reject，也可能正常 resolve。
            // 两种形态都统一在下方转成 Finwork AbortError/TimeoutError。
            if (humanDecisionError) {
              attachPiAccounting(humanDecisionError, currentRunMessages, modelId, pricingKnown);
              throw humanDecisionError;
            }
            if (!timedOut && !externallyAborted) {
              // Validation/minimum-deliverable failures happen after one or more
              // paid provider turns. Preserve that accounting on the thrown
              // error so the persistence layer and benchmark budget cannot
              // mistake a charged failure for a zero-token run.
              if (error && typeof error === "object") {
                attachPiAccounting(error, currentRunMessages, modelId, pricingKnown);
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
      attachPiAccounting(error, currentRunMessages, modelId, pricingKnown, accounting);
      throw error;
    }
    throwIfLastAssistantProviderError(currentRunMessages, modelId, pricingKnown);
    return {
      mode: "agent",
      runtimeSessionId: session.sessionFile
        ? validatePiSessionLocator(session.sessionFile, sessionRoot)
        : null,
      content: protocolRepairFallbackContent || lastAssistantText(currentRunMessages) || "Pi Agent 已执行，但没有返回文本结果。",
      usage: accounting.usage,
      modelUsage: accounting.modelUsage,
      totalCostUsd: accounting.totalCostUsd,
      numTurns: accounting.numTurns,
      roleMode: settings.roleMode,
      terminationReason: accounting.stopReason,
      repairRounds,
      repairStopReason,
      verificationStatus:
        contractCompletionRequired || hasSuccessfulArtifactWrite(executionLedger.snapshot())
          ? "passed"
          : "not_applicable",
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

function hasCompletedWorkspaceChangeReview(runId: string): boolean {
  try {
    const rows = getDb().prepare(`
      SELECT validation_json FROM file_changesets
      WHERE run_id=? AND status IN ('pending','approved','applied')
      ORDER BY created_at DESC
    `).all(runId) as Array<{ validation_json: string }>;
    return rows.some((row) => {
      try {
        const value = JSON.parse(row.validation_json) as { complete?: unknown; planId?: unknown };
        return value.complete === true && typeof value.planId === "string" && /^[0-9a-f-]{36}$/i.test(value.planId);
      }
      catch { return false; }
    });
  } catch {
    return false;
  }
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
  workspaceRootIds: string[] = [],
  workPlan?: FinworkAgentRequest["workPlan"],
): { text: string; images: ImageContent[] } {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const current = lastUser?.content ?? messages.at(-1)?.content ?? "";
  const parts = [current];
  if (workPlan) {
    parts.push(
      workPlanPrompt(workPlan),
      "任务进度由结构化 WorkPlan 和工具事件展示。不要在工具调用之间输出‘开始读取’‘继续处理’‘进入分析’等过程旁白；完成工具工作后一次性给出干净、可独立阅读的最终答复。",
    );
  }
  if (workspaceRootIds.length) {
    parts.push(
      `用户已为本回合授权 ${workspaceRootIds.length} 个文件夹。不要猜测或请求主机路径；先调用 list_workspace_files 搜索 manifest，再对需要的 assetId 调用 read_workspace_file。文件很多时只读取与任务有关的子集。`,
    );
  }
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
    const isFinancialStatementAnalysis =
      taskContract?.spreadsheetRequirement?.needsWrite === false
      && /(?:财务|财报|报表|经营|利润|资产负债|现金流|偿债|盈利)/i.test(current);
    const businessAnalysisSkillPath = path.join(
      getBundledPluginRoot(),
      "skills",
      "business-analysis",
      "SKILL.md",
    );
    const businessAnalysisParserPath = path.join(
      getBundledPluginRoot(),
      "skills",
      "business-analysis",
      "scripts",
      "parse_statements.py",
    );
    parts.push(
      taskContract == null || taskContract.spreadsheetRequirement?.needsWrite === true
        ? [
            `这是 Excel/表格写入任务。请先用 read 加载 xlsx Skill：${xlsxSkillPath}，并遵循其中的读写、公式和验证流程。`,
            // 这里曾写着「用 openpyxl 从附件加载后保存为新文件」——那是一次有损往返:
            // openpyxl 的 load→save 会清空整册公式缓存值(实测 2639 → 2)。模板型任务
            // 的三张报表全由公式驱动,缓存一没就全部读不出数,模型随后会写十几个脚本
            // 反复排查,直到超时(HISTORY-002 实测 27 个脚本、40 分钟、0 交付)。
            "**改动受管 assetId 表格必须用 `patch_workspace_workbook`；只有旧式路径附件才用 `patch_workbook`。不得用 openpyxl/pandas 打开再保存。** 后者会清空整册公式的缓存值，模板里既有的公式将全部读不出结果，且含外部链接的数据无法恢复。这两个受控工具只重写你点名的单元格，其余原样保留。",
            "附件里若提供了模板或工作底稿，**填它，不要另起炉灶重建一张同名表**：模板自带的公式就是计算逻辑，重建等于把它们全丢掉。",
            "优先用 `create_workbook` / `patch_workspace_workbook` 完成常规表格操作；当通用工具不足以表达实际业务逻辑时，可以在本回合输出目录编写并反复 edit Python 脚本，但只能通过 `run_task_python` 执行，不能改用 Bash 或自行启动 Python。先调用 read_workspace_file 获取任务内只读 taskPath，理解文件后必须在修改前调用 begin_workspace_change 冻结格子级目标并保存 planId。脚本只能读取输入快照并写输出目录，不能覆盖输入。",
            "动态脚本可以负责特殊清洗、识别、计算和候选文件生成，但不得用 openpyxl/pandas 对用户现有工作簿做 load→save 整册重写。若必须直接生成候选 XLSX，每轮都要调用 review_workspace_change，对照明确的 changePlan 查看格子级 diff 和 pendingTargets，再调整脚本。",
            "最终候选必须再次调用 review_workspace_change(planId=上述冻结计划, final=true)；没有通过后端差异与计划完成检查的变更不能被描述为完成。之后再调用 finalize_deliverable。",
            taskContract?.spreadsheetRequirement?.needsRecalc ||
            taskContract?.spreadsheetRequirement?.needsRender
              ? "写入 XLSX 后，合同要求的重算与渲染由 `finalize_deliverable` 在沙箱外的受控运行时完成；不要在 Bash 中启动 soffice，也不要手工伪造公式缓存。先执行静态公式、关键输入值、结构和修改范围检查，再调用 finalize_deliverable；只有该工具明确返回 recalc_unavailable 才能报告重算阻塞。"
              : "",
            "完成后必须检查输出文件，并调用 finalize_deliverable 正式交付。",
          ].filter(Boolean).join("\n")
        : [
            `这是 Excel/表格只读分析任务。请先用 read 加载 xlsx Skill：${xlsxSkillPath}，并遵循其中的读取与分析流程。`,
            isFinancialStatementAnalysis
              ? `这看起来是财务报表分析。读取工作簿并确认包含资产负债表、利润表或现金流量表后，必须再用 read 加载经营分析 Skill：${businessAnalysisSkillPath}。标准三表必须使用固定解析器 ${businessAnalysisParserPath}：把它原样复制到本回合输出目录，通过 run_task_python 在任务沙箱执行，再把 canonical 数字和 sourceCells 传给 generate_business_analysis；不要临场手抄整套报表或自行编写另一套解析器。`
              : "",
            "受管 assetId 附件用 read_workspace_file；只有旧式路径附件才用 read_document。读取并理解工作簿后，再基于数据直接回答。",
            "系统冻结的当前合同不要求创建、修改或交付文件，这一约束优先于 Skill 的默认交付约定：不要调用 create_workbook、patch_workbook 或 finalize_deliverable，也不要把分析范围擅自缩成某一张工作表。",
            "分析多表财务报表时，应交叉核对资产负债表、利润表和现金流量表，优先给出关键指标、跨表勾稽、异常与需要核查的原因。",
            isFinancialStatementAnalysis
              ? "会小企利润表中管理费用下的‘其中：研究费用’只是管理费用明细且已包含在管理费用内：不得把它改称独立研发费用、不得重复计入，也不得仅凭该科目推断企业处于研发投入阶段。只有报表明确单列‘研发费用’时才按独立研发费用分析。"
              : "",
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
        "产品 Python Runtime 已预装 python-docx；需要脚本时把 .py 写入本回合输出目录并用 `run_task_python` 执行。不要改用 Bash、自行启动 Python、运行 npm install/pip install，或因为全局 docx-js 不存在而停止。",
        "任务脚本只允许读取已授权输入并写本次输出目录，默认无网络、不能启动子进程。不要在脚本中运行 validate.py、soffice 或自建外部临时目录；DOCX 的可打开性、正文和正式交付验证由 finalize_deliverable 在受控运行时完成。文件生成后直接调用该工具，并以它的返回结果为准。",
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
  const brokerAssets = attachments.filter((attachment) => attachment.assetId);
  if (brokerAssets.length) {
    const visible = brokerAssets.slice(0, 20);
    parts.push(
      `用户随本回合提供了 ${brokerAssets.length} 个受管文件。不要使用或输出主机路径；先调用 list_workspace_files 按名称筛选，再调用 read_workspace_file(assetId)。` +
      (visible.length ? "\n当前 manifest 前 20 项：\n" + visible.map((attachment) => `- ${attachment.name}; assetId=${attachment.assetId}`).join("\n") : "") +
      (brokerAssets.length > visible.length ? `\n另有 ${brokerAssets.length - visible.length} 项未展开，必须按需搜索，不能把全部文件塞进上下文。` : ""),
    );
  }
  const local = attachments.filter((attachment) => attachment.storagePath && !attachment.assetId);
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
  if (attachment.assetId || !attachment.storagePath || attachment.size > 60_000) return null;
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
  const optionalContinuation =
    /如果你愿意|如有需要|如需(?:进一步|继续)?[，,]?(?:我|还)?可以|可选(?:延伸|服务)/.test(normalized);
  const hardBlock =
    /缺少|冲突|无法继续|不能继续|必须(?:先|由用户)|否则.{0,24}无法|在.{0,24}前.{0,12}请确认/.test(normalized);
  if (optionalContinuation && !hardBlock) return false;
  if (/请明确确认|在[^。！？!?\n]{0,24}前[^。！？!?\n]{0,12}请确认/.test(normalized)) {
    return true;
  }
  if (/(?:^|[。！？!?\n])\s*(?:请补充|请提供|请选择|请确认|请明确)/m.test(normalized)) {
    return true;
  }
  const blocked = /不会|无法|不能|暂不|待[^。！？!?\n]{0,20}确认|如需|若要/;
  const decision = /确认|选择|提供|补充|明确|解除[^。！？!?\n]{0,8}(?:约束|限制)/;
  return normalized
    .split(/[。！？!?\n]+/)
    .some((clause) => blocked.test(clause) && decision.test(clause));
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

function attachPiAccounting(
  error: object,
  events: AgentSessionEvent[],
  modelId: string,
  pricingKnown: boolean,
  accounting = collectPiAccounting(events, modelId, pricingKnown),
): void {
  const carrier = error as {
    __modelUsage?: Record<string, AgentModelUsage>;
    __numTurns?: number;
  };
  carrier.__modelUsage = accounting.modelUsage;
  carrier.__numTurns = accounting.numTurns;
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

/**
 * Provider failures are terminal for the current turn. They must be surfaced
 * before completion/minimum-deliverable repair, otherwise a zero-token auth or
 * endpoint failure is misreported as a model capability/validation failure and
 * the benchmark keeps spending cases against an unavailable dependency.
 */
export function throwIfLastAssistantProviderError(
  events: AgentSessionEvent[],
  modelId: string,
  pricingKnown: boolean,
): void {
  const assistantError = lastAssistantError(events);
  if (!assistantError) return;
  const error = new Error(assistantError) as Error & {
    code?: string;
    __modelUsage?: Record<string, AgentModelUsage>;
    __numTurns?: number;
  };
  error.code = "PROVIDER_RESPONSE_ERROR";
  attachPiAccounting(error, events, modelId, pricingKnown);
  throw error;
}

const READ_ONLY_PROVIDER_CONTINUATION_TOOLS = new Set([
  "read",
  "read_file",
  "read_document",
  "list_workspace_files",
  "read_workspace_file",
  "analyze_tabular",
  "check_workbook_ties",
  "detect_data_issues",
  "generate_business_analysis",
]);

export function canContinueReadOnlyTurnAfterProviderFailure(
  error: unknown,
  facts: readonly ExecutionFact[],
  taskContract: TaskContract,
): boolean {
  if (!classifyTransientProviderError(error).retryable) return false;
  if (taskContract.requiredDeliverables.length > 0 || taskContract.spreadsheetRequirement?.needsWrite === true) return false;
  return facts.every((fact) =>
    fact.toolName === "system"
    || READ_ONLY_PROVIDER_CONTINUATION_TOOLS.has(fact.toolName.trim().toLowerCase().replace(/[\s-]+/g, "_"))
  );
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
