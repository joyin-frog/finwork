import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentAttachment, AgentFoundationContext } from "@/lib/agent/contracts";
import type { TaskContract as LegacyTaskContract } from "@/lib/agent/run-contract";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import { ArtifactStore } from "@/lib/artifacts/store";
import type { ArtifactRef } from "@/lib/artifacts/contracts";
import type { PrincipalRef } from "@/lib/capability/common";
import {
  CapabilityExecutionLedger,
  evaluateExecutionRequirements,
  type ExecutionRequirement,
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

type GateOutcome = "completed" | "aborted" | "error";

export type ProductionTaskAssertionSummary = {
  total: number;
  passed: number;
  failed: number;
};

export type ProductionTaskSettlement = {
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

export type ProductionTaskRun = {
  taskId: string;
  caseId: string;
  foundation: AgentFoundationContext;
  recordRuntimeEvent(event: AgentRuntimeEvent): void;
  markValidating(): void;
  settle(input: {
    outcome: GateOutcome;
    message?: string;
    assistantMessageId?: number;
  }): ProductionTaskSettlement;
  getSettlement(): ProductionTaskSettlement | null;
};

export function beginProductionTaskRun(input: {
  db: DatabaseSync;
  traceId: string;
  conversationId?: number;
  goal: string;
  attachments: AgentAttachment[];
  legacyContract: LegacyTaskContract;
  /** Optional caller-materialized V3 contract. Its resource budget is never widened. */
  taskContract?: TaskContractV3;
  /** Pre-materialized inputs already owned by the shared ArtifactStore. */
  inputArtifacts?: ArtifactRef[];
  principalId?: string;
  tenantId?: string;
  roleId?: string | null;
  casRoot?: string;
}): ProductionTaskRun {
  const suppliedContract = input.taskContract
    ? TaskContractV3Schema.parse(input.taskContract)
    : null;
  const taskId = suppliedContract?.id ?? `task-${input.traceId}`;
  const caseId = suppliedContract?.caseId ?? `case-${input.traceId}`;
  const runId = input.traceId;
  const nodeId = `node-${input.traceId}`;
  const artifacts = new ArtifactStore(
    input.db,
    input.casRoot ?? path.join(getAppDataDir(), "artifacts", "cas"),
  );
  const taskStore = new TaskStore(input.db);
  const evidence = new EvidenceLedger(input.db);
  const businessCases = new BusinessCaseStore(input.db);
  const suppliedPrincipal = suppliedContract?.security.allowedPrincipals.find((candidate) =>
    !input.principalId || candidate.id === input.principalId
  );
  if (suppliedContract && !suppliedPrincipal) {
    throw new Error(`production task principal is not allowed by task contract: ${input.principalId ?? "missing"}`);
  }
  const tenantId = input.tenantId ?? suppliedPrincipal?.tenantId ?? "local";
  if (suppliedPrincipal?.tenantId && suppliedPrincipal.tenantId !== tenantId) {
    throw new Error(`production task tenant does not match task contract: ${tenantId}`);
  }
  const principal: PrincipalRef = suppliedPrincipal ?? {
    id: input.principalId ?? "local-user",
    type: "user",
    tenantId,
  };
  const authorizer = new SecurityAuthorizer(input.db);
  const executionLedger = new CapabilityExecutionLedger();
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
        legacyContract: input.legacyContract,
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
  executionLedger.seed("agent.turn");
  const executionRequirements: ExecutionRequirement[] = contract.requiredCapabilities
    .filter((requirement) => requirement.required)
    .map((requirement) => ({
      id: requirement.capabilityId,
      description: `执行合同能力 ${requirement.capabilityId}`,
      anyOf: [requirement.capabilityId],
    }));

  taskStore.saveContract(contract);
  taskStore.createCase(taskId, caseId, runId);
  businessCases.setCaseKind(
    caseId,
    inferBusinessCaseKind(input.goal, input.roleId, input.legacyContract),
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
  for (const artifact of taskInputArtifacts) {
    artifacts.addRef(artifact.versionId, "case_input", caseId);
  }
  taskStore.transitionCase(caseId, "preflight");
  taskStore.savePlan({
    caseId,
    version: 1,
    nodes: [{
      id: nodeId,
      capabilityId: "agent.turn",
      capabilityVersion: "1.0.0",
      status: "pending",
      input: {
        taskId,
        inputArtifactVersionIds: taskInputArtifacts.map((artifact) => artifact.versionId),
        legacyTaskKind: input.legacyContract.taskKind,
      },
      inputHash: sha256Json({
        taskId,
        inputArtifactVersionIds: taskInputArtifacts.map((artifact) => artifact.versionId),
        legacyTaskKind: input.legacyContract.taskKind,
      }),
      idempotencyKey: input.traceId,
      ordinal: 0,
    }],
    edges: [],
    createdAt: new Date().toISOString(),
  });
  taskStore.transitionCase(caseId, "planned");
  taskStore.transitionCase(caseId, "running");
  taskStore.updateNodeStatus(nodeId, "running");
  taskStore.saveCheckpoint(caseId, {
    phase: "agent_turn_started",
    traceId: input.traceId,
    inputArtifactVersionIds: taskInputArtifacts.map((artifact) => artifact.versionId),
  });

  let settled = false;
  let validating = false;
  let settlement: ProductionTaskSettlement | null = null;
  let outputArtifacts: ArtifactRef[] = [];
  let deliveredOutputCount = 0;
  let deliveryGatePassed = expectedCount === 0;
  const buildSettlement = (result: {
    outcome: GateOutcome;
    state: ProductionTaskSettlement["state"];
    stableFailureCode?: string | null;
    timedOut?: boolean;
  }): ProductionTaskSettlement => {
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
  return {
    taskId,
    caseId,
    foundation: {
      taskId,
      caseId,
      runId,
      tenantId,
      principal,
      security: contract.security,
      budget: contract.budget,
    },
    recordRuntimeEvent(event) {
      if (settled) return;
      executionLedger.record(event);
    },
    markValidating() {
      if (settled || validating) return;
      taskStore.transitionCase(caseId, "validating");
      validating = true;
    },
    getSettlement() {
      return settlement;
    },
    settle(result) {
      if (settled) {
        if (!settlement) throw new Error(`production task settled without summary: ${caseId}`);
        return settlement;
      }
      if (result.outcome === "completed") {
        if (!validating) {
          taskStore.transitionCase(caseId, "validating");
          validating = true;
        }
        const executionDecision = evaluateExecutionRequirements(
          executionRequirements,
          executionLedger.snapshot(),
        );
        evidence.recordAssertion({
          caseId,
          assertionId: "required-capability-execution-gate",
          validatorId: "capability.execution-gate",
          status: executionDecision.ok ? "passed" : "failed",
          blocking: true,
          details: executionDecision.ok
            ? { observedCapabilityIds: executionDecision.observedCapabilityIds }
            : {
                missing: executionDecision.missing,
                observedCapabilityIds: executionDecision.observedCapabilityIds,
                diagnosticFingerprint: executionDecision.diagnosticFingerprint,
              },
        });
        if (!executionDecision.ok) {
          const failure = {
            code: "foundation_required_capability_missing",
            missing: executionDecision.missing,
            observedCapabilityIds: executionDecision.observedCapabilityIds,
          };
          taskStore.updateNodeStatus(nodeId, "failed", failure);
          taskStore.transitionCase(caseId, "failed", failure);
          bindRun("failed", new Date().toISOString());
          settled = true;
          settlement = buildSettlement({
            outcome: result.outcome,
            state: "failed",
            stableFailureCode: "foundation_required_capability_missing",
          });
          throw new Error(`foundation capability gate failed: ${executionDecision.message}`);
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
              code: "foundation_delivery_artifact_missing",
              details: { expectedCount, deliveredCount: outputArtifacts.length },
            };
        deliveredOutputCount = contractGate.deliveredCount;
        deliveryGatePassed = contractGate.ok;
        evidence.recordAssertion({
          caseId,
          assertionId: suppliedContract ? "task-contract-delivery-gate" : "legacy-completion-gate",
          validatorId: suppliedContract ? "task-contract.delivery-gate" : "legacy.completion-gate",
          status: contractGate.ok ? "passed" : "failed",
          blocking: true,
          details: contractGate.details,
        });
        if (!contractGate.ok) {
          const failure = { code: contractGate.code, ...contractGate.details };
          taskStore.updateNodeStatus(nodeId, "failed", failure);
          taskStore.transitionCase(caseId, "failed", failure);
          bindRun("failed", new Date().toISOString());
          settled = true;
          settlement = buildSettlement({
            outcome: result.outcome,
            state: "failed",
            stableFailureCode: contractGate.code,
          });
          throw new Error(
            `foundation delivery gate failed [${contractGate.code}]: ${contractGate.message ?? "task contract requirements were not met"}`,
          );
        }
        evidence.assertDeliveryGate(caseId);
        taskStore.updateNodeStatus(nodeId, "succeeded", {
          outputArtifactVersionIds: outputArtifacts.map((artifact) => artifact.versionId),
        });
        taskStore.transitionCase(caseId, "finalizing");
        taskStore.saveCheckpoint(caseId, {
          phase: "delivery_verified",
          traceId: input.traceId,
          outputArtifactVersionIds: outputArtifacts.map((artifact) => artifact.versionId),
          completionEvidence: evidence.buildCompletionEvidence(caseId),
        });
        taskStore.transitionCase(caseId, "delivered");
        bindRun("succeeded", new Date().toISOString());
        settled = true;
        settlement = buildSettlement({ outcome: result.outcome, state: "delivered" });
      } else {
        if (!validating) {
          taskStore.transitionCase(caseId, "validating");
          validating = true;
        }
        evidence.recordAssertion({
          caseId,
          assertionId: "legacy-completion-gate",
          validatorId: "legacy.completion-gate",
          status: "failed",
          blocking: true,
          details: { outcome: result.outcome, message: result.message ?? null },
        });
        taskStore.updateNodeStatus(
          nodeId,
          result.outcome === "aborted" ? "canceled" : "failed",
          { outcome: result.outcome, message: result.message ?? null },
        );
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
            ? "foundation_timeout"
            : result.outcome === "aborted"
              ? "foundation_aborted"
              : "foundation_agent_error",
          timedOut,
        });
      }
      return settlement;
    },
  };
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
      code: "foundation_delivery_artifact_missing",
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
      code: "foundation_required_validator_missing",
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
      code: "foundation_required_evidence_missing",
      details: { missingEvidence },
      message: "required evidence records are missing or lack precise locators",
    };
  }

  return {
    ok: true,
    deliveredCount,
    code: "foundation_contract_gate_passed",
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
    throw new Error("production task goal does not match prebuilt task contract");
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
  legacyContract: LegacyTaskContract,
): BusinessCaseKind {
  const value = `${roleId ?? ""} ${legacyContract.taskKind} ${goal}`.toLowerCase();
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
  legacyContract: LegacyTaskContract;
  principalId: string;
}): TaskContractV3 {
  const spreadsheet = input.legacyContract.taskKind !== "text";
  const research = isResearchTask(input.goal);
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
            { capabilityId: "spreadsheet.write", versionRange: "^1.0.0" },
            { capabilityId: "spreadsheet.validate", versionRange: "^1.0.0" },
          ]
        : []),
      ...(research
        ? [{ capabilityId: "research.web", versionRange: "^1.0.0" }]
        : []),
    ],
    invariants: [{
      id: "legacy-completion-gate",
      validatorId: "legacy.completion-gate",
      severity: "blocking",
      parameters: {
        taskKind: input.legacyContract.taskKind,
        requiredDeliverableIds: input.legacyContract.requiredDeliverables.map((item) => item.id),
      },
    }],
    expectedOutputs: input.legacyContract.requiredDeliverables.map((item) => ({
      id: item.id,
      mediaType: item.mime,
      logicalName: `${item.id}.xlsx`,
      count: item.count,
      validatorIds: ["legacy.completion-gate"],
      immutableDelivery: true,
    })),
    evidenceRequirements: [
      { evidenceType: "assertion", minimumCount: 1, requiresLocator: false },
      ...(input.legacyContract.requiredDeliverables.length > 0
        ? [{ evidenceType: "delivery", minimumCount: 1, requiresLocator: false }]
        : []),
    ],
    humanDecisionPoints: [],
    noGuess: ["entity", "period", "currency", "accounting_standard"],
    noDegrade: [
      ...(spreadsheet ? ["spreadsheet.write", "spreadsheet.validate", "evidence.delivery"] : ["evidence.assertion"]),
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
