import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "@/lib/artifacts/store";
import type { ArtifactRef } from "@/lib/artifacts/contracts";
import type { DataClassification } from "./contracts";
import { inspectFileSafety } from "./file-inspection";

export type FileScanResult = {
  verdict: "clean" | "malicious" | "scan_failed" | "policy_blocked";
  scannerId: string;
  reasonCode?: string;
};
export interface FileScanner { scan(content: Uint8Array, fileName: string): Promise<FileScanResult>; }

export function resolveSafeRegularFile(filePath: string, allowedRoot: string): string {
  const lexicalRoot = path.resolve(allowedRoot);
  const requested = path.resolve(filePath);
  const relativeRequested = path.relative(lexicalRoot, requested);
  if (relativeRequested.startsWith("..") || path.isAbsolute(relativeRequested)) throw new Error("file path escapes allowed root");
  const root = fs.realpathSync(lexicalRoot);
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink()) throw new Error("symbolic links are not accepted for ingestion");
  if (!stat.isFile()) throw new Error("ingestion source must be a regular file");
  const real = fs.realpathSync(requested);
  const relativeReal = path.relative(root, real);
  if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) throw new Error("resolved file path escapes allowed root");
  return real;
}

export class QuarantineService {
  constructor(readonly db: DatabaseSync, readonly artifacts: ArtifactStore) {}

  stage(input: {
    filePath: string; allowedRoot: string; caseId?: string; classification: DataClassification;
    retention: unknown; producer: unknown; mediaType: string;
  }): { quarantineId: string; artifact: ArtifactRef } {
    const safePath = resolveSafeRegularFile(input.filePath, input.allowedRoot);
    const content = fs.readFileSync(safePath);
    const artifact = this.artifacts.put({ kind: "quarantined_file", logicalName: path.basename(safePath),
      ownerCaseId: input.caseId, classification: input.classification, retention: input.retention,
      mediaType: input.mediaType, producer: input.producer,
      metadata: { quarantine: true, sourcePathHash: createHash("sha256").update(safePath).digest("hex") }, content, state: "staging" });
    const quarantineId = randomUUID();
    this.db.prepare(`INSERT INTO quarantine_items
      (quarantine_id, artifact_id, artifact_version_id, source_path_hash, verdict, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(quarantineId, artifact.artifactId, artifact.versionId,
        createHash("sha256").update(safePath).digest("hex"), new Date().toISOString());
    return { quarantineId, artifact };
  }

  async scan(quarantineId: string, scanner: FileScanner | null, now: string): Promise<FileScanResult> {
    const row = this.db.prepare(`
      SELECT q.artifact_id, q.artifact_version_id, q.verdict, a.logical_name, v.media_type
      FROM quarantine_items q
      JOIN artifacts a ON a.artifact_id=q.artifact_id
      JOIN artifact_versions v ON v.version_id=q.artifact_version_id
      WHERE q.quarantine_id = ?
    `).get(quarantineId) as {
      artifact_id: string;
      artifact_version_id: string;
      verdict: string;
      logical_name: string;
      media_type: string;
    } | undefined;
    if (!row) throw new Error("quarantine item not found");
    if (row.verdict !== "pending") throw new Error("quarantine item already scanned");
    let result: FileScanResult;
    let inspectionJson: string | null = null;
    if (!scanner) result = { verdict: "scan_failed", scannerId: "unavailable", reasonCode: "scanner_unavailable" };
    else {
      try { result = await scanner.scan(this.artifacts.read(row.artifact_version_id), row.logical_name); }
      catch { result = { verdict: "scan_failed", scannerId: "failed", reasonCode: "scanner_error" }; }
    }
    if (result.verdict === "clean") {
      const manifest = await inspectFileSafety(
        this.artifacts.read(row.artifact_version_id),
        row.logical_name,
        row.media_type,
      );
      inspectionJson = JSON.stringify(manifest);
      if (manifest.decision !== "clean") {
        result = {
          verdict: "policy_blocked",
          scannerId: result.scannerId,
          reasonCode: manifest.findings[0]?.code ?? "file_policy_blocked",
        };
      }
    }
    this.db.prepare(`UPDATE quarantine_items SET verdict=?, scanner_id=?, reason_code=?, inspection_json=?, scanned_at=?, released_at=?
      WHERE quarantine_id=?`).run(result.verdict, result.scannerId, result.reasonCode ?? null, inspectionJson, now,
        result.verdict === "clean" ? now : null, quarantineId);
    if (result.verdict === "clean") this.artifacts.transition(row.artifact_id, "candidate");
    return result;
  }
}
