import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withSqliteSavepoint } from "@/lib/db/transaction";
import { getFileWorkspaceDir } from "@/lib/runtime/paths";
import {
  decryptBytes,
  decryptStringFields,
  encryptBytes,
  encryptStringFields,
  privateContentId,
  privateStringId,
} from "./crypto";
import type {
  PreparedWorkspaceFile,
  WorkspaceAssetRef,
  WorkspaceFileRole,
  WorkspaceRootRef,
  WorkspaceSourceKind,
} from "./types";

const MIN_CHUNK = 256 * 1024;
const AVG_CHUNK_MASK = (1 << 20) - 1;
const MAX_CHUNK = 4 * 1024 * 1024;
const RUN_WORKSPACE_RETENTION_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SKIP_DIRS = new Set([".git", ".svn", "node_modules", ".next", "target", "__pycache__"]);

type BlobRecord = { blobId: string; sizeBytes: number };

export class FileWorkspaceVersionError extends Error {
  readonly code: "missing_base_version" | "stale_base_version" | "invalid_parent_version";

  constructor(
    code: FileWorkspaceVersionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "FileWorkspaceVersionError";
    this.code = code;
  }
}

export class FileWorkspaceStore {
  readonly root: string;
  readonly chunksRoot: string;

  constructor(
    readonly db: DatabaseSync,
    root = getFileWorkspaceDir(),
    private readonly masterKey: Uint8Array,
  ) {
    if (masterKey.byteLength !== 32) throw new Error("文件工作区主密钥必须是 32 字节");
    this.root = path.resolve(root);
    this.chunksRoot = path.join(this.root, "managed", "chunks");
    fs.mkdirSync(this.chunksRoot, { recursive: true, mode: 0o700 });
  }

  ingestManagedBuffer(input: {
    name: string;
    mediaType: string;
    content: Uint8Array;
    sourceKind?: Extract<WorkspaceSourceKind, "managed" | "generated">;
    batchId?: string;
    assetId?: string;
    parentVersionId?: string | null;
    makeCurrent?: boolean;
  }): WorkspaceAssetRef {
    const name = safeName(input.name);
    const now = new Date().toISOString();
    const sourceKind = input.sourceKind ?? "managed";
    const blob = this.putBlob(input.content, input.mediaType);
    const assetId = input.assetId ?? randomUUID();
    const existing = this.db.prepare(
      "SELECT asset_id,current_version_id FROM workspace_assets WHERE asset_id=?",
    ).get(assetId) as { asset_id: string; current_version_id: string | null } | undefined;
    if (existing) {
      if (!input.parentVersionId) {
        throw new FileWorkspaceVersionError(
          "missing_base_version",
          `已有文件资产 ${assetId} 的新候选必须声明 parentVersionId`,
        );
      }
      const parent = this.db.prepare(
        "SELECT asset_id FROM workspace_asset_versions WHERE version_id=?",
      ).get(input.parentVersionId) as { asset_id: string } | undefined;
      if (!parent || parent.asset_id !== assetId) {
        throw new FileWorkspaceVersionError(
          "invalid_parent_version",
          `父版本 ${input.parentVersionId} 不属于文件资产 ${assetId}`,
        );
      }
      if ((input.makeCurrent ?? true) && existing.current_version_id !== input.parentVersionId) {
        throw new FileWorkspaceVersionError(
          "stale_base_version",
          `stale_base_version: 当前版本为 ${existing.current_version_id ?? "none"}，不能从旧版本 ${input.parentVersionId} 重建`,
        );
      }
    } else if (input.parentVersionId) {
      throw new FileWorkspaceVersionError(
        "invalid_parent_version",
        "新文件资产不能引用其它资产的父版本",
      );
    }
    const versionNo = existing
      ? Number((this.db.prepare("SELECT COALESCE(MAX(version_no),0)+1 AS n FROM workspace_asset_versions WHERE asset_id=?").get(assetId) as { n: number }).n)
      : 1;
    const versionId = randomUUID();
    withSqliteSavepoint(this.db, "workspace_ingest", () => {
      if (!existing) {
        this.db.prepare(`
          INSERT INTO workspace_assets
            (asset_id,source_kind,display_name,media_type,batch_id,current_version_id,created_at,updated_at)
          VALUES (?,?,?,?,?,NULL,?,?)
        `).run(assetId, sourceKind, name, input.mediaType, input.batchId ?? null, now, now);
      }
      this.db.prepare(`
        INSERT INTO workspace_asset_versions
          (version_id,asset_id,version_no,blob_id,parent_version_id,source_fingerprint_json,created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(
        versionId,
        assetId,
        versionNo,
        blob.blobId,
        input.parentVersionId ?? null,
        JSON.stringify({ sizeBytes: input.content.byteLength }),
        now,
      );
      if (input.makeCurrent ?? true) {
        this.db.prepare(`
          UPDATE workspace_assets SET display_name=?,media_type=?,current_version_id=?,updated_at=? WHERE asset_id=?
        `).run(name, input.mediaType, versionId, now, assetId);
      }
    });
    return { assetId, versionId, blobId: blob.blobId, name, mediaType: input.mediaType, sizeBytes: blob.sizeBytes, sourceKind };
  }

  registerRoot(input: {
    path: string;
    permission?: "read" | "read_write";
    writePolicy?: "output_subdir" | "confirm_replace";
    outputSubdir?: string;
  }): WorkspaceRootRef {
    const rootPath = canonicalExistingDirectory(input.path);
    const locatorHmac = privateStringId(this.masterKey, normalizedPathKey(rootPath), "root");
    const existing = this.db.prepare("SELECT root_id FROM workspace_roots WHERE locator_hmac=?")
      .get(locatorHmac) as { root_id: string } | undefined;
    const rootId = existing?.root_id ?? randomUUID();
    const displayName = path.basename(rootPath) || rootPath;
    const encrypted = encryptStringFields(this.masterKey, rootPath, `workspace-root:${rootId}`);
    const permission = input.permission ?? "read_write";
    const writePolicy = input.writePolicy ?? "output_subdir";
    const outputSubdir = safeRelativeDirectory(input.outputSubdir ?? "Finwork 输出");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspace_roots
        (root_id,display_name,locator_ciphertext,locator_nonce,locator_tag,locator_hmac,
         permission,write_policy,output_subdir,status,created_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)
      ON CONFLICT(locator_hmac) DO UPDATE SET
        display_name=excluded.display_name,locator_ciphertext=excluded.locator_ciphertext,
        locator_nonce=excluded.locator_nonce,locator_tag=excluded.locator_tag,
        permission=excluded.permission,write_policy=excluded.write_policy,
        output_subdir=excluded.output_subdir,status='active',last_seen_at=excluded.last_seen_at
    `).run(
      rootId, displayName, encrypted.ciphertext, encrypted.nonce, encrypted.tag, locatorHmac,
      permission, writePolicy, outputSubdir, now, now,
    );
    return { rootId, name: displayName, path: rootPath, permission, writePolicy, outputSubdir };
  }

  getRoot(rootId: string): WorkspaceRootRef {
    const row = this.db.prepare(`
      SELECT root_id,display_name,locator_ciphertext,locator_nonce,locator_tag,
             permission,write_policy,output_subdir,status
      FROM workspace_roots WHERE root_id=?
    `).get(rootId) as {
      root_id: string; display_name: string; locator_ciphertext: string; locator_nonce: string; locator_tag: string;
      permission: "read" | "read_write"; write_policy: "output_subdir" | "confirm_replace"; output_subdir: string; status: string;
    } | undefined;
    if (!row || row.status !== "active") throw new Error("文件夹授权不存在或已失效");
    const rootPath = decryptStringFields(this.masterKey, {
      ciphertext: row.locator_ciphertext, nonce: row.locator_nonce, tag: row.locator_tag,
    }, `workspace-root:${row.root_id}`);
    return {
      rootId: row.root_id, name: row.display_name, path: rootPath,
      permission: row.permission, writePolicy: row.write_policy, outputSubdir: row.output_subdir,
    };
  }

  listRoots(): WorkspaceRootRef[] {
    const ids = this.db.prepare("SELECT root_id FROM workspace_roots WHERE status='active' ORDER BY last_seen_at DESC")
      .all() as Array<{ root_id: string }>;
    return ids.flatMap(({ root_id }) => {
      try { return [this.getRoot(root_id)]; }
      catch { return []; }
    });
  }

  indexRoot(rootId: string, options: { maxFiles?: number } = {}): { indexed: number; truncated: boolean; unreadable: number } {
    const root = this.getRoot(rootId);
    const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 50_000, 200_000));
    let indexed = 0;
    let truncated = false;
    let unreadable = 0;
    const visit = (dir: string) => {
      if (truncated) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        unreadable += 1;
        return;
      }
      for (const entry of entries) {
        if (truncated || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (indexed >= maxFiles) { truncated = true; break; }
        const relative = path.relative(root.path, absolute).split(path.sep).join("/");
        try {
          this.upsertExternalAsset(rootId, relative, fs.statSync(absolute));
          indexed += 1;
        } catch {
          unreadable += 1;
        }
      }
    };
    visit(root.path);
    this.db.prepare("UPDATE workspace_roots SET last_seen_at=?,status='active' WHERE root_id=?")
      .run(new Date().toISOString(), rootId);
    return { indexed, truncated, unreadable };
  }

  listAssets(input: { q?: string; rootId?: string; limit?: number } = {}): WorkspaceAssetRef[] {
    const where = ["a.lifecycle_status='active'"];
    const values: Array<string | number> = [];
    if (input.rootId) { where.push("a.workspace_root_id=?"); values.push(input.rootId); }
    if (input.q?.trim()) { where.push("(a.display_name LIKE ? ESCAPE '\\' OR a.relative_path LIKE ? ESCAPE '\\')"); const q = `%${escapeLike(input.q.trim())}%`; values.push(q, q); }
    values.push(Math.max(1, Math.min(input.limit ?? 500, 5_000)));
    const rows = this.db.prepare(`
      SELECT a.asset_id,a.current_version_id,a.display_name,a.media_type,a.source_kind,
             v.blob_id,b.size_bytes,v.source_fingerprint_json
      FROM workspace_assets a
      LEFT JOIN workspace_asset_versions v ON v.version_id=a.current_version_id
      LEFT JOIN workspace_blobs b ON b.blob_id=v.blob_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.updated_at DESC LIMIT ?
    `).all(...values) as Array<{
      asset_id: string; current_version_id: string | null; display_name: string; media_type: string;
      source_kind: WorkspaceSourceKind; blob_id: string | null; size_bytes: number | null; source_fingerprint_json: string | null;
    }>;
    return rows.flatMap((row) => row.current_version_id ? [{
      assetId: row.asset_id,
      versionId: row.current_version_id,
      blobId: row.blob_id,
      name: row.display_name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes ?? fingerprintSize(row.source_fingerprint_json),
      sourceKind: row.source_kind,
    }] : []);
  }

  getAsset(assetId: string): WorkspaceAssetRef {
    return this.assetRef(assetId);
  }

  getVersion(versionId: string): WorkspaceAssetRef {
    const row = this.db.prepare(`
      SELECT v.version_id,v.asset_id,v.blob_id,v.source_fingerprint_json,
             a.display_name,a.media_type,a.source_kind,b.size_bytes
      FROM workspace_asset_versions v
      JOIN workspace_assets a ON a.asset_id=v.asset_id
      LEFT JOIN workspace_blobs b ON b.blob_id=v.blob_id
      WHERE v.version_id=? AND a.lifecycle_status='active'
    `).get(versionId) as {
      version_id: string; asset_id: string; blob_id: string | null; source_fingerprint_json: string;
      display_name: string; media_type: string; source_kind: WorkspaceSourceKind; size_bytes: number | null;
    } | undefined;
    if (!row) throw new Error(`文件版本不存在: ${versionId}`);
    return {
      assetId: row.asset_id,
      versionId: row.version_id,
      blobId: row.blob_id,
      name: row.display_name,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes ?? fingerprintSize(row.source_fingerprint_json),
      sourceKind: row.source_kind,
    };
  }

  snapshotAsset(assetId: string): WorkspaceAssetRef {
    const row = this.assetRow(assetId);
    if (row.source_kind !== "external") return this.assetRef(assetId);
    const filePath = this.resolveExternalAssetPath(assetId);
    const content = fs.readFileSync(filePath);
    const current = this.assetRef(assetId);
    return this.ingestManagedBuffer({
      assetId,
      name: row.display_name,
      mediaType: row.media_type,
      content,
      sourceKind: "managed",
      parentVersionId: current.versionId,
    });
  }

  materializeVersion(versionId: string, targetDir: string, preferredName?: string): string {
    const row = this.db.prepare(`
      SELECT v.blob_id,a.display_name FROM workspace_asset_versions v
      JOIN workspace_assets a ON a.asset_id=v.asset_id WHERE v.version_id=?
    `).get(versionId) as { blob_id: string | null; display_name: string } | undefined;
    if (!row) throw new Error(`文件版本不存在: ${versionId}`);
    if (!row.blob_id) throw new Error("外部文件必须先快照才能进入任务工作区");
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const outputPath = uniqueMaterializedPath(targetDir, safeName(preferredName ?? row.display_name));
    const temporary = `${outputPath}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      for (const chunk of this.blobChunks(row.blob_id)) {
        const encrypted = fs.readFileSync(chunk.storage_path);
        const plaintext = decryptBytes(this.masterKey, encrypted, `workspace-chunk:${chunk.chunk_id}`);
        fs.writeSync(fd, plaintext);
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, outputPath);
    return outputPath;
  }

  readVersion(versionId: string): Buffer {
    const row = this.db.prepare("SELECT blob_id FROM workspace_asset_versions WHERE version_id=?")
      .get(versionId) as { blob_id: string | null } | undefined;
    if (!row?.blob_id) throw new Error("文件版本没有受管快照");
    return Buffer.concat(this.blobChunks(row.blob_id).map((chunk) => {
      const encrypted = fs.readFileSync(chunk.storage_path);
      return decryptBytes(this.masterKey, encrypted, `workspace-chunk:${chunk.chunk_id}`);
    }));
  }

  prepareRunWorkspace(runId: string, assets: Array<{ assetId: string; role?: WorkspaceFileRole }>): PreparedWorkspaceFile[] {
    const runRoot = path.join(this.root, "runs", runId);
    const runPaths = {
      inputs: path.join(runRoot, "inputs"),
      work: path.join(runRoot, "work"),
      outputs: path.join(runRoot, "outputs"),
    };
    const inputDir = runPaths.inputs;
    for (const dir of [runPaths.inputs, runPaths.work, runPaths.outputs]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const prepared: PreparedWorkspaceFile[] = [];
    for (const item of assets) {
      let ref = this.assetRef(item.assetId);
      if (!ref.blobId) ref = this.snapshotAsset(item.assetId);
      const role = item.role ?? "input";
      const target = this.materializeVersion(ref.versionId, inputDir, ref.name);
      this.addTaskRef(runId, ref.assetId, ref.versionId, role);
      prepared.push({ ...ref, path: target, role });
    }
    return prepared;
  }

  linkTaskFile(runId: string, assetId: string, versionId: string, role: WorkspaceFileRole): void {
    this.addTaskRef(runId, assetId, versionId, role);
  }

  outputDirectoryForRoot(rootId: string): string {
    const root = this.getRoot(rootId);
    if (root.permission !== "read_write") throw new Error("该文件夹仅授权读取");
    const target = path.resolve(root.path, root.outputSubdir);
    assertInside(root.path, target);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
  }

  resolveExternalAssetPath(assetId: string): string {
    const row = this.assetRow(assetId);
    if (!row.workspace_root_id || !row.relative_path) throw new Error("不是外部文件资产");
    const root = this.getRoot(row.workspace_root_id);
    const candidate = path.resolve(root.path, row.relative_path);
    assertInside(root.path, candidate);
    const real = fs.realpathSync.native(candidate);
    assertInside(fs.realpathSync.native(root.path), real);
    if (!fs.statSync(real).isFile()) throw new Error("外部资产不再是普通文件");
    return real;
  }

  applyApprovedReplacement(changesetId: string): void {
    const row = this.db.prepare(`
      SELECT c.status,c.asset_id,c.candidate_version_id,a.workspace_root_id,a.relative_path
      FROM file_changesets c JOIN workspace_assets a ON a.asset_id=c.asset_id
      WHERE c.changeset_id=?
    `).get(changesetId) as {
      status: string; asset_id: string; candidate_version_id: string; workspace_root_id: string | null; relative_path: string | null;
    } | undefined;
    if (!row || row.status !== "approved") throw new Error("只有用户已批准的变更集才能写回原文件");
    if (!row.workspace_root_id || !row.relative_path) throw new Error("目标不是外部工作区文件");
    const root = this.getRoot(row.workspace_root_id);
    if (root.permission !== "read_write" || root.writePolicy !== "confirm_replace") throw new Error("该工作区不允许覆盖原文件");
    const target = this.resolveExternalAssetPath(row.asset_id);
    const tempDir = path.join(path.dirname(target), ".finwork-staging");
    const candidate = this.materializeVersion(row.candidate_version_id, tempDir, path.basename(target));
    const backup = `${target}.finwork-backup-${Date.now()}`;
    try {
      fs.renameSync(target, backup);
      fs.renameSync(candidate, target);
      fs.rmSync(backup, { force: true });
      this.db.prepare("UPDATE workspace_assets SET current_version_id=?,updated_at=? WHERE asset_id=?")
        .run(row.candidate_version_id, new Date().toISOString(), row.asset_id);
      this.db.prepare("UPDATE file_changesets SET status='applied',resolved_at=? WHERE changeset_id=?")
        .run(new Date().toISOString(), changesetId);
    } catch (error) {
      if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
      this.db.prepare("UPDATE file_changesets SET status='failed',resolved_at=? WHERE changeset_id=?")
        .run(new Date().toISOString(), changesetId);
      throw error;
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * 用户批准受管上传文件时切换当前版本；外部 confirm_replace 文件继续使用带备份的
   * 原子替换。output_subdir 外部文件不覆盖原件，只确认候选版本供后续另存交付。
   */
  applyApprovedChangeSet(changesetId: string): void {
    const row = this.db.prepare(`
      SELECT c.status,c.asset_id,c.candidate_version_id,c.validation_json,a.source_kind,a.workspace_root_id
      FROM file_changesets c JOIN workspace_assets a ON a.asset_id=c.asset_id
      WHERE c.changeset_id=?
    `).get(changesetId) as {
      status: string; asset_id: string; candidate_version_id: string;
      validation_json: string; source_kind: WorkspaceSourceKind; workspace_root_id: string | null;
    } | undefined;
    if (!row || row.status !== "approved") throw new Error("只有用户已批准的变更集才能采用");
    if (row.source_kind === "external" && row.workspace_root_id) {
      const root = this.getRoot(row.workspace_root_id);
      if (root.writePolicy === "confirm_replace") {
        this.applyApprovedReplacement(changesetId);
        return;
      }
      let candidateName = this.getVersion(row.candidate_version_id).name;
      try {
        const parsed = JSON.parse(row.validation_json) as { candidateName?: unknown };
        if (typeof parsed.candidateName === "string" && parsed.candidateName.trim()) candidateName = safeName(parsed.candidateName);
      } catch { /* fall back to asset name */ }
      this.materializeVersion(row.candidate_version_id, this.outputDirectoryForRoot(row.workspace_root_id), candidateName);
      this.db.prepare("UPDATE file_changesets SET status='applied',resolved_at=? WHERE changeset_id=?")
        .run(new Date().toISOString(), changesetId);
      return;
    }
    withSqliteSavepoint(this.db, "workspace_apply_change", () => {
      this.db.prepare("UPDATE workspace_assets SET current_version_id=?,updated_at=? WHERE asset_id=?")
        .run(row.candidate_version_id, new Date().toISOString(), row.asset_id);
      this.db.prepare("UPDATE file_changesets SET status='applied',resolved_at=? WHERE changeset_id=?")
        .run(new Date().toISOString(), changesetId);
    });
  }

  collectGarbage(): { blobs: number; chunks: number; bytes: number } {
    const blobs = this.db.prepare(`
      SELECT b.blob_id FROM workspace_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM workspace_asset_versions v WHERE v.blob_id=b.blob_id)
    `).all() as Array<{ blob_id: string }>;
    let removedChunks = 0;
    let bytes = 0;
    withSqliteSavepoint(this.db, "workspace_gc", () => {
      for (const blob of blobs) this.db.prepare("DELETE FROM workspace_blobs WHERE blob_id=?").run(blob.blob_id);
      const chunks = this.db.prepare(`
        SELECT c.chunk_id,c.storage_path,c.size_bytes FROM workspace_chunks c
        WHERE NOT EXISTS (SELECT 1 FROM workspace_blob_chunks bc WHERE bc.chunk_id=c.chunk_id)
      `).all() as Array<{ chunk_id: string; storage_path: string; size_bytes: number }>;
      for (const chunk of chunks) {
        try { fs.rmSync(chunk.storage_path, { force: true }); } catch { /* row still removed; file may already be absent */ }
        this.db.prepare("DELETE FROM workspace_chunks WHERE chunk_id=?").run(chunk.chunk_id);
        removedChunks += 1;
        bytes += chunk.size_bytes;
      }
    });
    return { blobs: blobs.length, chunks: removedChunks, bytes };
  }

  /**
   * 回收仅存在于短期执行区的明文副本。受管密文和外部原文件不在此范围内。
   * 目录名由服务端 runId 创建；符号链接和未到期目录一律跳过。
   */
  purgeStaleRunWorkspaces(maxAgeMs = RUN_WORKSPACE_RETENTION_MS): { directories: number } {
    const runsRoot = path.join(this.root, "runs");
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(runsRoot, { withFileTypes: true }); }
    catch { return { directories: 0 }; }
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let directories = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(runsRoot, entry.name);
      try {
        if (fs.statSync(candidate).mtimeMs > cutoff) continue;
        fs.rmSync(candidate, { recursive: true, force: true });
        directories += 1;
      } catch { /* best effort; retry next startup */ }
    }
    return { directories };
  }

  /**
   * 删除已进入回收站且超过保留期、并且不再被聊天、任务或变更集引用的资产。
   * 随后的 CAS GC 才会删除真正失去引用的密文 chunk。
   */
  purgeExpiredTombstones(maxAgeMs = TOMBSTONE_RETENTION_MS): { assets: number } {
    const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs)).toISOString();
    const result = this.db.prepare(`
      DELETE FROM workspace_assets
      WHERE lifecycle_status='tombstoned' AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM chat_attachments ca WHERE ca.asset_id=workspace_assets.asset_id)
        AND NOT EXISTS (SELECT 1 FROM task_file_refs tr WHERE tr.asset_id=workspace_assets.asset_id)
        AND NOT EXISTS (SELECT 1 FROM file_changesets fc WHERE fc.asset_id=workspace_assets.asset_id)
    `).run(cutoff);
    return { assets: Number(result.changes) };
  }

  maintainStorage(): {
    runDirectories: number;
    tombstonedAssets: number;
    blobs: number;
    chunks: number;
    bytes: number;
  } {
    const runs = this.purgeStaleRunWorkspaces();
    const tombstones = this.purgeExpiredTombstones();
    const garbage = this.collectGarbage();
    return {
      runDirectories: runs.directories,
      tombstonedAssets: tombstones.assets,
      ...garbage,
    };
  }

  private putBlob(content: Uint8Array, mediaType: string): BlobRecord {
    const bytes = Buffer.from(content);
    const blobId = privateContentId(this.masterKey, bytes, "blob");
    const existing = this.db.prepare("SELECT size_bytes FROM workspace_blobs WHERE blob_id=?")
      .get(blobId) as { size_bytes: number } | undefined;
    if (existing) return { blobId, sizeBytes: existing.size_bytes };
    const chunks = contentDefinedChunks(bytes);
    const now = new Date().toISOString();
    const records = chunks.map((chunk) => {
      const chunkId = privateContentId(this.masterKey, chunk, "chunk");
      const storagePath = path.join(this.chunksRoot, chunkId.slice(6, 8), `${chunkId}.fwc`);
      if (!fs.existsSync(storagePath)) atomicEncryptedWrite(storagePath, encryptBytes(this.masterKey, chunk, `workspace-chunk:${chunkId}`));
      return { chunkId, storagePath, sizeBytes: chunk.byteLength };
    });
    withSqliteSavepoint(this.db, "workspace_blob", () => {
      this.db.prepare(`INSERT OR IGNORE INTO workspace_blobs(blob_id,content_hmac,size_bytes,media_type,chunk_count,created_at) VALUES (?,?,?,?,?,?)`)
        .run(blobId, blobId.slice(5), bytes.byteLength, mediaType, records.length, now);
      const insertChunk = this.db.prepare(`INSERT OR IGNORE INTO workspace_chunks(chunk_id,size_bytes,storage_path,created_at) VALUES (?,?,?,?)`);
      const insertLink = this.db.prepare(`INSERT OR IGNORE INTO workspace_blob_chunks(blob_id,ordinal,chunk_id) VALUES (?,?,?)`);
      records.forEach((record, ordinal) => {
        insertChunk.run(record.chunkId, record.sizeBytes, record.storagePath, now);
        insertLink.run(blobId, ordinal, record.chunkId);
      });
    });
    return { blobId, sizeBytes: bytes.byteLength };
  }

  private upsertExternalAsset(rootId: string, relativePath: string, stat: fs.Stats): void {
    const normalized = safeRelativePath(relativePath);
    const existing = this.db.prepare(`SELECT asset_id,current_version_id FROM workspace_assets WHERE workspace_root_id=? AND relative_path=?`)
      .get(rootId, normalized) as { asset_id: string; current_version_id: string | null } | undefined;
    const now = new Date().toISOString();
    const fingerprint = JSON.stringify({ sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), ino: Number(stat.ino) || null });
    if (existing) {
      const current = existing.current_version_id
        ? this.db.prepare("SELECT source_fingerprint_json FROM workspace_asset_versions WHERE version_id=?").get(existing.current_version_id) as { source_fingerprint_json: string } | undefined
        : undefined;
      if (current?.source_fingerprint_json === fingerprint) return;
      const versionNo = Number((this.db.prepare("SELECT COALESCE(MAX(version_no),0)+1 AS n FROM workspace_asset_versions WHERE asset_id=?").get(existing.asset_id) as { n: number }).n);
      const versionId = randomUUID();
      this.db.prepare(`INSERT INTO workspace_asset_versions(version_id,asset_id,version_no,blob_id,parent_version_id,source_fingerprint_json,created_at) VALUES (?,?,?,NULL,?,?,?)`)
        .run(versionId, existing.asset_id, versionNo, existing.current_version_id, fingerprint, now);
      this.db.prepare("UPDATE workspace_assets SET current_version_id=?,display_name=?,media_type=?,updated_at=? WHERE asset_id=?")
        .run(versionId, path.basename(normalized), guessMime(normalized), now, existing.asset_id);
      return;
    }
    const assetId = randomUUID();
    const versionId = randomUUID();
    withSqliteSavepoint(this.db, "workspace_external", () => {
      this.db.prepare(`INSERT INTO workspace_assets(asset_id,source_kind,display_name,media_type,workspace_root_id,relative_path,current_version_id,created_at,updated_at) VALUES (?,'external',?,?,?,?,NULL,?,?)`)
        .run(assetId, path.basename(normalized), guessMime(normalized), rootId, normalized, now, now);
      this.db.prepare(`INSERT INTO workspace_asset_versions(version_id,asset_id,version_no,blob_id,parent_version_id,source_fingerprint_json,created_at) VALUES (?,?,1,NULL,NULL,?,?)`)
        .run(versionId, assetId, fingerprint, now);
      this.db.prepare("UPDATE workspace_assets SET current_version_id=? WHERE asset_id=?").run(versionId, assetId);
    });
  }

  private assetRow(assetId: string) {
    const row = this.db.prepare(`SELECT asset_id,source_kind,display_name,media_type,workspace_root_id,relative_path,current_version_id FROM workspace_assets WHERE asset_id=? AND lifecycle_status='active'`)
      .get(assetId) as {
        asset_id: string; source_kind: WorkspaceSourceKind; display_name: string; media_type: string;
        workspace_root_id: string | null; relative_path: string | null; current_version_id: string | null;
      } | undefined;
    if (!row || !row.current_version_id) throw new Error(`文件资产不存在: ${assetId}`);
    return row;
  }

  private assetRef(assetId: string): WorkspaceAssetRef {
    const row = this.assetRow(assetId);
    const version = this.db.prepare(`SELECT v.version_id,v.blob_id,v.source_fingerprint_json,b.size_bytes FROM workspace_asset_versions v LEFT JOIN workspace_blobs b ON b.blob_id=v.blob_id WHERE v.version_id=?`)
      .get(row.current_version_id) as { version_id: string; blob_id: string | null; source_fingerprint_json: string; size_bytes: number | null };
    return {
      assetId: row.asset_id, versionId: version.version_id, blobId: version.blob_id,
      name: row.display_name, mediaType: row.media_type,
      sizeBytes: version.size_bytes ?? fingerprintSize(version.source_fingerprint_json), sourceKind: row.source_kind,
    };
  }

  private blobChunks(blobId: string) {
    return this.db.prepare(`SELECT c.chunk_id,c.storage_path,c.size_bytes FROM workspace_blob_chunks bc JOIN workspace_chunks c ON c.chunk_id=bc.chunk_id WHERE bc.blob_id=? ORDER BY bc.ordinal`)
      .all(blobId) as Array<{ chunk_id: string; storage_path: string; size_bytes: number }>;
  }

  private addTaskRef(runId: string, assetId: string, versionId: string, role: WorkspaceFileRole): void {
    this.db.prepare(`INSERT OR IGNORE INTO task_file_refs(ref_id,run_id,asset_id,version_id,role,created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), runId, assetId, versionId, role, new Date().toISOString());
  }
}

export function contentDefinedChunks(content: Uint8Array): Buffer[] {
  const bytes = Buffer.from(content);
  if (bytes.length === 0) return [];
  const chunks: Buffer[] = [];
  let start = 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = Math.imul(hash ^ bytes[index], 0x01000193) >>> 0;
    const size = index + 1 - start;
    if (size >= MIN_CHUNK && ((hash & AVG_CHUNK_MASK) === 0 || size >= MAX_CHUNK)) {
      chunks.push(bytes.subarray(start, index + 1));
      start = index + 1;
      hash = 0x811c9dc5;
    }
  }
  if (start < bytes.length) chunks.push(bytes.subarray(start));
  return chunks;
}

function atomicEncryptedWrite(target: string, payload: Uint8Array): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  }
  catch (error) {
    if (fs.existsSync(target)) fs.rmSync(temporary, { force: true });
    else throw error;
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch {
    // Windows 和部分文件系统不允许 fsync 目录；文件本身已经 fsync。
  }
}

function uniqueMaterializedPath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = path.join(dir, `${stem} ${index}${ext}`);
  return candidate;
}

function safeName(value: string): string {
  const name = path.basename(value.trim()).replace(/[\u0000-\u001f]/g, "");
  if (!name || name === "." || name === "..") throw new Error("文件名无效");
  return name.slice(0, 255);
}

function safeRelativeDirectory(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("输出子目录无效");
  return normalized;
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("相对路径无效");
  return normalized;
}

function canonicalExistingDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("文件夹路径必须是绝对路径");
  const resolved = fs.realpathSync.native(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("选择的路径不是文件夹");
  return resolved;
}

function normalizedPathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertInside(root: string, target: string): void {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("路径越过已授权文件夹边界");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function fingerprintSize(json: string | null): number {
  try { return Number((JSON.parse(json ?? "{}") as { sizeBytes?: unknown }).sizeBytes) || 0; }
  catch { return 0; }
}

function guessMime(fileName: string): string {
  const map: Record<string, string> = {
    ".pdf":"application/pdf", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm":"application/vnd.ms-excel.sheet.macroEnabled.12", ".xls":"application/vnd.ms-excel",
    ".csv":"text/csv", ".tsv":"text/tab-separated-values", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation", ".txt":"text/plain",
    ".md":"text/markdown", ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
  };
  return map[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
