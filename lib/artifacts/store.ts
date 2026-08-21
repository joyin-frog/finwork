import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { withSqliteSavepoint } from "@/lib/db/transaction";
import { ArtifactRefSchema, ArtifactStateSchema, type ArtifactRef, type ArtifactState } from "./contracts";

type Classification = "public" | "internal" | "confidential" | "restricted";

export type PutArtifactRequest = {
  artifactId?: string;
  kind: string;
  logicalName: string;
  ownerCaseId?: string;
  classification: Classification;
  retention: unknown;
  mediaType: string;
  producer: unknown;
  metadata?: unknown;
  content: Uint8Array;
  state?: Extract<ArtifactState, "staging" | "candidate">;
  /**
   * 默认写入后立即成为 Artifact 的当前版本。生产索引等需要两阶段提交的调用方
   * 可设为 false，待派生物验证成功后再在业务事务中调用 activateVersion。
   */
  makeCurrent?: boolean;
};

const ALLOWED_TRANSITIONS: Readonly<Record<ArtifactState, readonly ArtifactState[]>> = {
  staging: ["candidate", "tombstoned"],
  candidate: ["delivered", "archived", "tombstoned"],
  delivered: ["archived"],
  archived: ["tombstoned"],
  tombstoned: [],
};

export class ArtifactStore {
  readonly casRoot: string;

  constructor(readonly db: DatabaseSync, root: string) {
    this.casRoot = path.resolve(root);
    fs.mkdirSync(this.casRoot, { recursive: true });
  }

  put(request: PutArtifactRequest): ArtifactRef {
    const artifactId = request.artifactId ?? randomUUID();
    const existing = this.db.prepare(`
      SELECT lifecycle_state FROM artifacts WHERE artifact_id = ?
    `).get(artifactId) as { lifecycle_state: ArtifactState } | undefined;
    if (existing?.lifecycle_state === "delivered" || existing?.lifecycle_state === "archived") {
      throw new Error(`artifact ${artifactId} is immutable after delivery`);
    }
    if (existing?.lifecycle_state === "tombstoned") throw new Error(`artifact ${artifactId} is tombstoned`);

    const state = ArtifactStateSchema.parse(request.state ?? "staging");
    const makeCurrent = request.makeCurrent ?? true;
    const sha256 = createHash("sha256").update(request.content).digest("hex");
    const targetDir = path.join(this.casRoot, sha256.slice(0, 2));
    const targetPath = path.join(targetDir, sha256);
    fs.mkdirSync(targetDir, { recursive: true });
    if (!fs.existsSync(targetPath)) this.atomicWrite(targetPath, request.content, sha256);

    const versionRow = this.db.prepare(`
      SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM artifact_versions WHERE artifact_id = ?
    `).get(artifactId) as { version_no: number };
    const versionId = randomUUID();
    const now = new Date().toISOString();
    withSqliteSavepoint(this.db, "artifact_put", () => {
      this.db.prepare(`
        INSERT INTO artifacts
          (artifact_id, kind, logical_name, owner_case_id, classification, lifecycle_state,
           current_version_id, retention_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          retention_json=excluded.retention_json,
          updated_at=excluded.updated_at
      `).run(
        artifactId,
        request.kind,
        request.logicalName,
        request.ownerCaseId ?? null,
        request.classification,
        state,
        canonicalJson(request.retention),
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO artifact_versions
          (version_id, artifact_id, version_no, sha256, size_bytes, media_type, cas_uri,
           state, producer_json, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        artifactId,
        versionRow.version_no,
        sha256,
        request.content.byteLength,
        request.mediaType,
        `cas://${sha256}`,
        state,
        canonicalJson(request.producer),
        canonicalJson(request.metadata ?? {}),
        now,
      );
      if (makeCurrent) {
        this.db.prepare(`
          UPDATE artifacts
          SET logical_name = ?, current_version_id = ?, lifecycle_state = ?, updated_at = ?
          WHERE artifact_id = ?
        `).run(request.logicalName, versionId, state, now, artifactId);
      }
    });
    return ArtifactRefSchema.parse({
      artifactId,
      versionId,
      sha256,
      mediaType: request.mediaType,
      logicalName: request.logicalName,
      state,
    });
  }

  activateVersion(
    versionId: string,
    to: Extract<ArtifactState, "candidate"> = "candidate",
    options: { inTransaction?: boolean } = {},
  ): ArtifactRef {
    const row = this.db.prepare(`
      SELECT v.artifact_id, v.version_id, v.sha256, v.media_type,
             a.logical_name, a.lifecycle_state
      FROM artifact_versions v
      JOIN artifacts a ON a.artifact_id=v.artifact_id
      WHERE v.version_id=?
    `).get(versionId) as {
      artifact_id: string;
      version_id: string;
      sha256: string;
      media_type: string;
      logical_name: string;
      lifecycle_state: ArtifactState;
    } | undefined;
    if (!row) throw new Error(`artifact version not found: ${versionId}`);
    if (row.lifecycle_state === "delivered" || row.lifecycle_state === "archived" || row.lifecycle_state === "tombstoned") {
      throw new Error(`artifact ${row.artifact_id} is immutable in state ${row.lifecycle_state}`);
    }
    const now = new Date().toISOString();
    const activate = () => {
      this.db.prepare(`
        UPDATE artifact_versions SET state=? WHERE version_id=?
      `).run(to, versionId);
      this.db.prepare(`
        UPDATE artifacts
        SET current_version_id=?, lifecycle_state=?, updated_at=?
        WHERE artifact_id=?
      `).run(versionId, to, now, row.artifact_id);
    };
    if (options.inTransaction) activate();
    else withSqliteSavepoint(this.db, "artifact_activate", activate);
    return ArtifactRefSchema.parse({
      artifactId: row.artifact_id,
      versionId: row.version_id,
      sha256: row.sha256,
      mediaType: row.media_type,
      logicalName: row.logical_name,
      state: to,
    });
  }

  transition(artifactId: string, to: ArtifactState): ArtifactRef {
    ArtifactStateSchema.parse(to);
    const row = this.db.prepare(`
      SELECT a.lifecycle_state, a.logical_name, v.version_id, v.sha256, v.media_type
      FROM artifacts a JOIN artifact_versions v ON v.version_id = a.current_version_id
      WHERE a.artifact_id = ?
    `).get(artifactId) as {
      lifecycle_state: ArtifactState;
      logical_name: string;
      version_id: string;
      sha256: string;
      media_type: string;
    } | undefined;
    if (!row) throw new Error(`artifact not found: ${artifactId}`);
    if (to !== row.lifecycle_state && !ALLOWED_TRANSITIONS[row.lifecycle_state].includes(to)) {
      throw new Error(`illegal artifact transition: ${row.lifecycle_state} -> ${to}`);
    }
    const now = new Date().toISOString();
    withSqliteSavepoint(this.db, "artifact_transition", () => {
      this.db.prepare("UPDATE artifacts SET lifecycle_state = ?, updated_at = ? WHERE artifact_id = ?")
        .run(to, now, artifactId);
      this.db.prepare("UPDATE artifact_versions SET state = ? WHERE version_id = ?")
        .run(to, row.version_id);
    });
    return ArtifactRefSchema.parse({
      artifactId,
      versionId: row.version_id,
      sha256: row.sha256,
      mediaType: row.media_type,
      logicalName: row.logical_name,
      state: to,
    });
  }

  addRef(versionId: string, refType: string, ownerId: string, locator?: unknown): string {
    const refId = randomUUID();
    this.db.prepare(`
      INSERT INTO artifact_refs(ref_id, artifact_version_id, ref_type, owner_id, locator_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(refId, versionId, refType, ownerId, locator === undefined ? null : canonicalJson(locator), new Date().toISOString());
    return refId;
  }

  addEdge(fromVersionId: string, toVersionId: string, relation: string, metadata: unknown = {}): string {
    const edgeId = randomUUID();
    this.db.prepare(`
      INSERT INTO artifact_edges(edge_id, from_version_id, to_version_id, relation, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(edgeId, fromVersionId, toVersionId, relation, canonicalJson(metadata), new Date().toISOString());
    return edgeId;
  }

  read(versionId: string): Uint8Array {
    const row = this.db.prepare("SELECT sha256 FROM artifact_versions WHERE version_id = ?")
      .get(versionId) as { sha256: string } | undefined;
    if (!row) throw new Error(`artifact version not found: ${versionId}`);
    const content = fs.readFileSync(path.join(this.casRoot, row.sha256.slice(0, 2), row.sha256));
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== row.sha256) throw new Error("CAS integrity mismatch");
    return content;
  }

  private atomicWrite(targetPath: string, content: Uint8Array, expectedHash: string): void {
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const actual = createHash("sha256").update(fs.readFileSync(tempPath)).digest("hex");
    if (actual !== expectedHash) {
      fs.unlinkSync(tempPath);
      throw new Error("CAS write hash mismatch");
    }
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (fs.existsSync(targetPath)) fs.unlinkSync(tempPath);
      else throw error;
    }
    const dirFd = fs.openSync(path.dirname(targetPath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}
