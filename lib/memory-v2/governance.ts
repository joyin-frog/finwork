import type { DatabaseSync } from "node:sqlite";
import type { PrincipalRef } from "@/lib/capability/common";
import { withSqliteSavepoint } from "@/lib/db/transaction";
import type { DataClassification } from "@/lib/security/contracts";
import type { MemoryCandidate, MemoryRecordV2 } from "./contracts";
import { MemorySourceEvidenceService, type CapturedMemorySource } from "./source-evidence";
import { GovernedMemoryStore } from "./store";

export type GovernedMemoryWriteResult = {
  record: MemoryRecordV2;
  source: CapturedMemorySource;
};

type GovernedMemoryCandidateInput = Omit<MemoryCandidate, "record"> & {
  record: Omit<MemoryCandidate["record"], "sourceEvidenceRefs">;
};

/** Atomically binds immutable source evidence and its reviewable memory candidate. */
export function createGovernedMemoryCandidate(
  db: DatabaseSync,
  input: {
    content: string;
    principal: PrincipalRef;
    sensitivity: DataClassification;
    candidate: GovernedMemoryCandidateInput;
    at?: string;
    casRoot?: string;
  },
): GovernedMemoryWriteResult {
  return withSqliteSavepoint(db, "governed_memory_create", () => {
    const source = new MemorySourceEvidenceService(db, input.casRoot).captureUserStatement({
      content: input.content,
      kind: "create",
      principal: input.principal,
      sensitivity: input.sensitivity,
      memoryId: input.candidate.record.id,
      at: input.at,
    });
    const record = new GovernedMemoryStore(db).createCandidate({
      ...input.candidate,
      record: { ...input.candidate.record, sourceEvidenceRefs: [source.evidence.id] },
    });
    return { record, source };
  });
}

/** Atomically binds correction evidence and the replacement candidate. */
export function correctGovernedMemory(
  db: DatabaseSync,
  input: {
    memoryId: string;
    sourceContent: string;
    correctedContent: MemoryRecordV2["content"];
    principal: PrincipalRef;
    sensitivity: DataClassification;
    reason: string;
    at: string;
    casRoot?: string;
  },
): GovernedMemoryWriteResult {
  return withSqliteSavepoint(db, "governed_memory_correct", () => {
    const source = new MemorySourceEvidenceService(db, input.casRoot).captureUserStatement({
      content: input.sourceContent,
      kind: "correction",
      principal: input.principal,
      sensitivity: input.sensitivity,
      memoryId: input.memoryId,
      at: input.at,
    });
    const record = new GovernedMemoryStore(db).correct({
      memoryId: input.memoryId,
      content: input.correctedContent,
      principal: input.principal,
      reason: input.reason,
      sourceEvidenceRefs: [source.evidence.id],
      at: input.at,
    });
    return { record, source };
  });
}
