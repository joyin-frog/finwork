import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { semanticDiffFiles } from "./semantic-diff";
import type { FileWorkspaceStore } from "./store";
import type { SemanticDiff } from "./types";

export type ScriptRevisionEvidence = {
  assetId: string;
  versionId: string;
  name: string;
  logicalPath: string;
  diff: SemanticDiff;
};

export type GeneratedOutputEvidence = {
  assetId: string;
  versionId: string;
  changesetId: string | null;
  logicalPath: string;
  sha256: string;
  sizeBytes: number;
  changed: boolean;
};

export function recordScriptRevision(input: {
  store: FileWorkspaceStore;
  db: DatabaseSync;
  runId: string;
  scriptPath: string;
  logicalPath?: string;
}): Promise<ScriptRevisionEvidence> {
  return recordTextEvidence(input);
}

async function recordTextEvidence(input: {
  store: FileWorkspaceStore;
  db: DatabaseSync;
  runId: string;
  scriptPath: string;
  logicalPath?: string;
}): Promise<ScriptRevisionEvidence> {
  assertRegularFile(input.scriptPath, "脚本");
  const logicalPath = normalizeLogicalPath(input.logicalPath ?? path.basename(input.scriptPath));
  const name = path.basename(logicalPath);
  const batchId = `script:${input.runId}:${logicalPath}`;
  const existing = input.db.prepare(`
    SELECT asset_id,current_version_id FROM workspace_assets
    WHERE batch_id=? AND lifecycle_status='active'
    ORDER BY created_at LIMIT 1
  `).get(batchId) as { asset_id: string; current_version_id: string } | undefined;
  const scratch = path.join(path.dirname(input.scriptPath), ".finwork-evidence", randomUUID());
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const content = fs.readFileSync(input.scriptPath);
    let diff: SemanticDiff;
    if (existing) {
      const previous = input.store.materializeVersion(existing.current_version_id, scratch, `previous-${name}`);
      diff = await semanticDiffFiles(previous, input.scriptPath);
      if (input.store.readVersion(existing.current_version_id).equals(content)) {
        input.store.linkTaskFile(input.runId, existing.asset_id, existing.current_version_id, "evidence");
        return {
          assetId: existing.asset_id,
          versionId: existing.current_version_id,
          name,
          logicalPath,
          diff,
        };
      }
    } else {
      const empty = path.join(scratch, `empty-${name}`);
      fs.writeFileSync(empty, "", { mode: 0o600 });
      diff = await semanticDiffFiles(empty, input.scriptPath);
    }
    const asset = input.store.ingestManagedBuffer({
      ...(existing ? { assetId: existing.asset_id, parentVersionId: existing.current_version_id } : {}),
      name,
      mediaType: scriptMediaType(name),
      content,
      sourceKind: "generated",
      batchId,
    });
    input.store.linkTaskFile(input.runId, asset.assetId, asset.versionId, "evidence");
    return { assetId: asset.assetId, versionId: asset.versionId, name, logicalPath, diff };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * 把脚本或声明式工具产生的文件登记成受管输出版本。首次出现形成 base=null
 * 的“出生变更集”，后续同路径内容变化形成普通父子版本；相同内容不会制造空版本。
 */
export async function recordGeneratedOutputVersion(input: {
  store: FileWorkspaceStore;
  db: DatabaseSync;
  runId: string;
  filePath: string;
  logicalPath: string;
  source?: "script_execution" | "finalize";
}): Promise<GeneratedOutputEvidence> {
  assertRegularFile(input.filePath, "输出文件");
  const logicalPath = normalizeLogicalPath(input.logicalPath);
  const content = fs.readFileSync(input.filePath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const batchId = `output:${input.runId}:${logicalPath}`;
  const existing = input.db.prepare(`
    SELECT asset_id,current_version_id FROM workspace_assets
    WHERE batch_id=? AND lifecycle_status='active'
    ORDER BY created_at LIMIT 1
  `).get(batchId) as { asset_id: string; current_version_id: string } | undefined;
  if (existing && input.store.readVersion(existing.current_version_id).equals(content)) {
    input.store.linkTaskFile(input.runId, existing.asset_id, existing.current_version_id, "output");
    return {
      assetId: existing.asset_id,
      versionId: existing.current_version_id,
      changesetId: null,
      logicalPath,
      sha256,
      sizeBytes: content.byteLength,
      changed: false,
    };
  }

  const scratch = path.join(path.dirname(input.filePath), ".finwork-evidence", randomUUID());
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const diff = existing
      ? await semanticDiffFiles(
          input.store.materializeVersion(existing.current_version_id, scratch, `previous-${path.basename(logicalPath)}`),
          input.filePath,
        )
      : birthDiff(input.filePath, content);
    const asset = input.store.ingestManagedBuffer({
      ...(existing ? { assetId: existing.asset_id, parentVersionId: existing.current_version_id } : {}),
      name: path.basename(logicalPath),
      mediaType: mediaTypeFor(logicalPath),
      content,
      sourceKind: "generated",
      batchId,
    });
    input.store.linkTaskFile(input.runId, asset.assetId, asset.versionId, "output");
    const changesetId = randomUUID();
    const now = new Date().toISOString();
    input.db.prepare(`
      INSERT INTO file_changesets
        (changeset_id,run_id,asset_id,base_version_id,candidate_version_id,diff_kind,diff_json,validation_json,status,created_at,resolved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      changesetId,
      input.runId,
      asset.assetId,
      existing?.current_version_id ?? null,
      asset.versionId,
      diff.kind,
      JSON.stringify(diff),
      JSON.stringify({
        kind: existing ? "generated_output_revision" : "generated_output_birth",
        source: input.source ?? "script_execution",
        logicalPath,
        sha256,
        sizeBytes: content.byteLength,
      }),
      "applied",
      now,
      now,
    );
    return {
      assetId: asset.assetId,
      versionId: asset.versionId,
      changesetId,
      logicalPath,
      sha256,
      sizeBytes: content.byteLength,
      changed: true,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function beginScriptExecution(input: {
  db: DatabaseSync;
  runId: string;
  script: ScriptRevisionEvidence;
  sandboxKind: string;
  args: string[];
}): { executionId: string; inputRefs: Array<{ assetId: string; versionId: string }> } {
  const executionId = randomUUID();
  const inputRefs = input.db.prepare(`
    SELECT asset_id,version_id FROM task_file_refs
    WHERE run_id=? AND role='input' ORDER BY created_at,ref_id
  `).all(input.runId) as Array<{ asset_id: string; version_id: string }>;
  const normalized = inputRefs.map((item) => ({ assetId: item.asset_id, versionId: item.version_id }));
  input.db.prepare(`
    INSERT INTO script_executions
      (execution_id,run_id,script_asset_id,script_version_id,sandbox_kind,args_json,input_refs_json,status,started_at)
    VALUES (?,?,?,?,?,?,?,'running',?)
  `).run(
    executionId,
    input.runId,
    input.script.assetId,
    input.script.versionId,
    input.sandboxKind,
    JSON.stringify(input.args),
    JSON.stringify(normalized),
    new Date().toISOString(),
  );
  return { executionId, inputRefs: normalized };
}

export function finishScriptExecution(input: {
  db: DatabaseSync;
  executionId: string;
  exitCode?: number;
  outputs?: GeneratedOutputEvidence[];
  error?: string;
}): void {
  const failed = input.error != null || (input.exitCode != null && input.exitCode !== 0);
  input.db.prepare(`
    UPDATE script_executions
    SET status=?,exit_code=?,error_message=?,output_manifest_json=?,completed_at=?
    WHERE execution_id=? AND status='running'
  `).run(
    failed ? "failed" : "completed",
    input.exitCode ?? null,
    input.error ?? null,
    JSON.stringify(input.outputs ?? []),
    new Date().toISOString(),
    input.executionId,
  );
}

function birthDiff(filePath: string, content: Buffer): SemanticDiff {
  return {
    kind: "binary",
    changed: true,
    summary: "新建文件",
    details: {
      birth: true,
      extension: path.extname(filePath).toLowerCase(),
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
    },
  };
}

function normalizeLogicalPath(value: string): string {
  const normalized = value.split(path.sep).join("/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("输出逻辑路径无效");
  }
  return normalized;
}

function assertRegularFile(filePath: string, label: string): void {
  const link = fs.lstatSync(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${label}不是普通文件`);
}

function scriptMediaType(fileName: string): string {
  const types: Record<string, string> = {
    ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/typescript",
    ".sh": "text/x-shellscript", ".sql": "application/sql", ".r": "text/x-r-source",
  };
  return types[path.extname(fileName).toLowerCase()] ?? "text/plain";
}

function mediaTypeFor(fileName: string): string {
  const types: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".py": "text/x-python",
  };
  return types[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
