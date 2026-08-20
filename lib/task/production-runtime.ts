import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentAttachment, AgentRunContext, AgentIntent, AgentWorkPlanSummary } from "@/lib/agent/contracts";
import type { DeliverySpec } from "@/lib/agent/run-contract";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import { ArtifactStore } from "@/lib/artifacts/store";
import { DocumentLocatorSchema, type ArtifactRef } from "@/lib/artifacts/contracts";
import type { PrincipalRef } from "@/lib/capability/common";
import {
  capabilityIdsForTool,
} from "@/lib/capability/execution-gate";
import { sha256Json } from "@/lib/capability/hash";
import { EvidenceLedger } from "@/lib/evidence/ledger";
import type { EvidenceRef } from "@/lib/evidence/contracts";
import { BusinessCaseStore } from "@/lib/case-management/store";
import type { BusinessCaseKind, CaseRunBinding } from "@/lib/case-management/contracts";
import { getAppDataDir, getConversationFilesDir } from "@/lib/runtime/paths";
import { authorizeEvidenceWrite } from "@/lib/security/evidence-authorization";
import { SecurityAuthorizer } from "@/lib/security/kernel";
import { ensureTaskCapabilityGrant } from "@/lib/security/session-grants";
import { TaskContractV3Schema, type TaskContractV3 } from "./contracts";
import { TaskStore } from "./store";
import { buildWorkPlan, evaluateTaskPreflight, WorkPlanStore } from "./work-plan";

type GateOutcome = "completed" | "aborted" | "error";

export type ProductionTaskAssertionSummary = {
  total: number;
  passed: number;
  failed: number;
};

export type DeliveryRunSettlement = {
  taskId: string;
  caseId: string;
  runId: string;
  outcome: GateOutcome;
  state: "delivered" | "failed" | "canceled";
  artifactRefs: ArtifactRef[];
  evidenceRefs: EvidenceRef[];
  validation: {
    assertions: ProductionTaskAssertionSummary;
    delivery: {
      required: boolean;
      expected: number;
      delivered: number;
      passed: boolean;
    };
  };
  completionEvidence: ReturnType<EvidenceLedger["buildCompletionEvidence"]> | null;
  termination: {
    cancelled: boolean;
    aborted: boolean;
    timedOut: boolean;
  };
  stableFailureCode: string | null;
};

export type DeliveryRun = {
  taskId: string;
  caseId: string;
  runContext: AgentRunContext;
  plan: AgentWorkPlanSummary;
  takePendingEvents(): AgentRuntimeEvent[];
  recordRuntimeEvent(event: AgentRuntimeEvent): AgentRuntimeEvent[];
  completeExecution(summary?: string): AgentRuntimeEvent[];
  markValidating(): void;
  settle(input: {
    outcome: GateOutcome;
    message?: string;
    assistantMessageId?: number;
  }): DeliveryRunSettlement;
  getSettlement(): DeliveryRunSettlement | null;
};

export function beginDeliveryRun(input: {
  db: DatabaseSync;
  traceId: string;
  conversationId?: number;
  goal: string;
  attachments: AgentAttachment[];
  deliverySpec: DeliverySpec;
  /** Optional caller-materialized V3 contract. Its resource budget is never widened. */
  evaluationSpec?: TaskContractV3;
  /** Pre-materialized inputs already owned by the shared ArtifactStore. */
  inputArtifacts?: ArtifactRef[];
  principalId?: string;
  tenantId?: string;
  roleId?: string | null;
  intent?: AgentIntent;
  casRoot?: string;
}): DeliveryRun {
  const suppliedContract = input.evaluationSpec
    ? TaskContractV3Schema.parse(input.evaluationSpec)
    : null;
  const taskId = suppliedContract?.id ?? `task-${input.traceId}`;
  const caseId = suppliedContract?.caseId ?? `case-${input.traceId}`;
  const runId = input.traceId;
  const artifacts = new ArtifactStore(
    input.db,
    input.casRoot ?? path.join(getAppDataDir(), "artifacts", "cas"),
  );
  const taskStore = new TaskStore(input.db);
  const workPlans = new WorkPlanStore(input.db);
  const evidence = new EvidenceLedger(input.db);
  const businessCases = new BusinessCaseStore(input.db);
  const suppliedPrincipal = suppliedContract?.security.allowedPrincipals.find((candidate) =>
    !input.principalId || candidate.id === input.principalId
  );
  if (suppliedContract && !suppliedPrincipal) {
    throw new Error(`delivery principal is not allowed by evaluation spec: ${input.principalId ?? "missing"}`);
  }
  const tenantId = input.tenantId ?? suppliedPrincipal?.tenantId ?? "local";
  if (suppliedPrincipal?.tenantId && suppliedPrincipal.tenantId !== tenantId) {
    throw new Error(`delivery tenant does not match evaluation spec: ${tenantId}`);
  }
  const principal: PrincipalRef = suppliedPrincipal ?? {
    id: input.principalId ?? "local-user",
    type: "user",
    tenantId,
  };
  const authorizer = new SecurityAuthorizer(input.db);
  const capturedInputArtifacts = captureInputArtifacts({
    artifacts,
    attachments: input.attachments,
    traceId: input.traceId,
    conversationId: input.conversationId,
  });
  const contract = suppliedContract
    ? materializeSuppliedContract({
        contract: suppliedContract,
        inputArtifacts: [...(input.inputArtifacts ?? []), ...capturedInputArtifacts],
        requestedGoal: input.goal,
      })
    : buildTaskContract({
        taskId,
        caseId,
        goal: input.goal,
        inputArtifacts: capturedInputArtifacts,
        deliverySpec: input.deliverySpec,
        principalId: principal.id,
      });
  const expectedCount = contract.expectedOutputs.reduce(
    (count, item) => count + item.count,
    0,
  );
  const grantExpiresAt = new Date(Date.now() + (contract.budget.wallTimeMs ?? 4 * 60 * 60 * 1_000)).toISOString();
  ensureTaskCapabilityGrant(authorizer, {
    principal,
    tenantId,
    caseId,
    capabilityId: "agent.turn",
    actions: ["execute", "write"],
    expiresAt: grantExpiresAt,
  });

  taskStore.saveContract(contract);
  taskStore.createCase(taskId, caseId, runId);
  businessCases.setCaseKind(
    caseId,
    inferBusinessCaseKind(input.goal, input.roleId, input.deliverySpec),
    principal,
    "按任务目标和角色建立业务案件类型",
  );
  const startedAt = new Date().toISOString();
  const roleId = input.roleId?.trim() || "finance-primary";
  const capabilityIds = [...new Set([
    "agent.turn",
    ...contract.requiredCapabilities
      .filter((requirement) => requirement.required)
      .map((requirement) => requirement.capabilityId),
  ])];
  const bindRun = (state: CaseRunBinding["state"], endedAt?: string) => {
    businessCases.attachRun({
      caseId,
      runId,
      roleId,
      capabilityIds,
      state,
      startedAt,
      ...(endedAt ? { endedAt } : {}),
    }, principal, endedAt ? "主代理运行完成" : "主代理开始执行");
  };
  bindRun("running");
  const taskInputArtifacts = contract.inputs;
  const suppliedInputVersionIds = new Set((input.inputArtifacts ?? []).map((artifact) => artifact.versionId));
  const sourceEvidenceRefs: EvidenceRef[] = [];
  const sourceEvidenceByArtifactVersion = new Map<string, EvidenceRef>();
  const inputArtifactByLogicalName = new Map<string, ArtifactRef>();
  for (const artifact of taskInputArtifacts) {
    artifacts.addRef(artifact.versionId, "case_input", caseId);
    const createdAt = new Date().toISOString();
    const policyDecisionId = authorizeEvidenceWrite({
      authorizer,
      principal,
      tenantId,
      caseId,
      capabilityId: "agent.turn",
      artifactVersionId: artifact.versionId,
      classification: contract.security.classification,
      now: createdAt,
    });
    const source = evidence.addEvidence(caseId, {
      id: randomUUID(),
      type: "source",
      artifact,
      locator: { kind: "node", nodeId: artifact.versionId },
      producer: {
        capabilityId: "agent.turn",
        version: "production-input-v1",
        attemptId: `${input.traceId}-source-${sourceEvidenceRefs.length}`,
      },
      inputs: [],
      outputHash: artifact.sha256,
      policyDecisionId,
      createdAt,
    });
    const sourceRef = { evidenceId: source.id, outputHash: source.outputHash };
    sourceEvidenceRefs.push(sourceRef);
    sourceEvidenceByArtifactVersion.set(artifact.versionId, sourceRef);
    inputArtifactByLogicalName.set(artifact.logicalName.trim().toLowerCase(), artifact);
  }
  taskStore.transitionCase(caseId, "preflight");
  const createdPlan = buildWorkPlan({
    caseId,
    runId,
    contract,
    intent: input.intent,
    reason: "delivery spec accepted",
  });
  taskStore.savePlan(createdPlan.casePlan);
  let currentPlan = workPlans.create(createdPlan);
  const pendingPlanEvents: AgentRuntimeEvent[] = [{
    type: "work_plan_created",
    planId: currentPlan.planId,
    caseId,
    version: currentPlan.version,
    goal: currentPlan.goal,
    steps: currentPlan.steps.filter((step) => step.userVisible).map((step) => ({
      stepId: step.stepId,
      stepKey: step.stepKey,
      title: step.title,
      expectedOutcome: step.expectedOutcome,
      status: step.status,
      ordinal: step.ordinal,
    })),
  }];
  const changeStep = (
    stepKey: string,
    status: AgentWorkPlanSummary["steps"][number]["status"],
    summary?: string,
  ) => {
    const changed = workPlans.setStepStatus(caseId, stepKey, status, summary);
    if (!changed) return;
    currentPlan = changed.plan;
    pendingPlanEvents.push({
      type: "work_plan_step_changed",
      planId: changed.plan.planId,
      caseId,
      stepId: changed.step.stepId,
      stepKey,
      from: changed.from,
      to: changed.step.status,
      ...(summary ? { summary } : {}),
    });
  };
  const promoteNextStep = (stepKey: string) => {
    const index = currentPlan.steps.findIndex((step) => step.stepKey === stepKey);
    const next = index >= 0 ? currentPlan.steps[index + 1] : undefined;
    if (next?.status === "pending") changeStep(next.stepKey, "ready");
  };
  const preflight = evaluateTaskPreflight(contract);
  workPlans.savePreflight(caseId, preflight);
  changeStep("preflight", "running");
  const missingPreflight = preflight.filter((result) => result.required && result.status !== "available");
  if (missingPreflight.length > 0) {
    const failure = { code: "delivery_preflight_failed", missing: missingPreflight };
    changeStep("preflight", "failed", "必需能力不可用");
    workPlans.finish(caseId, "failed");
    taskStore.transitionCase(caseId, "failed", failure);
    bindRun("failed", new Date().toISOString());
    throw new Error(`delivery preflight failed: ${missingPreflight.map((item) => item.capabilityId).join(", ")}`);
  }
  changeStep("preflight", "succeeded", "输入、权限、资源与能力检查通过");
  promoteNextStep("preflight");
  // Trusted callers such as the production Benchmark executor materialize
  // sources into the shared ArtifactStore before the Agent turn and inject
  // their content into the prompt. Those inputs are already inspected at the
  // contract boundary; requiring a redundant read tool leaves a false pending
  // step even when the deterministic task validators pass. Uploaded/user
  // workspace files are not covered here and still require an actual read.
  const inputsPreMaterializedByCaller = taskInputArtifacts.length > 0
    && taskInputArtifacts.every((artifact) => suppliedInputVersionIds.has(artifact.versionId));
  if (inputsPreMaterializedByCaller && currentPlan.steps.some((step) => step.stepKey === "inspect_inputs")) {
    changeStep("inspect_inputs", "succeeded", "合同输入已由受信物化器读取并注入任务上下文");
    promoteNextStep("inspect_inputs");
  }
  taskStore.transitionCase(caseId, "planned");
  taskStore.transitionCase(caseId, "running");
  taskStore.saveCheckpoint(caseId, {
    phase: "plan_ready",
    traceId: input.traceId,
    planId: currentPlan.planId,
    planVersion: currentPlan.version,
    inputArtifactVersionIds: taskInputArtifacts.map((artifact) => artifact.versionId),
  });

  let settled = false;
  let validating = false;
  let settlement: DeliveryRunSettlement | null = null;
  let outputArtifacts: ArtifactRef[] = [];
  let deliveredOutputCount = 0;
  let deliveryGatePassed = expectedCount === 0;
  const startedTools = new Map<string, { toolName: string; input?: unknown }>();
  const buildSettlement = (result: {
    outcome: GateOutcome;
    state: DeliveryRunSettlement["state"];
    stableFailureCode?: string | null;
    timedOut?: boolean;
  }): DeliveryRunSettlement => {
    const assertionRows = input.db.prepare(`
      SELECT status FROM assertion_results WHERE case_id = ?
    `).all(caseId) as Array<{ status: string }>;
    const evidenceRefs = (input.db.prepare(`
      SELECT evidence_id, output_hash
      FROM evidence_records
      WHERE case_id = ?
      ORDER BY created_at, evidence_id
    `).all(caseId) as Array<{ evidence_id: string; output_hash: string }>).map((row) => ({
      evidenceId: row.evidence_id,
      outputHash: row.output_hash,
    }));
    const passed = assertionRows.filter((row) => row.status === "passed").length;
    const failed = assertionRows.filter((row) => row.status === "failed").length;
    const delivered = deliveredOutputCount;
    const deliveryPassed = deliveryGatePassed;
    return {
      taskId,
      caseId,
      runId,
      outcome: result.outcome,
      state: result.state,
      artifactRefs: [...outputArtifacts],
      evidenceRefs,
      validation: {
        assertions: { total: assertionRows.length, passed, failed },
        delivery: {
          required: expectedCount > 0,
          expected: expectedCount,
          delivered,
          passed: deliveryPassed,
        },
      },
      completionEvidence: result.state === "delivered"
        ? evidence.buildCompletionEvidence(caseId)
        : null,
      termination: {
        cancelled: result.state === "canceled",
        aborted: result.outcome === "aborted",
        timedOut: result.timedOut ?? false,
      },
      stableFailureCode: result.stableFailureCode ?? null,
    };
  };
  const drainPlanEvents = () => pendingPlanEvents.splice(0, pendingPlanEvents.length);
  const markActivePlanFailed = (summary: string) => {
    const active = currentPlan.steps.find((step) =>
      ["ready", "running", "verifying", "waiting_user"].includes(step.status)
    );
    if (active) changeStep(active.stepKey, "failed", summary);
    workPlans.finish(caseId, "failed");
  };
  return {
    taskId,
    caseId,
    plan: currentPlan,
    runContext: {
      taskId,
      caseId,
      runId,
      tenantId,
      principal,
      security: contract.security,
      budget: contract.budget,
    },
    takePendingEvents: drainPlanEvents,
    recordRuntimeEvent(event) {
      if (settled) return [];
      const before = pendingPlanEvents.length;
      if (
        (event.type === "message_started" || event.type === "message_delta")
        && currentPlan.steps.find((step) => step.stepKey === "inspect_inputs")?.status === "succeeded"
      ) {
        changeStep("execute", "running");
      }
      if (event.type === "tool_started") {
        if (event.toolCallId) startedTools.set(event.toolCallId, { toolName: event.toolName, input: event.input });
        const step = workPlanStepForTool(event.toolName, event.input);
        if (step) changeStep(step.stepKey, "running");
      }
      if (event.type === "tool_completed" && event.isError !== true) {
        const started = event.toolCallId ? startedTools.get(event.toolCallId) : undefined;
        const completedToolName = event.toolName || started?.toolName;
        const step = completedToolName ? workPlanStepForTool(completedToolName, started?.input) : null;
        if (step?.completesStep && step.stepKey !== "deliver") {
          changeStep(step.stepKey, "succeeded", `${completedToolName} 执行完成`);
          promoteNextStep(step.stepKey);
        }
      }
      if (event.type === "ask_user") {
        const active = currentPlan.steps.find((step) => step.status === "running");
        if (active) changeStep(active.stepKey, "waiting_user", "等待用户提供必要决策");
        if (taskStore.getCaseState(caseId) === "running") taskStore.transitionCase(caseId, "waiting_for_human");
      }
      if (event.type === "ask_user_answered") {
        const waiting = currentPlan.steps.find((step) => step.status === "waiting_user");
        if (waiting) changeStep(waiting.stepKey, "running", "已收到用户决策，继续执行");
        if (taskStore.getCaseState(caseId) === "waiting_for_human") taskStore.transitionCase(caseId, "running");
      }
      captureGovernedRetrievalEvidence({
        event,
        db: input.db,
        evidence,
        caseId,
        traceId: input.traceId,
        principal,
        tenantId,
        authorizer,
        classification: contract.security.classification,
        sourceEvidenceByArtifactVersion,
      });
      captureBusinessAnalysisEvidence({
        event,
        evidence,
        caseId,
        traceId: input.traceId,
        principal,
        tenantId,
        authorizer,
        classification: contract.security.classification,
        inputArtifactByLogicalName,
        sourceEvidenceByArtifactVersion,
      });
      return pendingPlanEvents.splice(before);
    },
    completeExecution(summary = "主 Agent 已形成最终结果") {
      if (settled) return [];
      const before = pendingPlanEvents.length;
      changeStep("execute", "running");
      changeStep("execute", "succeeded", summary);
      promoteNextStep("execute");
      return pendingPlanEvents.splice(before);
    },
    markValidating() {
      if (settled || validating) return;
      taskStore.transitionCase(caseId, "validating");
      changeStep("validate", "verifying", "正在运行阻断校验与交付检查");
      validating = true;
    },
    getSettlement() {
      return settlement;
    },
    settle(result) {
      if (settled) {
        if (!settlement) throw new Error(`delivery run settled without summary: ${caseId}`);
        return settlement;
      }
      if (result.outcome === "completed") {
        if (!validating) {
          taskStore.transitionCase(caseId, "validating");
          changeStep("validate", "verifying", "正在运行阻断校验与交付检查");
          validating = true;
        }
        outputArtifacts = captureDeliveredOutputs({
          db: input.db,
          artifacts,
          evidence,
          caseId,
          traceId: input.traceId,
          conversationId: input.conversationId,
          assistantMessageId: result.assistantMessageId,
          principal,
          tenantId,
          authorizer,
        });
        recordDeliveryCompletionEvidence({
          db: input.db,
          evidence,
          caseId,
          runId,
          outputArtifacts,
          inputEvidenceRefs: sourceEvidenceRefs,
          principal,
          tenantId,
          authorizer,
          classification: contract.security.classification,
        });
        const contractGate = suppliedContract
          ? evaluateSuppliedContractGate({
              db: input.db,
              caseId,
              contract,
              outputArtifacts,
            })
          : {
              ok: outputArtifacts.length >= expectedCount,
              deliveredCount: outputArtifacts.length,
              code: "delivery_artifact_missing",
              details: { expectedCount, deliveredCount: outputArtifacts.length },
            };
        deliveredOutputCount = contractGate.deliveredCount;
        deliveryGatePassed = contractGate.ok;
        evidence.recordAssertion({
          caseId,
          assertionId: suppliedContract ? "task-contract-delivery-gate" : "delivery-completion-gate",
          validatorId: suppliedContract ? "task-contract.delivery-gate" : "delivery.completion-gate",
          status: contractGate.ok ? "passed" : "failed",
          blocking: true,
          details: contractGate.details,
        });
        if (!contractGate.ok) {
          const failure = { code: contractGate.code, ...contractGate.details };
          changeStep("validate", "failed", contractGate.message ?? "交付合同未满足");
          workPlans.finish(caseId, "failed");
          taskStore.transitionCase(caseId, "failed", failure);
          bindRun("failed", new Date().toISOString());
          settled = true;
          settlement = buildSettlement({
            outcome: result.outcome,
            state: "failed",
            stableFailureCode: contractGate.code,
          });
          throw new Error(
            `delivery gate failed [${contractGate.code}]: ${contractGate.message ?? "task contract requirements were not met"}`,
          );
        }
        if (outputArtifacts.length > 0 && currentPlan.steps.some((step) => step.stepKey === "produce_outputs")) {
          changeStep("produce_outputs", "succeeded", `已生成 ${outputArtifacts.length} 个受管产物`);
          promoteNextStep("produce_outputs");
        }
        const unfinishedPlanSteps = currentPlan.steps.filter((step) =>
          step.blocking
          && step.stepKey !== "validate"
          && step.stepKey !== "deliver"
          && step.status !== "succeeded"
          && step.status !== "skipped"
        );
        evidence.recordAssertion({
          caseId,
          assertionId: "work-plan-completion-gate",
          validatorId: "work-plan.completion-gate",
          status: unfinishedPlanSteps.length === 0 ? "passed" : "failed",
          blocking: true,
          details: { unfinishedStepKeys: unfinishedPlanSteps.map((step) => step.stepKey) },
        });
        if (unfinishedPlanSteps.length > 0) {
          const failure = {
            code: "delivery_plan_incomplete",
            unfinishedStepKeys: unfinishedPlanSteps.map((step) => step.stepKey),
          };
          changeStep("validate", "failed", `计划仍有未完成步骤：${failure.unfinishedStepKeys.join(", ")}`);
          workPlans.finish(caseId, "failed");
          taskStore.transitionCase(caseId, "failed", failure);
          bindRun("failed", new Date().toISOString());
          settled = true;
          settlement = buildSettlement({
            outcome: result.outcome,
            state: "failed",
            stableFailureCode: "delivery_plan_incomplete",
          });
          throw new Error(`delivery plan gate failed: ${failure.unfinishedStepKeys.join(", ")}`);
        }
        evidence.assertDeliveryGate(caseId);
        changeStep("validate", "succeeded", "阻断校验与证据检查通过");
        taskStore.transitionCase(caseId, "finalizing");
        if (currentPlan.steps.some((step) => step.stepKey === "deliver")) {
          changeStep("deliver", "running");
          changeStep("deliver", "succeeded", `已登记 ${outputArtifacts.length} 个不可变交付物`);
        }
        taskStore.saveCheckpoint(caseId, {
          phase: "delivery_verified",
          traceId: input.traceId,
          outputArtifactVersionIds: outputArtifacts.map((artifact) => artifact.versionId),
          completionEvidence: evidence.buildCompletionEvidence(caseId),
        });
        taskStore.transitionCase(caseId, "delivered");
        workPlans.finish(caseId, "completed");
        bindRun("succeeded", new Date().toISOString());
        settled = true;
        settlement = buildSettlement({ outcome: result.outcome, state: "delivered" });
      } else {
        if (!validating) {
          taskStore.transitionCase(caseId, "validating");
          changeStep("validate", "verifying", "正在收口失败与取消状态");
          validating = true;
        }
        evidence.recordAssertion({
          caseId,
          assertionId: "delivery-completion-gate",
          validatorId: "delivery.completion-gate",
          status: "failed",
          blocking: true,
          details: { outcome: result.outcome, message: result.message ?? null },
        });
        if (result.outcome === "aborted") {
          const active = currentPlan.steps.find((step) => ["ready", "running", "verifying", "waiting_user"].includes(step.status));
          if (active) changeStep(active.stepKey, "canceled", result.message ?? "任务已取消");
          workPlans.finish(caseId, "canceled");
        } else {
          markActivePlanFailed(result.message ?? "Agent 执行失败");
        }
        taskStore.transitionCase(
          caseId,
          result.outcome === "aborted" ? "canceled" : "failed",
          { outcome: result.outcome, message: result.message ?? null },
        );
        bindRun(
          result.outcome === "aborted" ? "canceled" : "failed",
          new Date().toISOString(),
        );
        settled = true;
        const timedOut = /timeout|timed out|超时/i.test(result.message ?? "");
        settlement = buildSettlement({
          outcome: result.outcome,
          state: result.outcome === "aborted" ? "canceled" : "failed",
          stableFailureCode: timedOut
            ? "delivery_timeout"
            : result.outcome === "aborted"
              ? "delivery_aborted"
              : "delivery_agent_error",
          timedOut,
        });
      }
      return settlement;
    },
  };
}

function captureGovernedRetrievalEvidence(input: {
  event: AgentRuntimeEvent;
  db: DatabaseSync;
  evidence: EvidenceLedger;
  caseId: string;
  traceId: string;
  principal: PrincipalRef;
  tenantId: string;
  authorizer: SecurityAuthorizer;
  classification: TaskContractV3["security"]["classification"];
  sourceEvidenceByArtifactVersion: ReadonlyMap<string, EvidenceRef>;
}): void {
  const event = input.event;
  if (event.type !== "tool_completed" || event.isError || !event.content) return;
  if (event.toolName !== "search_knowledge") return;
  const pattern = /【引用[^】]*】\n([\s\S]*?)\n来源版本：([^\n]+)\n定位：([^\n]+)\n内容哈希：([a-f0-9]{64})/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(event.content)) !== null) {
    const quotedText = match[1]?.trim();
    const artifactVersionId = match[2]?.trim();
    const locatorText = match[3]?.trim();
    const declaredArtifactHash = match[4]?.toLowerCase();
    if (!quotedText || !artifactVersionId || !locatorText || !declaredArtifactHash) continue;
    const row = input.db.prepare(`
      SELECT a.artifact_id, a.logical_name, a.lifecycle_state,
             v.version_id, v.sha256, v.media_type
      FROM artifact_versions v JOIN artifacts a ON a.artifact_id = v.artifact_id
      WHERE v.version_id = ?
    `).get(artifactVersionId) as {
      artifact_id: string;
      logical_name: string;
      lifecycle_state: ArtifactRef["state"];
      version_id: string;
      sha256: string;
      media_type: string;
    } | undefined;
    if (!row || row.sha256.toLowerCase() !== declaredArtifactHash) continue;
    let locator;
    try {
      locator = DocumentLocatorSchema.parse(JSON.parse(locatorText));
    } catch {
      continue;
    }
    const artifact: ArtifactRef = {
      artifactId: row.artifact_id,
      versionId: row.version_id,
      sha256: row.sha256,
      mediaType: row.media_type,
      logicalName: row.logical_name,
      state: row.lifecycle_state,
    };
    const sourceRef = input.sourceEvidenceByArtifactVersion.get(artifact.versionId);
    if (!sourceRef) continue;
    const createdAt = new Date().toISOString();
    const policyDecisionId = authorizeEvidenceWrite({
      authorizer: input.authorizer,
      principal: input.principal,
      tenantId: input.tenantId,
      caseId: input.caseId,
      capabilityId: "agent.turn",
      artifactVersionId: artifact.versionId,
      classification: input.classification,
      now: createdAt,
    });
    const extraction = input.evidence.addEvidence(input.caseId, {
      id: randomUUID(),
      type: "extraction",
      artifact,
      locator,
      producer: {
        capabilityId: "agent.turn",
        version: "governed-retrieval-bridge-v1",
        attemptId: `${input.traceId}-retrieval-${index}`.slice(0, 200),
      },
      inputs: [sourceRef],
      outputHash: sha256Json(quotedText),
      policyDecisionId,
      createdAt,
    });
    const claimId = randomUUID();
    input.evidence.addClaim({
      id: claimId,
      caseId: input.caseId,
      statement: quotedText,
      evidenceRefs: [extraction.id],
      status: "verified",
    });
    input.evidence.addCitation({
      id: randomUUID(),
      claimId,
      artifactVersionId: artifact.versionId,
      locator,
      quoteHash: sha256Json(quotedText),
      createdAt,
    });
    index += 1;
  }
}

function captureBusinessAnalysisEvidence(input: {
  event: AgentRuntimeEvent;
  evidence: EvidenceLedger;
  caseId: string;
  traceId: string;
  principal: PrincipalRef;
  tenantId: string;
  authorizer: SecurityAuthorizer;
  classification: TaskContractV3["security"]["classification"];
  inputArtifactByLogicalName: ReadonlyMap<string, ArtifactRef>;
  sourceEvidenceByArtifactVersion: ReadonlyMap<string, EvidenceRef>;
}): void {
  const event = input.event;
  if (event.type !== "tool_completed" || event.isError || event.toolName !== "generate_business_analysis") return;
  if (!event.structured || typeof event.structured !== "object") return;
  const provenance = (event.structured as { provenance?: unknown }).provenance;
  if (!provenance || typeof provenance !== "object") return;
  const rawSources = (provenance as { sources?: unknown }).sources;
  const rawFacts = (provenance as { workbookFacts?: unknown }).workbookFacts;
  if (!Array.isArray(rawSources) || !Array.isArray(rawFacts)) return;
  const workbookSource = rawSources.find((source) =>
    source && typeof source === "object" && (source as { kind?: unknown }).kind === "workbook"
  ) as { logicalName?: unknown } | undefined;
  const logicalName = typeof workbookSource?.logicalName === "string" ? workbookSource.logicalName.trim().toLowerCase() : "";
  const spreadsheetInputs = [...input.inputArtifactByLogicalName.values()].filter((artifact) =>
    /spreadsheet|excel|csv/i.test(artifact.mediaType) || /\.(?:xlsx|xlsm|xls|csv|tsv)$/i.test(artifact.logicalName)
  );
  const artifact = input.inputArtifactByLogicalName.get(logicalName)
    ?? (spreadsheetInputs.length === 1 ? spreadsheetInputs[0] : undefined);
  if (!artifact) return;
  const sourceRef = input.sourceEvidenceByArtifactVersion.get(artifact.versionId);
  if (!sourceRef) return;

  let index = 0;
  for (const rawFact of rawFacts.slice(0, 200)) {
    if (!rawFact || typeof rawFact !== "object") continue;
    const fact = rawFact as { field?: unknown; value?: unknown; locator?: unknown };
    if (typeof fact.field !== "string" || typeof fact.value !== "number" || !Number.isFinite(fact.value)) continue;
    const parsedLocator = DocumentLocatorSchema.safeParse(fact.locator);
    if (!parsedLocator.success || parsedLocator.data.kind !== "sheet_range") continue;
    const createdAt = new Date().toISOString();
    const policyDecisionId = authorizeEvidenceWrite({
      authorizer: input.authorizer,
      principal: input.principal,
      tenantId: input.tenantId,
      caseId: input.caseId,
      capabilityId: "agent.turn",
      artifactVersionId: artifact.versionId,
      classification: input.classification,
      now: createdAt,
    });
    const statement = `${fact.field} = ${fact.value}`;
    const extraction = input.evidence.addEvidence(input.caseId, {
      id: randomUUID(),
      type: "extraction",
      artifact,
      locator: parsedLocator.data,
      producer: {
        capabilityId: "agent.turn",
        version: "business-analysis-provenance-bridge-v1",
        attemptId: `${input.traceId}-business-fact-${index}`.slice(0, 200),
      },
      inputs: [sourceRef],
      outputHash: sha256Json({ field: fact.field, value: fact.value }),
      policyDecisionId,
      createdAt,
    });
    const claimId = randomUUID();
    input.evidence.addClaim({
      id: claimId,
      caseId: input.caseId,
      statement,
      structuredValue: { field: fact.field, value: fact.value },
      evidenceRefs: [extraction.id],
      status: "verified",
    });
    input.evidence.addCitation({
      id: randomUUID(),
      claimId,
      artifactVersionId: artifact.versionId,
      locator: parsedLocator.data,
      quoteHash: sha256Json(statement),
      createdAt,
    });
    index += 1;
  }
}

function workPlanStepForTool(
  toolName: string,
  input?: unknown,
): { stepKey: string; completesStep: boolean } | null {
  const normalized = toolName.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "read" && isSkillInstructionRead(input)) return null;
  // Manifest discovery is part of input inspection, but it does not prove that
  // the user file itself has been opened. Keep the step running until the
  // subsequent read_workspace_file/read_document succeeds.
  if (normalized === "list_workspace_files") {
    return { stepKey: "inspect_inputs", completesStep: false };
  }
  const capabilities = capabilityIdsForTool(normalized);
  if (normalized === "spawn_subagent" || capabilities.includes("agent.delegate")) {
    return { stepKey: "coordinate_specialists", completesStep: true };
  }
  if (capabilities.some((id) => id === "research.web" || id.startsWith("retrieval.") || id.startsWith("research."))) {
    return { stepKey: "gather_evidence", completesStep: true };
  }
  if (normalized === "finalize_deliverable" || capabilities.some((id) => id.endsWith(".write"))) {
    return { stepKey: "produce_outputs", completesStep: normalized === "finalize_deliverable" };
  }
  if (capabilities.some((id) => id.endsWith(".read"))) {
    return { stepKey: "inspect_inputs", completesStep: normalized !== "list_workspace_files" };
  }
  return { stepKey: "execute", completesStep: false };
}

function isSkillInstructionRead(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const pathValue = (input as { path?: unknown }).path;
  return typeof pathValue === "string"
    && /(?:^|[\\/])skills?(?:[\\/]|$)/i.test(pathValue)
    && /(?:^|[\\/])SKILL\.md$/i.test(pathValue);
}

/**
 * The finalize_deliverable gate is still the production XLSX validator
 * and immutable-copy authority. Mirror its persisted CompletionEvidence into
 * the V3 EvidenceLedger so a supplied task contract can prove the same
 * validator, transform and assertion facts without running a second validator.
 */
function recordDeliveryCompletionEvidence(input: {
  db: DatabaseSync;
  evidence: EvidenceLedger;
  caseId: string;
  runId: string;
  outputArtifacts: ArtifactRef[];
  inputEvidenceRefs: EvidenceRef[];
  principal: PrincipalRef;
  tenantId: string;
  authorizer: SecurityAuthorizer;
  classification: TaskContractV3["security"]["classification"];
}): void {
  const rows = input.db.prepare(`
    SELECT delivered_sha256, validator_id, validation_status, report_id, validated_at
    FROM completion_evidence
    WHERE run_id = ? AND validation_status = 'passed'
    ORDER BY created_at, id
  `).all(input.runId) as Array<{
    delivered_sha256: string;
    validator_id: string;
    validation_status: string;
    report_id: string;
    validated_at: string;
  }>;
  for (const row of rows) {
    const artifact = input.outputArtifacts.find((candidate) => candidate.sha256 === row.delivered_sha256);
    if (!artifact) continue;
    const createdAt = row.validated_at || new Date().toISOString();
    const authorize = () => authorizeEvidenceWrite({
      authorizer: input.authorizer,
      principal: input.principal,
      tenantId: input.tenantId,
      caseId: input.caseId,
      capabilityId: "agent.turn",
      artifactVersionId: artifact.versionId,
      classification: input.classification,
      now: createdAt,
    });
    const transform = input.evidence.addEvidence(input.caseId, {
      id: randomUUID(),
      type: "transform",
      artifact,
      locator: { kind: "node", nodeId: artifact.versionId },
      producer: {
        capabilityId: "agent.turn",
        version: "finalize-bridge-v1",
        attemptId: `${input.runId}-transform-${row.report_id}`.slice(0, 200),
      },
      inputs: input.inputEvidenceRefs,
      outputHash: artifact.sha256,
      policyDecisionId: authorize(),
      createdAt,
    });
    const assertion = input.evidence.addEvidence(input.caseId, {
      id: randomUUID(),
      type: "assertion",
      artifact,
      locator: { kind: "node", nodeId: artifact.versionId },
      producer: {
        capabilityId: "agent.turn",
        version: "finalize-bridge-v1",
        attemptId: `${input.runId}-assertion-${row.report_id}`.slice(0, 200),
      },
      inputs: [{ evidenceId: transform.id, outputHash: transform.outputHash }],
      outputHash: artifact.sha256,
      policyDecisionId: authorize(),
      createdAt,
    });
    input.evidence.recordAssertion({
      caseId: input.caseId,
      assertionId: `validator:${row.validator_id}`.slice(0, 200),
      validatorId: row.validator_id,
      status: "passed",
      blocking: true,
      evidenceId: assertion.id,
      details: {
        completionEvidenceReportId: row.report_id,
        artifactVersionId: artifact.versionId,
        artifactSha256: artifact.sha256,
      },
    });
  }
}

type SuppliedContractGateResult = {
  ok: boolean;
  deliveredCount: number;
  code: string;
  details: Record<string, unknown>;
  message?: string;
};

/**
 * A supplied V3 contract is a hard delivery boundary. The gate consumes only
 * persisted artifacts, validator assertions and evidence rows; assistant text
 * can never satisfy it.
 */
function evaluateSuppliedContractGate(input: {
  db: DatabaseSync;
  caseId: string;
  contract: TaskContractV3;
  outputArtifacts: ArtifactRef[];
}): SuppliedContractGateResult {
  const missingOutputs: Array<{
    id: string;
    logicalName: string;
    mediaType: string;
    expected: number;
    delivered: number;
  }> = [];
  let deliveredCount = 0;
  for (const expected of input.contract.expectedOutputs) {
    const delivered = input.outputArtifacts.filter((artifact) =>
      artifact.state === "delivered"
      && artifact.logicalName === expected.logicalName
      && artifact.mediaType === expected.mediaType
    ).length;
    deliveredCount += Math.min(delivered, expected.count);
    if (delivered < expected.count) {
      missingOutputs.push({
        id: expected.id,
        logicalName: expected.logicalName,
        mediaType: expected.mediaType,
        expected: expected.count,
        delivered,
      });
    }
  }
  if (missingOutputs.length > 0) {
    return {
      ok: false,
      deliveredCount,
      code: "delivery_artifact_missing",
      details: { missingOutputs },
      message: "expected immutable output artifacts are missing or do not match logical name and media type",
    };
  }

  const requiredValidatorIds = [...new Set(
    input.contract.expectedOutputs.flatMap((output) => output.validatorIds)
      .filter((validatorId) => validatorId !== "task-contract.delivery-gate"),
  )];
  const validatorRows = input.db.prepare(`
    SELECT validator_id, status
    FROM assertion_results
    WHERE case_id = ?
  `).all(input.caseId) as Array<{ validator_id: string; status: string }>;
  const passedValidators = new Set(
    validatorRows.filter((row) => row.status === "passed").map((row) => row.validator_id),
  );
  const missingValidatorIds = requiredValidatorIds.filter((validatorId) => !passedValidators.has(validatorId));
  if (missingValidatorIds.length > 0) {
    return {
      ok: false,
      deliveredCount,
      code: "delivery_validator_missing",
      details: { requiredValidatorIds, missingValidatorIds },
      message: "required validator assertions are missing or not passed",
    };
  }

  const evidenceRows = input.db.prepare(`
    SELECT evidence_type, locator_json
    FROM evidence_records
    WHERE case_id = ?
  `).all(input.caseId) as Array<{ evidence_type: string; locator_json: string | null }>;
  const missingEvidence = input.contract.evidenceRequirements.flatMap((requirement) => {
    const count = evidenceRows.filter((row) =>
      row.evidence_type === requirement.evidenceType
      && (!requirement.requiresLocator || row.locator_json !== null)
    ).length;
    return count >= requirement.minimumCount
      ? []
      : [{
          evidenceType: requirement.evidenceType,
          minimumCount: requirement.minimumCount,
          requiresLocator: requirement.requiresLocator,
          observedCount: count,
        }];
  });
  if (missingEvidence.length > 0) {
    return {
      ok: false,
      deliveredCount,
      code: "delivery_evidence_missing",
      details: { missingEvidence },
      message: "required evidence records are missing or lack precise locators",
    };
  }

  return {
    ok: true,
    deliveredCount,
    code: "delivery_gate_passed",
    details: {
      expectedCount: input.contract.expectedOutputs.reduce((sum, item) => sum + item.count, 0),
      deliveredCount,
      requiredValidatorIds,
      evidenceRequirements: input.contract.evidenceRequirements,
    },
  };
}

function materializeSuppliedContract(input: {
  contract: TaskContractV3;
  inputArtifacts: ArtifactRef[];
  requestedGoal: string;
}): TaskContractV3 {
  const requestedGoal = input.requestedGoal.trim();
  if (requestedGoal && requestedGoal !== input.contract.goal) {
    throw new Error("delivery goal does not match prebuilt evaluation spec");
  }
  const mergedInputs = new Map<string, ArtifactRef>();
  for (const artifact of [...input.contract.inputs, ...input.inputArtifacts]) {
    mergedInputs.set(artifact.versionId, artifact);
  }
  return TaskContractV3Schema.parse({
    ...input.contract,
    inputs: [...mergedInputs.values()],
  });
}

function inferBusinessCaseKind(
  goal: string,
  roleId: string | null | undefined,
  deliverySpec: DeliverySpec,
): BusinessCaseKind {
  const value = `${roleId ?? ""} ${deliverySpec.taskKind} ${goal}`.toLowerCase();
  if (/尽调|尽职调查|due\s*diligence/.test(value)) return "due_diligence";
  if (/合并|抵消|consolidat/.test(value)) return "financial_consolidation";
  if (/申报|税|发票|filing|tax/.test(value)) return "filing_review";
  if (/工资|薪酬|个税|payroll/.test(value)) return "payroll_tax";
  if (/资金|银行|现金|对账|treasury|recon/.test(value)) return "treasury_analysis";
  return "general_finance";
}

function buildTaskContract(input: {
  taskId: string;
  caseId: string;
  goal: string;
  inputArtifacts: ArtifactRef[];
  deliverySpec: DeliverySpec;
  principalId: string;
}): TaskContractV3 {
  const spreadsheet = input.deliverySpec.taskKind !== "text";
  const spreadsheetWrite = input.deliverySpec.spreadsheetRequirement?.needsWrite === true;
  const spreadsheetValidation = input.deliverySpec.requiredDeliverables.length > 0;
  const research = isResearchTask(input.goal);
  const delegation = /跨(?:部门|角色)|专员|协同|并行|subagent/i.test(input.goal);
  const allowedDomains = research ? configuredResearchDomains() : [];
  const allowExternalEgress = research && allowedDomains.length > 0;
  return TaskContractV3Schema.parse({
    id: input.taskId,
    version: 3,
    goal: input.goal.trim() || "Complete the requested finance task.",
    caseId: input.caseId,
    businessContext: {
      entities: [],
      counterparties: [],
      periods: [],
      currencies: [],
      units: [],
      accountingStandards: [],
      jurisdictions: [],
    },
    inputs: input.inputArtifacts,
    requiredCapabilities: [
      { capabilityId: "agent.turn", versionRange: "^1.0.0" },
      ...(spreadsheet
        ? [
            { capabilityId: "spreadsheet.read", versionRange: "^1.0.0" },
            ...(spreadsheetWrite
              ? [{ capabilityId: "spreadsheet.write", versionRange: "^1.0.0" }]
              : []),
            ...(spreadsheetValidation
              ? [{ capabilityId: "spreadsheet.validate", versionRange: "^1.0.0" }]
              : []),
          ]
        : []),
      ...(research
        ? [{ capabilityId: "research.web", versionRange: "^1.0.0" }]
        : []),
      ...(delegation
        ? [{ capabilityId: "agent.delegate", versionRange: "^1.0.0" }]
        : []),
    ],
    invariants: [{
      id: "delivery-completion-gate",
      validatorId: "delivery.completion-gate",
      severity: "blocking",
      parameters: {
        taskKind: input.deliverySpec.taskKind,
        requiredDeliverableIds: input.deliverySpec.requiredDeliverables.map((item) => item.id),
      },
    }],
    expectedOutputs: input.deliverySpec.requiredDeliverables.map((item) => ({
      id: item.id,
      mediaType: item.mime,
      logicalName: `${item.id}.xlsx`,
      count: item.count,
      validatorIds: ["delivery.completion-gate"],
      immutableDelivery: true,
    })),
    evidenceRequirements: [
      { evidenceType: "assertion", minimumCount: 1, requiresLocator: false },
      ...(input.deliverySpec.requiredDeliverables.length > 0
        ? [{ evidenceType: "delivery", minimumCount: 1, requiresLocator: false }]
        : []),
    ],
    humanDecisionPoints: [],
    noGuess: ["entity", "period", "currency", "accounting_standard"],
    noDegrade: [
      ...(spreadsheet ? ["spreadsheet.read"] : ["evidence.assertion"]),
      ...(spreadsheetWrite ? ["spreadsheet.write"] : []),
      ...(spreadsheetValidation ? ["spreadsheet.validate", "evidence.delivery"] : []),
      ...(research ? ["research.web", "evidence.citation"] : []),
    ],
    security: {
      classification: "confidential",
      allowedPrincipals: [{ id: input.principalId, type: "user" }],
      allowExternalEgress,
      allowedDomains,
      requireEncryptionAtRest: true,
      requireHumanApprovalForExport: false,
    },
    retention: { policyId: "finance-default" },
    budget: {
      tokenLimit: 500_000,
      wallTimeMs: 4 * 60 * 60 * 1_000,
      cpuTimeMs: 2 * 60 * 60 * 1_000,
      memoryBytes: 1024 * 1024 * 1024,
      diskBytes: 2 * 1024 * 1024 * 1024,
      networkBytes: 256 * 1024 * 1024,
      toolOutputBytes: 64 * 1024 * 1024,
      concurrency: 2,
      retryLimit: 0,
    },
  });
}

function isResearchTask(goal: string): boolean {
  return /尽调|尽职调查|联网|网络搜索|公开资料|外部资料|due\s*diligence|web\s*research/i.test(goal);
}

function configuredResearchDomains(): string[] {
  const configured = (process.env.FINWORK_RESEARCH_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const endpoint = process.env.FINWORK_RESEARCH_GATEWAY_URL?.trim();
  if (endpoint) {
    try {
      configured.push(new URL(endpoint).hostname.toLowerCase());
    } catch {
      // Invalid provider configuration is rejected by the Research tool. The
      // task contract must not silently grant egress for an unparseable URL.
    }
  }
  return [...new Set(configured)];
}

function captureInputArtifacts(input: {
  artifacts: ArtifactStore;
  attachments: AgentAttachment[];
  traceId: string;
  conversationId?: number;
}): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    const content = readAttachmentContent(attachment, input.conversationId);
    if (!content) continue;
    refs.push(input.artifacts.put({
      kind: "task_input",
      logicalName: attachment.name,
      classification: "confidential",
      retention: { policyId: "finance-default" },
      mediaType: attachment.mimeType || "application/octet-stream",
      producer: {
        capabilityId: "request.attachment-ingest",
        version: "1.0.0",
        attemptId: `${input.traceId}-input-${index}`,
      },
      metadata: { declaredSize: attachment.size },
      content,
      state: "candidate",
    }));
  }
  return refs;
}

function captureDeliveredOutputs(input: {
  db: DatabaseSync;
  artifacts: ArtifactStore;
  evidence: EvidenceLedger;
  caseId: string;
  traceId: string;
  conversationId?: number;
  assistantMessageId?: number;
  principal: PrincipalRef;
  tenantId: string;
  authorizer: SecurityAuthorizer;
}): ArtifactRef[] {
  if (!input.conversationId || !input.assistantMessageId) return [];
  const rows = input.db.prepare(`
    SELECT file_name, mime_type, storage_path
    FROM chat_attachments
    WHERE message_id = ? AND role = 'assistant'
    ORDER BY id
  `).all(input.assistantMessageId) as Array<{
    file_name: string;
    mime_type: string;
    storage_path: string;
  }>;
  const root = path.resolve(getConversationFilesDir(input.conversationId));
  const refs: ArtifactRef[] = [];
  for (const [index, row] of rows.entries()) {
    const filePath = path.resolve(root, row.storage_path);
    if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath);
    const candidate = input.artifacts.put({
      kind: "task_output",
      logicalName: row.file_name,
      ownerCaseId: input.caseId,
      classification: "confidential",
      retention: { policyId: "finance-default" },
      mediaType: row.mime_type || "application/octet-stream",
      producer: {
        capabilityId: "agent.turn",
        version: "1.0.0",
        attemptId: `${input.traceId}-output-${index}`,
      },
      metadata: { conversationId: input.conversationId, storagePath: row.storage_path },
      content,
      state: "candidate",
    });
    const delivered = input.artifacts.transition(candidate.artifactId, "delivered");
    input.artifacts.addRef(delivered.versionId, "case_output", input.caseId);
    input.artifacts.addRef(delivered.versionId, "delivery", input.caseId);
    const createdAt = new Date().toISOString();
    const policyDecisionId = authorizeEvidenceWrite({
      authorizer: input.authorizer,
      principal: input.principal,
      tenantId: input.tenantId,
      caseId: input.caseId,
      capabilityId: "agent.turn",
      artifactVersionId: delivered.versionId,
      classification: "confidential",
      now: createdAt,
    });
    input.evidence.addEvidence(input.caseId, {
      id: randomUUID(),
      type: "delivery",
      artifact: delivered,
      producer: {
        capabilityId: "agent.turn",
        version: "1.0.0",
        attemptId: `${input.traceId}-delivery-${index}`,
      },
      inputs: [],
      outputHash: delivered.sha256,
      policyDecisionId,
      createdAt,
    });
    refs.push(delivered);
  }
  return refs;
}

function readAttachmentContent(attachment: AgentAttachment, conversationId?: number): Uint8Array | null {
  if (attachment.storagePath) {
    const candidate = path.isAbsolute(attachment.storagePath)
      ? path.resolve(attachment.storagePath)
      : conversationId
        ? path.resolve(getConversationFilesDir(conversationId), attachment.storagePath)
        : null;
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.readFileSync(candidate);
    }
  }
  if (attachment.text !== undefined) return Buffer.from(attachment.text, "utf8");
  const match = attachment.dataUrl.match(/^data:[^,]*?(;base64)?,(.*)$/s);
  if (!match) return null;
  return match[1]
    ? Buffer.from(match[2] ?? "", "base64")
    : Buffer.from(decodeURIComponent(match[2] ?? ""), "utf8");
}

export function artifactContentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
