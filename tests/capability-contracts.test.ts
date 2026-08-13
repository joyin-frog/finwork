/**
 * Agent capability foundation shared-contract tests.
 *
 * These tests intentionally exercise rejection semantics. The foundation must
 * fail closed instead of accepting incomplete evidence, undeclared retries or
 * ambiguous task contracts.
 */

import assert from "node:assert/strict";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

export const capabilityContractsTestPromise = (async () => {
  const {
    ArtifactRefSchema,
    CapabilityManifestSchema,
    CitationRecordSchema,
    DataHandlingPolicySchema,
    EvidenceRecordSchema,
    MemoryRecordV2Schema,
    PolicyDecisionSchema,
    ResourceBudgetSchema,
    TaskContractV3Schema,
  } = await import("../lib/capability/index.ts");

  const artifact = {
    artifactId: "artifact-1",
    versionId: "artifact-version-1",
    sha256: HASH,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    logicalName: "trial-balance.xlsx",
    state: "candidate" as const,
  };
  assert.equal(ArtifactRefSchema.safeParse(artifact).success, true);
  assert.equal(ArtifactRefSchema.safeParse({ ...artifact, sha256: "not-a-hash" }).success, false);

  const locator = { kind: "sheet_range" as const, sheet: "Trial Balance", range: "A1:F42" };
  const sourceEvidence = {
    id: "evidence-1",
    type: "source" as const,
    artifact,
    locator,
    producer: { capabilityId: "spreadsheet.read", version: "1.0.0", attemptId: "attempt-1" },
    inputs: [],
    outputHash: OTHER_HASH,
    confidence: 1,
    policyDecisionId: "policy-decision-1",
    createdAt: "2026-08-09T08:00:00+08:00",
  };
  assert.equal(EvidenceRecordSchema.safeParse(sourceEvidence).success, true);
  assert.equal(EvidenceRecordSchema.safeParse({ ...sourceEvidence, locator: undefined }).success, false);
  assert.equal(
    CitationRecordSchema.safeParse({
      id: "citation-1",
      claimId: "claim-1",
      artifactVersionId: artifact.versionId,
      locator,
      quoteHash: HASH,
      createdAt: "2026-08-09T08:00:00+08:00",
    }).success,
    true,
  );

  const principal = { id: "user-1", type: "user" as const, tenantId: "tenant-1" };
  const security = {
    classification: "confidential" as const,
    allowedPrincipals: [principal],
    allowExternalEgress: false,
  };
  const parsedSecurity = DataHandlingPolicySchema.parse(security);
  assert.equal(parsedSecurity.allowExternalEgress, false);
  assert.deepEqual(parsedSecurity.allowedDomains, []);
  assert.equal(parsedSecurity.requireEncryptionAtRest, true);
  assert.equal(
    DataHandlingPolicySchema.safeParse({ ...security, allowedDomains: ["example.com"] }).success,
    false,
    "external domains must not be accepted while egress is denied",
  );

  const task = {
    id: "task-1",
    version: 3 as const,
    goal: "Validate the trial balance and produce an evidence-backed workbook.",
    caseId: "case-1",
    businessContext: {
      entities: [{ id: "entity-1", type: "company", name: "示例公司" }],
      counterparties: [],
      periods: [{ start: "2026-01-01", end: "2026-06-30", label: "2026H1" }],
      currencies: [{ code: "CNY" }],
      units: [{ code: "yuan" }],
      accountingStandards: ["CAS"],
      jurisdictions: ["CN"],
    },
    inputs: [artifact],
    requiredCapabilities: [
      { capabilityId: "spreadsheet.read", versionRange: "^1.0.0" },
      { capabilityId: "spreadsheet.validate", versionRange: "^1.0.0" },
    ],
    invariants: [
      {
        id: "balance-check",
        validatorId: "accounting.equation",
        severity: "blocking" as const,
        parameters: { tolerance: 0.01 },
      },
    ],
    expectedOutputs: [
      {
        id: "validated-workbook",
        mediaType: artifact.mediaType,
        logicalName: "validated-trial-balance.xlsx",
        validatorIds: ["spreadsheet.integrity", "accounting.equation"],
      },
    ],
    evidenceRequirements: [
      { evidenceType: "source" as const, requiresLocator: true },
      { evidenceType: "assertion" as const },
      { evidenceType: "delivery" as const },
    ],
    humanDecisionPoints: [
      {
        id: "confirm-write",
        prompt: "确认写入校验结果？",
        requiredBeforeCapabilityIds: ["spreadsheet.validate"],
      },
    ],
    noGuess: ["entity", "period", "currency"],
    noDegrade: ["spreadsheet.write", "evidence.delivery"],
    security,
    retention: { policyId: "finance-default" },
    budget: { wallTimeMs: 60_000, memoryBytes: 512 * 1024 * 1024 },
  };
  const parsedTask = TaskContractV3Schema.parse(task);
  assert.equal(parsedTask.version, 3);
  assert.equal(parsedTask.expectedOutputs[0]?.immutableDelivery, true);
  assert.equal(parsedTask.budget.concurrency, 1);
  assert.equal(
    TaskContractV3Schema.safeParse({ ...task, unexpectedFallback: true }).success,
    false,
    "TaskContractV3 must reject unknown fallback fields",
  );
  assert.equal(
    TaskContractV3Schema.safeParse({
      ...task,
      humanDecisionPoints: [
        {
          id: "invalid-decision",
          prompt: "invalid",
          requiredBeforeCapabilityIds: ["undeclared.capability"],
        },
      ],
    }).success,
    false,
    "human decisions must reference declared required capabilities",
  );

  const baseManifest = {
    id: "spreadsheet.read",
    version: "1.0.0",
    title: "Read spreadsheet",
    inputSchemaId: "schema://spreadsheet-read-input/v1",
    outputSchemaId: "schema://spreadsheet-read-output/v1",
    preconditions: [],
    sideEffects: [{ kind: "read" as const, target: "artifact", reversible: true }],
    requiredPermissions: [{ action: "read", resourceType: "artifact", scope: "task.inputs" }],
    evidenceProduced: [{ type: "source" as const, requiresLocator: true }],
    resourceEstimate: {
      expectedWallTimeMs: 1_000,
      expectedMemoryBytes: 64 * 1024 * 1024,
      expectedDiskBytes: 0,
      expectedNetworkBytes: 0,
      expectedToolOutputBytes: 1_000_000,
      confidence: 0.8,
    },
    validators: [{ id: "spreadsheet.parse", version: "1.0.0" }],
    failureSemantics: {
      declaredKinds: ["invalid_input" as const, "deterministic_validation_failed" as const],
    },
    idempotency: { mode: "input_hash" as const },
  };
  assert.equal(CapabilityManifestSchema.safeParse(baseManifest).success, true);
  assert.equal(
    CapabilityManifestSchema.safeParse({
      ...baseManifest,
      failureSemantics: {
        declaredKinds: ["deterministic_validation_failed"],
        retryableKinds: ["deterministic_validation_failed"],
        maxAttempts: 2,
      },
    }).success,
    false,
    "deterministic failures must never be retried",
  );
  assert.equal(
    CapabilityManifestSchema.safeParse({
      ...baseManifest,
      failureSemantics: {
        declaredKinds: ["transient_external_failure"],
        retryableKinds: ["transient_external_failure"],
        maxAttempts: 2,
      },
      idempotency: { mode: "none" },
    }).success,
    false,
    "automatic retries require idempotency",
  );

  const memory = {
    id: "memory-1",
    kind: "semantic" as const,
    scope: { tenantId: "tenant-1", principalId: "user-1" },
    entityRefs: ["entity-1"],
    content: { preference: "CNY" },
    sourceEvidenceRefs: ["evidence-1"],
    confidence: 0.95,
    sensitivity: "confidential" as const,
    approvalStatus: "approved" as const,
    supersedes: [],
    conflictsWith: [],
    createdAt: "2026-08-09T08:00:00+08:00",
    owner: principal,
  };
  assert.equal(MemoryRecordV2Schema.safeParse(memory).success, true);
  assert.equal(MemoryRecordV2Schema.safeParse({ ...memory, scope: {} }).success, false);
  assert.equal(
    MemoryRecordV2Schema.safeParse({ ...memory, expiresAt: "2026-08-09T07:00:00+08:00" }).success,
    false,
  );

  assert.equal(ResourceBudgetSchema.parse({}).concurrency, 1);
  assert.equal(ResourceBudgetSchema.safeParse({ retryLimit: -1 }).success, false);
  assert.equal(
    PolicyDecisionSchema.safeParse({
      id: "policy-decision-1",
      principal,
      caseId: "case-1",
      capabilityId: "spreadsheet.read",
      artifactVersionIds: [artifact.versionId],
      classification: "confidential",
      egress: false,
      decision: "allow",
      reason: "Local-only read permitted by task policy.",
      createdAt: "2026-08-09T08:00:00+08:00",
    }).success,
    true,
  );

  console.log("capability-contracts: all checks passed ✓");
})();

if (process.argv[1]?.includes("capability-contracts.test")) {
  capabilityContractsTestPromise.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
