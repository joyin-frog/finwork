import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactRef } from "@/lib/artifacts/contracts";
import { ArtifactStore } from "@/lib/artifacts/store";
import { sha256Json } from "@/lib/capability/hash";
import type { PrincipalRef } from "@/lib/capability/common";
import type { EvidenceRecord } from "@/lib/evidence/contracts";
import { EvidenceLedger } from "@/lib/evidence/ledger";
import { getAppDataDir } from "@/lib/runtime/paths";
import type { DataClassification } from "@/lib/security/contracts";
import { authorizeEvidenceWrite } from "@/lib/security/evidence-authorization";
import { SecurityAuthorizer } from "@/lib/security/kernel";
import { TaskContractV3Schema } from "@/lib/task/contracts";
import { TaskStore } from "@/lib/task/store";

const CAPABILITY_ID = "memory.capture-user-statement";
const CAPABILITY_VERSION = "1.0.0";
const ASSERTION_ID = "memory-source-evidence-bound";
const VALIDATOR_ID = "memory.source-evidence-bound";

export type MemoryStatementKind = "create" | "correction";

export type CapturedMemorySource = {
  taskId: string;
  caseId: string;
  artifact: ArtifactRef;
  evidence: EvidenceRecord;
};

/**
 * 把人工录入的记忆原文变成可审计来源，而不是伪造一个字符串形式的 source id。
 * 原文进入不可变 CAS；Evidence 使用字符区间精确定位；Case 留下合同、计划、
 * 断言和完成快照，供删除证明、审计和后续追溯复用。
 */
export class MemorySourceEvidenceService {
  private readonly artifacts: ArtifactStore;
  private readonly tasks: TaskStore;
  private readonly ledger: EvidenceLedger;

  constructor(
    readonly db: DatabaseSync,
    casRoot: string = path.join(getAppDataDir(), "artifacts", "cas"),
  ) {
    this.artifacts = new ArtifactStore(db, casRoot);
    this.tasks = new TaskStore(db);
    this.ledger = new EvidenceLedger(db);
  }

  captureUserStatement(input: {
    content: string;
    kind: MemoryStatementKind;
    principal: PrincipalRef;
    sensitivity: DataClassification;
    memoryId: string;
    at?: string;
  }): CapturedMemorySource {
    const content = input.content.trim();
    if (!content) throw new Error("memory source content must not be empty");

    const traceId = randomUUID();
    const taskId = `task-memory-${traceId}`;
    const caseId = `case-memory-${traceId}`;
    const nodeId = `node-memory-${traceId}`;
    const attemptId = `attempt-memory-${traceId}`;
    const evidenceId = `evidence-memory-${traceId}`;
    const createdAt = input.at ?? new Date().toISOString();
    const producer = {
      capabilityId: CAPABILITY_ID,
      version: CAPABILITY_VERSION,
      attemptId,
    };
    const retention = {
      policyId: "memory-governance",
      legalHold: false,
      allowUserDeletionRequest: true,
      gracePeriodDays: 30,
    };
    const nodeInput = {
      memoryId: input.memoryId,
      statementKind: input.kind,
      contentLength: content.length,
      sensitivity: input.sensitivity,
    };
    const contract = TaskContractV3Schema.parse({
      id: taskId,
      version: 3,
      goal: `Capture immutable user-authored memory ${input.kind} evidence.`,
      caseId,
      businessContext: {
        entities: [],
        counterparties: [],
        periods: [],
        currencies: [],
        units: [],
        accountingStandards: [],
        jurisdictions: [],
      },
      inputs: [],
      requiredCapabilities: [{
        capabilityId: CAPABILITY_ID,
        versionRange: "^1.0.0",
        required: true,
      }],
      invariants: [{
        id: ASSERTION_ID,
        validatorId: VALIDATOR_ID,
        severity: "blocking",
        parameters: { statementKind: input.kind, memoryId: input.memoryId },
      }],
      expectedOutputs: [{
        id: "memory-source",
        mediaType: "text/plain; charset=utf-8",
        logicalName: `memory-${input.kind}-${traceId}.txt`,
        count: 1,
        validatorIds: [VALIDATOR_ID],
        immutableDelivery: true,
      }],
      evidenceRequirements: [
        { evidenceType: "source", minimumCount: 1, requiresLocator: true },
        { evidenceType: "assertion", minimumCount: 1, requiresLocator: false },
      ],
      humanDecisionPoints: [],
      noGuess: ["memory_content", "memory_scope"],
      noDegrade: ["memory.source-evidence"],
      security: {
        classification: input.sensitivity,
        allowedPrincipals: [input.principal],
        allowExternalEgress: false,
        allowedDomains: [],
        requireEncryptionAtRest: true,
        requireHumanApprovalForExport: false,
      },
      retention,
      budget: {
        tokenLimit: null,
        wallTimeMs: 5_000,
        cpuTimeMs: null,
        memoryBytes: 16 * 1024 * 1024,
        diskBytes: 64 * 1024,
        networkBytes: null,
        toolOutputBytes: 64 * 1024,
        concurrency: 1,
        retryLimit: 0,
      },
    });

    this.tasks.saveContract(contract);
    this.tasks.createCase(taskId, caseId, traceId);
    this.tasks.transitionCase(caseId, "preflight");
    this.tasks.savePlan({
      caseId,
      version: 1,
      nodes: [{
        id: nodeId,
        capabilityId: CAPABILITY_ID,
        capabilityVersion: CAPABILITY_VERSION,
        status: "pending",
        input: nodeInput,
        inputHash: sha256Json(nodeInput),
        idempotencyKey: traceId,
        ordinal: 0,
      }],
      edges: [],
      createdAt,
    });
    this.tasks.transitionCase(caseId, "planned");
    this.tasks.transitionCase(caseId, "running");
    this.tasks.updateNodeStatus(nodeId, "running");

    let candidateArtifact: ArtifactRef | undefined;
    try {
      candidateArtifact = this.artifacts.put({
        kind: "memory-source",
        logicalName: `memory-${input.kind}-${traceId}.txt`,
        ownerCaseId: caseId,
        classification: input.sensitivity,
        retention,
        mediaType: "text/plain; charset=utf-8",
        producer,
        metadata: {
          source: "memory-settings",
          statementKind: input.kind,
          memoryId: input.memoryId,
        },
        content: Buffer.from(content, "utf8"),
        state: "candidate",
      });
      const locator = {
        kind: "char_range" as const,
        nodeId: "memory-statement",
        start: 0,
        end: content.length,
      };
      this.artifacts.addRef(candidateArtifact.versionId, "memory", input.memoryId, locator);
      const policyDecisionId = authorizeEvidenceWrite({
        authorizer: new SecurityAuthorizer(this.db),
        principal: input.principal,
        tenantId: input.principal.tenantId ?? "local",
        caseId,
        capabilityId: CAPABILITY_ID,
        artifactVersionId: candidateArtifact.versionId,
        classification: input.sensitivity,
        now: createdAt,
      });
      const evidence = this.ledger.addEvidence(caseId, {
        id: evidenceId,
        type: "source",
        artifact: candidateArtifact,
        locator,
        producer,
        inputs: [],
        outputHash: candidateArtifact.sha256,
        confidence: 1,
        policyDecisionId,
        createdAt,
      });
      this.tasks.updateNodeStatus(nodeId, "validating");
      this.tasks.transitionCase(caseId, "validating");
      this.ledger.recordAssertion({
        caseId,
        assertionId: ASSERTION_ID,
        validatorId: VALIDATOR_ID,
        status: "passed",
        blocking: true,
        evidenceId,
        details: {
          artifactVersionId: candidateArtifact.versionId,
          locator,
          contentHash: candidateArtifact.sha256,
        },
      });
      this.ledger.assertDeliveryGate(caseId);
      this.tasks.updateNodeStatus(nodeId, "succeeded", {
        artifactVersionId: candidateArtifact.versionId,
        evidenceId,
      });
      this.tasks.transitionCase(caseId, "finalizing");
      const deliveredArtifact = this.artifacts.transition(candidateArtifact.artifactId, "delivered");
      this.tasks.saveCheckpoint(caseId, {
        phase: "memory_source_delivered",
        memoryId: input.memoryId,
        artifactVersionId: deliveredArtifact.versionId,
        evidenceId,
        completionEvidence: this.ledger.buildCompletionEvidence(caseId),
      });
      this.tasks.transitionCase(caseId, "delivered");
      return { taskId, caseId, artifact: deliveredArtifact, evidence };
    } catch (error) {
      this.tasks.updateNodeStatus(nodeId, "failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      const state = this.tasks.getCaseState(caseId);
      if (!["failed", "delivered", "canceled"].includes(state)) {
        this.tasks.transitionCase(caseId, "failed", {
          code: "memory_source_capture_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (candidateArtifact) {
        try {
          this.artifacts.transition(candidateArtifact.artifactId, "tombstoned");
        } catch {
          // Artifact may already be delivered; its immutable state is preferable to masking the root error.
        }
      }
      throw error;
    }
  }
}
