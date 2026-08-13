import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { directoryBytes } from "./metrics";

type WorkspaceRow = {
  workspace_id: string;
  owner_run_id: string;
  path: string;
  state: "active" | "tombstoned" | "deleted" | "failed";
  heartbeat_at: string;
};

/**
 * Durable ownership and two-phase deletion for disposable resource workspaces.
 * Permanent user files remain governed by ArtifactLifecycleService instead.
 */
export class TempWorkspaceRegistry {
  readonly root: string;

  constructor(readonly db: DatabaseSync, root = path.join(os.tmpdir(), "finwork-resource-workspaces")) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
  }

  create(ownerRunId: string, now = new Date().toISOString()): { workspaceId: string; path: string } {
    const workspaceId = randomUUID();
    const workspacePath = fs.mkdtempSync(path.join(this.root, "workspace-"));
    this.db.prepare(`INSERT INTO resource_temp_workspaces
      (workspace_id,owner_run_id,path,state,created_at,heartbeat_at,last_size_bytes)
      VALUES (?,?,?,'active',?,?,0)`).run(workspaceId, ownerRunId, workspacePath, now, now);
    return { workspaceId, path: workspacePath };
  }

  activeForRun(ownerRunId: string): { workspaceId: string; path: string } | null {
    const row = this.db.prepare(`SELECT workspace_id,owner_run_id,path,state,heartbeat_at
      FROM resource_temp_workspaces WHERE owner_run_id=? AND state='active'
      ORDER BY created_at DESC LIMIT 1`).get(ownerRunId) as WorkspaceRow | undefined;
    if (!row) return null;
    this.assertOwnedPath(row.path);
    if (!fs.existsSync(row.path)) {
      this.db.prepare("UPDATE resource_temp_workspaces SET state='failed',error_message=? WHERE workspace_id=?")
        .run("workspace disappeared while active", row.workspace_id);
      return null;
    }
    return { workspaceId: row.workspace_id, path: row.path };
  }

  heartbeat(workspaceId: string, now = new Date().toISOString()): number {
    const row = this.require(workspaceId);
    if (row.state !== "active") throw new Error(`workspace ${workspaceId} is ${row.state}`);
    const bytes = directoryBytes(row.path);
    this.db.prepare(`UPDATE resource_temp_workspaces SET heartbeat_at=?,last_size_bytes=?
      WHERE workspace_id=? AND state='active'`).run(now, bytes, workspaceId);
    return bytes;
  }

  tombstone(workspaceId: string, graceMs: number, now = new Date()): void {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("graceMs must be non-negative");
    const row = this.require(workspaceId);
    if (row.state === "deleted" || row.state === "tombstoned") return;
    const deleteAfter = new Date(now.getTime() + graceMs).toISOString();
    const bytes = fs.existsSync(row.path) ? directoryBytes(row.path) : 0;
    this.db.prepare(`UPDATE resource_temp_workspaces SET state='tombstoned',delete_after=?,
      heartbeat_at=?,last_size_bytes=?,error_message=NULL WHERE workspace_id=?`)
      .run(deleteAfter, now.toISOString(), bytes, workspaceId);
  }

  tombstoneStale(maxIdleMs: number, graceMs: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - maxIdleMs).toISOString();
    const rows = this.db.prepare(`SELECT workspace_id FROM resource_temp_workspaces
      WHERE state='active' AND heartbeat_at<=?`).all(cutoff) as Array<{ workspace_id: string }>;
    for (const row of rows) this.tombstone(row.workspace_id, graceMs, now);
    return rows.length;
  }

  sweep(now = new Date()): { deleted: number; failed: number; bytesReclaimed: number } {
    const rows = this.db.prepare(`SELECT workspace_id,owner_run_id,path,state,heartbeat_at
      FROM resource_temp_workspaces WHERE state='tombstoned' AND delete_after<=?`)
      .all(now.toISOString()) as WorkspaceRow[];
    let deleted = 0;
    let failed = 0;
    let bytesReclaimed = 0;
    for (const row of rows) {
      try {
        this.assertOwnedPath(row.path);
        const bytes = fs.existsSync(row.path) ? directoryBytes(row.path) : 0;
        fs.rmSync(row.path, { recursive: true, force: true });
        this.db.prepare(`UPDATE resource_temp_workspaces SET state='deleted',deleted_at=?,
          last_size_bytes=?,error_message=NULL WHERE workspace_id=? AND state='tombstoned'`)
          .run(now.toISOString(), bytes, row.workspace_id);
        deleted += 1;
        bytesReclaimed += bytes;
      } catch (error) {
        this.db.prepare("UPDATE resource_temp_workspaces SET state='failed',error_message=? WHERE workspace_id=?")
          .run(error instanceof Error ? error.message : String(error), row.workspace_id);
        failed += 1;
      }
    }
    return { deleted, failed, bytesReclaimed };
  }

  counts(ownerRunId?: string): Record<string, number> {
    const rows = (ownerRunId
      ? this.db.prepare("SELECT state,COUNT(*) AS count FROM resource_temp_workspaces WHERE owner_run_id=? GROUP BY state").all(ownerRunId)
      : this.db.prepare("SELECT state,COUNT(*) AS count FROM resource_temp_workspaces GROUP BY state").all()
    ) as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
  }

  private require(workspaceId: string): WorkspaceRow {
    const row = this.db.prepare(`SELECT workspace_id,owner_run_id,path,state,heartbeat_at
      FROM resource_temp_workspaces WHERE workspace_id=?`).get(workspaceId) as WorkspaceRow | undefined;
    if (!row) throw new Error(`unknown workspace ${workspaceId}`);
    this.assertOwnedPath(row.path);
    return row;
  }

  private assertOwnedPath(candidate: string): void {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`workspace path escapes managed root: ${candidate}`);
    }
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`workspace root must not be a symlink: ${candidate}`);
    }
  }
}
