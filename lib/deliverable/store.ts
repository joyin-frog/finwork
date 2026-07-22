/**
 * Deliverable registry store — interface + memory + sqlite。
 * 不写 Run completed；CompletionEvidence 经 EvidenceSink 提交。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CompletionEvidence } from "@/lib/agent/run-contract";
import type { DeliverableRecord, DeliverableStatus } from "./types";

export interface DeliverableStore {
  upsert(record: DeliverableRecord): void;
  get(id: string): DeliverableRecord | null;
  listByRun(runId: string): DeliverableRecord[];
  /**
   * 原子提交：registry delivered + evidence。
   * 任一步失败应抛错且不留下半 delivered 状态（sqlite 事务 / memory 回滚）。
   */
  commitDelivered(args: {
    record: DeliverableRecord;
    evidence: CompletionEvidence;
  }): void;
}

export interface CompletionEvidenceSink {
  /** 只提交 Evidence，绝不写 Run completed。 */
  submit(evidence: CompletionEvidence): void;
  list(runId: string): CompletionEvidence[];
}

export function createDeliverableRecord(
  partial: Omit<DeliverableRecord, "id" | "createdAt" | "validatedAt" | "deliveredAt" | "status"> & {
    id?: string;
    status?: DeliverableStatus;
    createdAt?: string;
    validatedAt?: string | null;
    deliveredAt?: string | null;
  }
): DeliverableRecord {
  return {
    id: partial.id ?? randomUUID(),
    runId: partial.runId,
    contractDeliverableId: partial.contractDeliverableId,
    workingPath: partial.workingPath,
    deliveredPath: partial.deliveredPath,
    fileName: partial.fileName,
    mimeType: partial.mimeType,
    sizeBytes: partial.sizeBytes,
    workingSha256: partial.workingSha256,
    deliveredSha256: partial.deliveredSha256,
    validatorId: partial.validatorId,
    qualityProfile: partial.qualityProfile,
    validationReportJson: partial.validationReportJson,
    status: partial.status ?? "working",
    createdAt: partial.createdAt ?? new Date().toISOString(),
    validatedAt: partial.validatedAt ?? null,
    deliveredAt: partial.deliveredAt ?? null,
  };
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export class MemoryDeliverableStore implements DeliverableStore, CompletionEvidenceSink {
  private records = new Map<string, DeliverableRecord>();
  private evidences: CompletionEvidence[] = [];

  upsert(record: DeliverableRecord): void {
    this.records.set(record.id, { ...record });
  }

  get(id: string): DeliverableRecord | null {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }

  listByRun(runId: string): DeliverableRecord[] {
    return [...this.records.values()].filter((r) => r.runId === runId).map((r) => ({ ...r }));
  }

  commitDelivered(args: { record: DeliverableRecord; evidence: CompletionEvidence }): void {
    // 模拟事务：先写副本，成功后再替换
    const prev = this.records.get(args.record.id);
    const prevEv = this.evidences.slice();
    try {
      if (args.record.status !== "delivered" || !args.record.deliveredPath || !args.record.deliveredSha256) {
        throw new Error("commitDelivered requires delivered status + path + sha256");
      }
      if (args.evidence.validationStatus !== "passed") {
        throw new Error("evidence.validationStatus must be passed");
      }
      this.records.set(args.record.id, { ...args.record });
      this.evidences.push({ ...args.evidence });
    } catch (e) {
      if (prev) this.records.set(args.record.id, prev);
      else this.records.delete(args.record.id);
      this.evidences = prevEv;
      throw e;
    }
  }

  submit(evidence: CompletionEvidence): void {
    if (evidence.validationStatus !== "passed") {
      throw new Error("CompletionEvidence.validationStatus must be passed");
    }
    this.evidences.push({ ...evidence });
  }

  list(runId: string): CompletionEvidence[] {
    return this.evidences.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }
}

// ─── SQLite ─────────────────────────────────────────────────────────────────

export class SqliteDeliverableStore implements DeliverableStore, CompletionEvidenceSink {
  constructor(private readonly db: DatabaseSync) {}

  upsert(record: DeliverableRecord): void {
    this.db
      .prepare(
        `INSERT INTO deliverables (
          id, run_id, contract_deliverable_id, working_path, delivered_path,
          file_name, mime_type, size_bytes, working_sha256, delivered_sha256,
          validator_id, quality_profile, validation_report_json, status,
          created_at, validated_at, delivered_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          working_path=excluded.working_path,
          delivered_path=excluded.delivered_path,
          file_name=excluded.file_name,
          mime_type=excluded.mime_type,
          size_bytes=excluded.size_bytes,
          working_sha256=excluded.working_sha256,
          delivered_sha256=excluded.delivered_sha256,
          validator_id=excluded.validator_id,
          quality_profile=excluded.quality_profile,
          validation_report_json=excluded.validation_report_json,
          status=excluded.status,
          validated_at=excluded.validated_at,
          delivered_at=excluded.delivered_at`
      )
      .run(
        record.id,
        record.runId,
        record.contractDeliverableId,
        record.workingPath,
        record.deliveredPath,
        record.fileName,
        record.mimeType,
        record.sizeBytes,
        record.workingSha256,
        record.deliveredSha256,
        record.validatorId,
        record.qualityProfile,
        record.validationReportJson,
        record.status,
        record.createdAt,
        record.validatedAt,
        record.deliveredAt
      );
  }

  get(id: string): DeliverableRecord | null {
    const row = this.db.prepare("SELECT * FROM deliverables WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByRun(runId: string): DeliverableRecord[] {
    const rows = this.db.prepare("SELECT * FROM deliverables WHERE run_id = ?").all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  commitDelivered(args: { record: DeliverableRecord; evidence: CompletionEvidence }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsert(args.record);
      this.insertEvidence(args.evidence);
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  submit(evidence: CompletionEvidence): void {
    this.insertEvidence(evidence);
  }

  list(runId: string): CompletionEvidence[] {
    const rows = this.db
      .prepare("SELECT * FROM completion_evidence WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToEvidence);
  }

  private insertEvidence(evidence: CompletionEvidence): void {
    if (evidence.validationStatus !== "passed") {
      throw new Error("CompletionEvidence.validationStatus must be passed");
    }
    this.db
      .prepare(
        `INSERT INTO completion_evidence (
          id, run_id, contract_deliverable_id, delivered_path, delivered_sha256,
          mime, validator_id, quality_profile, validation_status, validated_at, report_id, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        evidence.reportId,
        evidence.runId,
        evidence.contractDeliverableId,
        evidence.deliveredPath,
        evidence.deliveredSha256,
        evidence.mime,
        evidence.validatorId,
        evidence.qualityProfile,
        evidence.validationStatus,
        evidence.validatedAt,
        evidence.reportId,
        new Date().toISOString()
      );
  }
}

function rowToRecord(row: Record<string, unknown>): DeliverableRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    contractDeliverableId: String(row.contract_deliverable_id),
    workingPath: (row.working_path as string) ?? null,
    deliveredPath: (row.delivered_path as string) ?? null,
    fileName: String(row.file_name),
    mimeType: (row.mime_type as string) ?? null,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    workingSha256: (row.working_sha256 as string) ?? null,
    deliveredSha256: (row.delivered_sha256 as string) ?? null,
    validatorId: (row.validator_id as string) ?? null,
    qualityProfile: (row.quality_profile as DeliverableRecord["qualityProfile"]) ?? null,
    validationReportJson: (row.validation_report_json as string) ?? null,
    status: row.status as DeliverableStatus,
    createdAt: String(row.created_at),
    validatedAt: (row.validated_at as string) ?? null,
    deliveredAt: (row.delivered_at as string) ?? null,
  };
}

function rowToEvidence(row: Record<string, unknown>): CompletionEvidence {
  return {
    runId: String(row.run_id),
    contractDeliverableId: String(row.contract_deliverable_id),
    deliveredPath: String(row.delivered_path),
    deliveredSha256: String(row.delivered_sha256),
    mime: String(row.mime),
    validatorId: String(row.validator_id),
    qualityProfile: String(row.quality_profile),
    validationStatus: "passed",
    validatedAt: String(row.validated_at),
    reportId: String(row.report_id),
  };
}
