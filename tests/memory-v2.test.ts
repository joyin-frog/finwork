import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import { SecurityAuthorizer } from "../lib/security/index.ts";
import {
  correctManualMemoryContent,
  correctGovernedMemory,
  createGovernedMemoryCandidate,
  createManualMemoryConflictKey,
  createManualMemoryContent,
  GovernedMemoryStore,
  MemorySourceEvidenceService,
  readManualMemoryContent,
  type MemoryCandidate,
} from "../lib/memory-v2/index.ts";

const OWNER = { id: "user-1", type: "user" as const, tenantId: "tenant-1" };
const CREATED_AT = "2026-01-02T00:00:00.000Z";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  new SecurityAuthorizer(db).grant({
    id: "memory-v2-source-write",
    principal: OWNER,
    tenantId: OWNER.tenantId,
    capabilityId: "memory.capture-user-statement",
    actions: ["write"],
    createdAt: CREATED_AT,
  });
  return db;
}

function candidate(
  id: string,
  content: MemoryCandidate["record"]["content"],
  options: Partial<MemoryCandidate["record"]> & { conflictKey?: string } = {},
): MemoryCandidate {
  return {
    conflictKey: options.conflictKey ?? "entity-1:tax-rate",
    record: {
      id,
      kind: options.kind ?? "semantic",
      scope: options.scope ?? { tenantId: "tenant-1", roleId: "tax" },
      entityRefs: options.entityRefs ?? ["entity-1"],
      effectivePeriod: options.effectivePeriod ?? { start: "2026-01-01", end: "2026-12-31" },
      content,
      sourceEvidenceRefs: options.sourceEvidenceRefs ?? [`evidence-${id}`],
      confidence: options.confidence ?? 0.95,
      sensitivity: options.sensitivity ?? "confidential",
      createdAt: options.createdAt ?? CREATED_AT,
      expiresAt: options.expiresAt,
      owner: options.owner ?? OWNER,
    },
  };
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    principal: OWNER,
    tenantId: "tenant-1",
    roleId: "tax",
    entityRefs: ["entity-1"],
    effectivePeriod: { start: "2026-01-01", end: "2026-12-31" },
    kinds: [],
    maximumSensitivity: "confidential" as const,
    minimumConfidence: 0,
    limit: 20,
    now: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

export const memoryV2TestPromise = (async () => {
  const db = makeDb();
  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-memory-evidence-"));
  try {
    const store = new GovernedMemoryStore(db);

    assert.equal(
      createManualMemoryConflictKey("semantic", " 月结   报表口径 "),
      createManualMemoryConflictKey("semantic", "月结 报表口径"),
      "manual memories with the same normalized topic must share a conflict key",
    );
    assert.notEqual(
      createManualMemoryConflictKey("feedback", "月结 报表口径"),
      createManualMemoryConflictKey("semantic", "月结 报表口径"),
      "memory kind remains part of the conflict domain",
    );
    const manual = createManualMemoryContent(" 月结   报表口径 ", " 采用审定数。 ");
    assert.deepEqual(manual, { topic: "月结 报表口径", summary: "采用审定数。" });
    const correctedManual = correctManualMemoryContent(manual, "采用复核后的审定数。");
    assert.deepEqual(readManualMemoryContent(correctedManual), {
      topic: "月结 报表口径",
      summary: "采用复核后的审定数。",
    });

    const captured = new MemorySourceEvidenceService(db, casRoot).captureUserStatement({
      content: "  用户确认本期税率为 6%。  ",
      kind: "create",
      principal: OWNER,
      sensitivity: "confidential",
      memoryId: "memory-source-backed",
      at: CREATED_AT,
    });
    assert.equal(captured.artifact.state, "delivered");
    assert.equal(captured.evidence.type, "source");
    assert.deepEqual(captured.evidence.locator, {
      kind: "char_range",
      nodeId: "memory-statement",
      start: 0,
      end: "用户确认本期税率为 6%。".length,
    });
    assert.equal(
      Buffer.from(new ArtifactStore(db, casRoot).read(captured.artifact.versionId)).toString("utf8"),
      "用户确认本期税率为 6%。",
    );
    const caseRow = db.prepare("SELECT state FROM cases WHERE case_id = ?")
      .get(captured.caseId) as { state: string };
    assert.equal(caseRow.state, "delivered");
    const refRow = db.prepare(`
      SELECT ref_type, owner_id FROM artifact_refs WHERE artifact_version_id = ?
    `).get(captured.artifact.versionId) as { ref_type: string; owner_id: string };
    assert.equal(refRow.ref_type, "memory");
    assert.equal(refRow.owner_id, "memory-source-backed");

    const governed = createGovernedMemoryCandidate(db, {
      content: "用户确认本期申报口径采用审定数。",
      principal: OWNER,
      sensitivity: "confidential",
      at: CREATED_AT,
      casRoot,
      candidate: {
        conflictKey: "entity-1:filing-basis",
        record: {
          id: "memory-governed-atomic",
          kind: "semantic",
          scope: { tenantId: "tenant-1", principalId: "user-1" },
          entityRefs: ["entity-1"],
          content: { filingBasis: "audited" },
          confidence: 1,
          sensitivity: "confidential",
          createdAt: CREATED_AT,
          owner: OWNER,
        },
      },
    });
    assert.deepEqual(governed.record.sourceEvidenceRefs, [governed.source.evidence.id]);
    assert.equal(governed.source.artifact.state, "delivered");
    assert.equal(
      (db.prepare("SELECT state FROM cases WHERE case_id = ?").get(governed.source.caseId) as { state: string }).state,
      "delivered",
    );

    const atomicTables = [
      "task_contracts",
      "cases",
      "case_nodes",
      "case_edges",
      "case_checkpoints",
      "artifacts",
      "artifact_versions",
      "artifact_refs",
      "evidence_records",
      "assertion_results",
      "memory_records_v2",
      "memory_access_log_v2",
    ];
    const snapshotCounts = () => Object.fromEntries(atomicTables.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]));
    const beforeRejectedCreate = snapshotCounts();
    assert.throws(() => createGovernedMemoryCandidate(db, {
      content: "这条来源必须随重复候选一起回滚。",
      principal: OWNER,
      sensitivity: "confidential",
      at: "2026-01-02T00:01:00.000Z",
      casRoot,
      candidate: {
        conflictKey: "entity-1:filing-basis",
        record: {
          id: "memory-governed-atomic",
          kind: "semantic",
          scope: { tenantId: "tenant-1", principalId: "user-1" },
          entityRefs: ["entity-1"],
          content: { filingBasis: "draft" },
          confidence: 1,
          sensitivity: "confidential",
          createdAt: "2026-01-02T00:01:00.000Z",
          owner: OWNER,
        },
      },
    }), /UNIQUE constraint failed/);
    assert.deepEqual(snapshotCounts(), beforeRejectedCreate, "failed candidate must roll back source and memory DB rows together");

    const beforeRejectedCorrection = snapshotCounts();
    assert.throws(() => correctGovernedMemory(db, {
      memoryId: governed.record.id,
      sourceContent: "重复内容不得产生孤立纠正来源。",
      correctedContent: governed.record.content,
      principal: OWNER,
      sensitivity: governed.record.sensitivity,
      reason: "内容未变化",
      at: "2026-01-02T00:02:00.000Z",
      casRoot,
    }), /must change content/);
    assert.deepEqual(snapshotCounts(), beforeRejectedCorrection, "failed correction must roll back source and candidate DB rows together");

    const approved = store.createCandidate(candidate("memory-old", { taxRate: 0.06 }));
    store.approve({
      memoryId: approved.id,
      approver: OWNER,
      reason: "user confirmed source-backed tax rate",
      at: "2026-01-03T00:00:00.000Z",
    });
    const conflicting = store.createCandidate(candidate("memory-new", { taxRate: 0.03 }));
    assert.deepEqual(conflicting.conflictsWith, ["memory-old"]);
    assert.equal(store.get("memory-old")?.approvalStatus, "approved");
    assert.equal(store.get("memory-new")?.approvalStatus, "candidate");
    assert.throws(
      () => store.approve({
        memoryId: "memory-new",
        approver: OWNER,
        reason: "attempt implicit overwrite",
        at: "2026-01-04T00:00:00.000Z",
      }),
      /explicit resolution/,
    );
    store.approve({
      memoryId: "memory-new",
      approver: OWNER,
      supersedeIds: ["memory-old"],
      reason: "new evidence explicitly supersedes old rate",
      at: "2026-01-05T00:00:00.000Z",
    });
    assert.equal(store.get("memory-old")?.approvalStatus, "expired");
    assert.equal(store.get("memory-new")?.approvalStatus, "approved");

    const corrected = store.correct({
      memoryId: "memory-new",
      content: { taxRate: 0.025 },
      principal: OWNER,
      reason: "用户纠正税率",
      sourceEvidenceRefs: ["user-correction-1"],
      at: "2026-01-05T12:00:00.000Z",
    });
    assert.equal(corrected.approvalStatus, "candidate");
    assert.ok(corrected.conflictsWith.includes("memory-new"));
    assert.equal(store.get("memory-new")?.approvalStatus, "approved", "correction must not overwrite approved memory");
    assert.equal(store.list({ statuses: ["candidate"] }).some((item) => item.id === corrected.id), true);
    assert.equal(
      store.listAccessLog({ memoryId: "memory-new" }).some((entry) => entry.action === "corrected"),
      true,
    );
    assert.throws(
      () => store.correct({
        memoryId: "memory-new",
        content: { taxRate: 0.03 },
        principal: OWNER,
        reason: "没有变化",
        sourceEvidenceRefs: ["user-correction-2"],
        at: "2026-01-05T13:00:00.000Z",
      }),
      /must change content/,
    );

    assert.deepEqual(store.retrieve(query()).map((item) => item.memory.id), ["memory-new"]);
    assert.deepEqual(store.retrieve(query({ entityRefs: ["entity-2"] })), []);
    assert.deepEqual(store.retrieve(query({ tenantId: "tenant-2", principal: { id: "user-2", type: "user", tenantId: "tenant-2" } })), []);
    assert.ok(store.retrieve(query())[0]?.evidenceRefs.includes("evidence-memory-new"));

    const oldPeriod = store.createCandidate(candidate("memory-old-period", { taxRate: 0.05 }, {
      conflictKey: "entity-1:old-period-tax-rate",
      effectivePeriod: { start: "2025-01-01", end: "2025-12-31" },
      createdAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }));
    store.approve({
      memoryId: oldPeriod.id,
      approver: OWNER,
      reason: "confirmed for 2025 only",
      at: "2025-01-02T00:00:00.000Z",
    });
    assert.deepEqual(store.retrieve(query()).map((item) => item.memory.id), ["memory-new"]);
    assert.equal(store.get(oldPeriod.id)?.approvalStatus, "expired");

    const restricted = store.createCandidate(candidate("memory-restricted", { bankAccount: "secret" }, {
      conflictKey: "entity-1:bank-account",
      sensitivity: "restricted",
      effectivePeriod: undefined,
    }));
    store.approve({
      memoryId: restricted.id,
      approver: OWNER,
      reason: "user-owned restricted profile",
      at: "2026-01-06T00:00:00.000Z",
    });
    assert.equal(store.retrieve(query({ maximumSensitivity: "confidential" })).some((item) => item.memory.id === restricted.id), false);
    assert.equal(store.retrieve(query({ maximumSensitivity: "restricted" })).some((item) => item.memory.id === restricted.id), true);

    const procedure = store.createCandidate(candidate("memory-procedure", { steps: ["read", "validate"] }, {
      kind: "procedural",
      conflictKey: "procedure:workbook-review",
      effectivePeriod: undefined,
    }));
    assert.throws(
      () => store.approve({
        memoryId: procedure.id,
        approver: OWNER,
        reason: "no eval evidence",
        at: "2026-01-07T00:00:00.000Z",
      }),
      /passed eval or golden evidence/,
    );

    const retained = store.requestDeletion({
      memoryId: restricted.id,
      requester: OWNER,
      at: "2026-08-09T01:00:00.000Z",
      retentionReason: "statutory audit hold until 2027-12-31",
    });
    assert.equal(retained.status, "retained");
    assert.equal(store.get(restricted.id)?.approvalStatus, "archived");
    assert.equal(store.retrieve(query({ maximumSensitivity: "restricted" })).some((item) => item.memory.id === restricted.id), false);
    assert.equal(store.listAccessLog({ memoryId: restricted.id }).some((entry) => entry.action === "archived"), true);
    assert.deepEqual(store.listRetentionDecisions({ memoryIds: [restricted.id] }).map((decision) => ({
      memoryId: decision.memoryId,
      status: decision.status,
      retentionReason: decision.retentionReason,
    })), [{
      memoryId: restricted.id,
      status: "retained",
      retentionReason: "statutory audit hold until 2027-12-31",
    }]);
    store.restoreArchived(
      restricted.id,
      OWNER,
      "statutory hold released",
      "2026-08-09T01:30:00.000Z",
    );
    assert.equal(store.get(restricted.id)?.approvalStatus, "approved");
    assert.equal(store.retrieve(query({ maximumSensitivity: "restricted" })).some((item) => item.memory.id === restricted.id), true);

    const deleted = store.requestDeletion({
      memoryId: "memory-new",
      requester: OWNER,
      at: "2026-08-09T02:00:00.000Z",
    });
    assert.equal(deleted.status, "completed");
    assert.match(deleted.status === "completed" ? deleted.proof : "", /^[a-f0-9]{64}$/);
    assert.equal(store.get("memory-new"), undefined);
    assert.equal(
      store.get(corrected.id)?.conflictsWith.includes("memory-new"),
      false,
      "deletion must remove exact relation references from linked memories",
    );
    const proofRow = db.prepare(`
      SELECT status, deletion_proof FROM memory_deletion_requests_v2 WHERE request_id = ?
    `).get(deleted.requestId) as { status: string; deletion_proof: string };
    assert.equal(proofRow.status, "completed");
    assert.equal(proofRow.deletion_proof, deleted.status === "completed" ? deleted.proof : "");

    console.log("memory-v2: conflicts, scope, period, sensitivity, approval and deletion proof passed ✓");
  } finally {
    db.close();
    fs.rmSync(casRoot, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("memory-v2.test")) {
  memoryV2TestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
