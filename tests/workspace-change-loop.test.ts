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
    const [{ getDb }, { getFileWorkspaceStore }, { _resetFileWorkspaceKeyCache }, { createWorkspaceFileTools }] = await Promise.all([
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
    const candidatePath = path.join(outputDir, "result.xlsx");
    const scriptPath = path.join(outputDir, "transform.py");
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
    const review = handlers.get("review_workspace_change");
    const begin = handlers.get("begin_workspace_change");
    assert.ok(begin, "begin change tool must be registered");
    assert.ok(review, "review tool must be registered");
    assert.ok(read, "read workspace tool must be registered");
    const readResult = await read!({ assetId: source.assetId });
    const taskPath = (readResult.structuredContent as { taskPath: string }).taskPath;
    assert.ok(preparedInputs.has(taskPath), "materialized task input must be granted to the dynamic runner");
    const begun = await begin!({
      assetId: source.assetId,
      targets: [{ description: "更新金额", sheet: "利润", cell: "B2", expectedValue: 130 }],
    });
    const planId = (begun.structuredContent as { planId: string }).planId;
    const planVersion = store.getAsset(planId);
    assert.match(store.readVersion(planVersion.versionId).toString("utf8"), /run-review-loop/);
    const probeDir = path.join(root, "probe");
    store.materializeVersion(source.versionId, probeDir, source.name);
    await writeWorkbook(candidatePath, 120);
    fs.writeFileSync(scriptPath, "amount = 120\n", { mode: 0o600 });
    const first = await review!({
      assetId: source.assetId,
      planId,
      candidatePath: "result.xlsx",
      scriptPath: "transform.py",
      changePlan: [],
      final: false,
      validationNotes: ["第一轮"],
    });
    assert.ok(first.structuredContent, `first review failed: ${JSON.stringify(first)}`);
    const firstStructured = first.structuredContent as { changesetId: string; complete: boolean; script: { assetId: string; versionId: string } };
    assert.equal(firstStructured.complete, false);

    await writeWorkbook(candidatePath, 130);
    fs.writeFileSync(scriptPath, "amount = 130\nprint(amount)\n", { mode: 0o600 });
    const second = await review!({
      assetId: source.assetId,
      planId,
      candidatePath: "result.xlsx",
      scriptPath: "transform.py",
      changePlan: [],
      final: true,
      validationNotes: ["最终轮"],
    });
    const secondStructured = second.structuredContent as {
      changesetId: string;
      complete: boolean;
      plan: { complete: boolean };
      script: { assetId: string; versionId: string; diff: { kind: string; changed: boolean } };
    };
    assert.equal(secondStructured.complete, true);
    assert.equal(secondStructured.plan.complete, true);
    assert.equal(secondStructured.script.assetId, firstStructured.script.assetId, "脚本迭代必须复用同一 asset");
    assert.notEqual(secondStructured.script.versionId, firstStructured.script.versionId, "脚本每轮必须形成新版本");
    assert.equal(secondStructured.script.diff.kind, "text");
    assert.equal(secondStructured.script.diff.changed, true);
    const db = getDb();
    const statuses = db.prepare("SELECT status,validation_json FROM file_changesets WHERE run_id=? ORDER BY created_at")
      .all("run-review-loop") as Array<{ status: string; validation_json: string }>;
    assert.deepEqual(statuses.map((row) => row.status), ["rejected", "pending"], "新一轮必须淘汰旧候选");
    assert.equal((JSON.parse(statuses[1].validation_json) as { complete: boolean }).complete, true);
    const refs = (db.prepare("SELECT role,COUNT(*) AS n FROM task_file_refs WHERE run_id=? GROUP BY role")
      .all("run-review-loop") as Array<{ role: string; n: number }>);
    assert.ok(refs.some((row) => row.role === "baseline"));
    assert.ok(refs.some((row) => row.role === "output"));
    assert.ok(refs.some((row) => row.role === "evidence"));
    console.log("workspace-change-loop: dynamic script revisions + cell diff + ready review ✓");
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
