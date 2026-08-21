import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

export const workspaceChangeLoopTestPromise = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-change-loop-"));
  const previous = {
    db: process.env.FINANCE_AGENT_DB_PATH,
    data: process.env.FINANCE_AGENT_APP_DATA_DIR,
    workspace: process.env.FINANCE_AGENT_FILE_WORKSPACE_DIR,
    keyBackend: process.env.FINANCE_AGENT_FILE_KEY_BACKEND,
    keyFile: process.env.FINANCE_AGENT_FILE_WORKSPACE_KEY_FILE,
  };
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "finance-agent.db");
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;
  process.env.FINANCE_AGENT_FILE_WORKSPACE_DIR = path.join(root, "workspace");
  process.env.FINANCE_AGENT_FILE_KEY_BACKEND = "file";
  process.env.FINANCE_AGENT_FILE_WORKSPACE_KEY_FILE = path.join(root, "workspace-key");
  try {
    const [{ getDb }, { getFileWorkspaceStore, workspaceReviewGate }, { _resetFileWorkspaceKeyCache }, { createWorkspaceFileTools }] = await Promise.all([
      import("../lib/db/sqlite.ts"),
      import("../lib/file-workspace/index.ts"),
      import("../lib/file-workspace/key-store.ts"),
      import("../lib/agent/mcp-tools/workspace-files.ts"),
    ]);
    _resetFileWorkspaceKeyCache();
    getDb();
    const store = await getFileWorkspaceStore();
    const originalPath = path.join(root, "original.xlsx");
    const outputDir = path.join(root, "outputs");
    fs.mkdirSync(outputDir, { recursive: true });
    await writeWorkbook(originalPath, 100);
    const source = store.ingestManagedBuffer({
      name: "original.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: fs.readFileSync(originalPath),
    });

    const handlers = new Map<string, (args: unknown) => Promise<Record<string, unknown>>>();
    const preparedInputs = new Set<string>();
    const sdk = {
      tool: (name: string, _description: string, _schema: unknown, handler: (args: unknown) => Promise<Record<string, unknown>>) => {
        handlers.set(name, handler);
        return { name };
      },
    };
    createWorkspaceFileTools(sdk as never, {
      assetIds: [source.assetId],
      runId: "run-review-loop",
      outputDir,
      onPreparedInput: (preparedPath) => preparedInputs.add(preparedPath),
    });
    const read = handlers.get("read_workspace_file");
    const patch = handlers.get("patch_workspace_workbook");
    assert.ok(!handlers.has("begin_workspace_change"), "legacy begin tool must not be registered");
    assert.ok(!handlers.has("review_workspace_change"), "legacy review tool must not be registered");
    assert.ok(read, "read workspace tool must be registered");
    assert.ok(patch, "managed workbook patch tool must be registered");
    const readResult = await read!({ assetId: source.assetId });
    const taskPath = (readResult.structuredContent as { taskPath: string }).taskPath;
    assert.ok(preparedInputs.has(taskPath), "materialized task input must be granted to the dynamic runner");
    const cachedRead = await read!({ assetId: source.assetId });
    assert.equal((cachedRead.structuredContent as { taskPath: string }).taskPath, taskPath);
    assert.equal((cachedRead.structuredContent as { cacheHit: boolean }).cacheHit, true, "同一版本不得重复解析和物化");
    const editsPath = path.join(outputDir, "script-edits.json");
    fs.writeFileSync(editsPath, JSON.stringify([
      { sheet: "利润", cell: "B2", value: 110 },
      { sheet: "利润", cell: "A3", value: "保留的累计修改" },
    ]), { mode: 0o600 });
    const patchedFromScript = await patch!({
      assetId: source.assetId,
      outputName: "script-patched.xlsx",
      editsFilePath: "script-edits.json",
    });
    assert.ok(!patchedFromScript.isError, `script edit file should be accepted: ${JSON.stringify(patchedFromScript)}`);
    const scriptPatchedWorkbook = new ExcelJS.Workbook();
    await scriptPatchedWorkbook.xlsx.readFile(path.join(outputDir, "script-patched.xlsx"));
    assert.equal(scriptPatchedWorkbook.getWorksheet("利润")!.getCell("B2").value, 110);
    assert.equal(
      (patchedFromScript.structuredContent as { assetId: string }).assetId,
      source.assetId,
      "patch 不得再创建 standalone generated asset",
    );
    assert.equal(workspaceReviewGate(getDb(), "run-review-loop").ok, true, "patch 必须自动形成后端复核证据");
    const candidateRead = await read!({ assetId: source.assetId });
    assert.equal(
      (candidateRead.structuredContent as { versionId: string }).versionId,
      (patchedFromScript.structuredContent as { candidateVersionId: string }).candidateVersionId,
      "后续读取必须自动跟随当前候选头",
    );
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS n FROM workspace_assets WHERE batch_id=?").get("run-review-loop") as { n: number }).n,
      0,
      "patch 不得按 outputName 重复登记 generated asset",
    );
    const cumulativePatch = await patch!({
      assetId: source.assetId,
      outputName: "repair-result.xlsx",
      edits: [{ sheet: "利润", cell: "B2", value: 135 }],
    });
    assert.ok(!cumulativePatch.isError, `repair patch should succeed: ${JSON.stringify(cumulativePatch)}`);
    assert.equal(
      (cumulativePatch.structuredContent as { baseVersionId: string }).baseVersionId,
      (patchedFromScript.structuredContent as { candidateVersionId: string }).candidateVersionId,
      "repair patch 必须自动基于 run 的最新候选分支头",
    );
    const cumulativeWorkbook = new ExcelJS.Workbook();
    await cumulativeWorkbook.xlsx.readFile(path.join(outputDir, "repair-result.xlsx"));
    assert.equal(
      cumulativeWorkbook.getWorksheet("利润")!.getCell("A3").value,
      "保留的累计修改",
      "repair patch 不得从原始 asset 重建并丢失上一轮修改",
    );

    const { createFinalizeDeliverableTool, syncFinalizedWorkspaceCandidate } = await import("../lib/agent/mcp-tools/finalize-deliverable.ts");
    createFinalizeDeliverableTool(sdk as never, outputDir, {
      runId: "run-review-loop",
      requireWorkspaceChangeReview: true,
      deliverySpec: {
        version: 1,
        taskKind: "spreadsheet",
        requiredDeliverables: [{
          id: "workbook",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          count: 1,
          qualityProfile: "generic",
        }],
        expectationSnapshot: {},
      },
    });
    const mismatchedFinalize = await handlers.get("finalize_deliverable")!({
      files: [{ name: "unreviewed.xlsx", contractDeliverableId: "workbook" }],
    });
    assert.equal(mismatchedFinalize.isError, true);
    assert.equal(
      (mismatchedFinalize.structuredContent as { code: string }).code,
      "workspace_review_candidate_mismatch",
      "finalize 只能提交最新复核候选",
    );

    const db = getDb();
    const statuses = db.prepare("SELECT status,validation_json FROM file_changesets WHERE run_id=? ORDER BY created_at")
      .all("run-review-loop") as Array<{ status: string; validation_json: string }>;
    assert.deepEqual(
      statuses.map((row) => row.status),
      ["rejected", "pending"],
      "连续 patch 必须只保留一个 pending 头",
    );
    assert.equal((JSON.parse(statuses.at(-1)!.validation_json) as { complete: boolean }).complete, true);
    const candidatePath = path.join(outputDir, "repair-result.xlsx");
    await writeWorkbook(candidatePath, 140);
    const synced = await syncFinalizedWorkspaceCandidate({
      db,
      store,
      runId: "run-review-loop",
      candidatePath,
    });
    assert.equal(synced.changed, true, "finalize 原地重算后的字节必须形成新版本");
    const syncedGate = workspaceReviewGate(db, "run-review-loop");
    assert.equal(syncedGate.ok, true);
    assert.equal(syncedGate.ok && syncedGate.candidateVersionId, synced.versionId);
    const syncedParent = db.prepare(
      "SELECT parent_version_id FROM workspace_asset_versions WHERE version_id=?",
    ).get(synced.versionId) as { parent_version_id: string };
    assert.equal(
      syncedParent.parent_version_id,
      (cumulativePatch.structuredContent as { candidateVersionId: string }).candidateVersionId,
      "重算版本必须接在已复核候选之后",
    );
    const refs = (db.prepare("SELECT role,COUNT(*) AS n FROM task_file_refs WHERE run_id=? GROUP BY role")
      .all("run-review-loop") as Array<{ role: string; n: number }>);
    assert.ok(refs.some((row) => row.role === "baseline"));
    assert.ok(refs.some((row) => row.role === "output"));
    console.log("workspace-change-loop: one patch protocol + current-head chaining + ready review ✓");
  } finally {
    restore("FINANCE_AGENT_DB_PATH", previous.db);
    restore("FINANCE_AGENT_APP_DATA_DIR", previous.data);
    restore("FINANCE_AGENT_FILE_WORKSPACE_DIR", previous.workspace);
    restore("FINANCE_AGENT_FILE_KEY_BACKEND", previous.keyBackend);
    restore("FINANCE_AGENT_FILE_WORKSPACE_KEY_FILE", previous.keyFile);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

async function writeWorkbook(filePath: string, amount: number) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("利润");
  sheet.addRow(["项目", "金额"]);
  sheet.addRow(["收入", amount]);
  await workbook.xlsx.writeFile(filePath);
}

function restore(name: string, value: string | undefined) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
