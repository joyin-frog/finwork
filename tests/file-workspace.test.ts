import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { FileWorkspaceStore, contentDefinedChunks } from "../lib/file-workspace/store.ts";
import { createFileChangeSet, evaluateWorkspaceChangePlan, resolveFileChangeSet, semanticDiffFiles } from "../lib/file-workspace/semantic-diff.ts";

export const fileWorkspaceTestPromise = (async () => {
  const root = path.join(os.tmpdir(), `finwork-file-workspace-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const dbPath = path.join(root, "test.db");
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);
  const key = Buffer.alloc(32, 7);
  const store = new FileWorkspaceStore(db, path.join(root, "workspace"), key);

  try {
    const content = Buffer.from("敏感财务数据：收入 123456\n".repeat(20_000));
    const first = store.ingestManagedBuffer({ name: "一季度.csv", mediaType: "text/csv", content });
    const second = store.ingestManagedBuffer({ name: "副本.csv", mediaType: "text/csv", content });
    assert.equal(first.blobId, second.blobId, "相同内容必须命中同一私有 blob");
    assert.ok(first.blobId?.startsWith("blob_"));
    const blobCount = (db.prepare("SELECT COUNT(*) AS n FROM workspace_blobs").get() as { n: number }).n;
    assert.equal(blobCount, 1, "整文件去重不能重复记录 blob");
    const encryptedPath = (db.prepare("SELECT storage_path FROM workspace_chunks LIMIT 1").get() as { storage_path: string }).storage_path;
    assert.ok(!readFileSync(encryptedPath).includes(Buffer.from("敏感财务数据")), "磁盘 chunk 不得出现明文");
    const materialized = store.materializeVersion(first.versionId, path.join(root, "materialized"));
    assert.deepEqual(readFileSync(materialized), content, "解密物化必须字节一致");

    const sharedPrefix = Buffer.alloc(5 * 1024 * 1024, 0x31);
    const chunksA = contentDefinedChunks(Buffer.concat([sharedPrefix, Buffer.from("A")]));
    const chunksB = contentDefinedChunks(Buffer.concat([sharedPrefix, Buffer.from("B")]));
    assert.ok(chunksA.length >= 2 && chunksB.length >= 2, "大文件必须切块");
    assert.deepEqual(chunksA[0], chunksB[0], "相同大文件前缀应共享内容定义 chunk");

    const externalRoot = path.join(root, "external");
    mkdirSync(path.join(externalRoot, "报表"), { recursive: true });
    writeFileSync(path.join(externalRoot, "报表", "利润表.csv"), "项目,金额\n收入,100\n");
    const authorized = store.registerRoot({ path: externalRoot, permission: "read_write", writePolicy: "confirm_replace" });
    const rootRow = db.prepare("SELECT locator_ciphertext FROM workspace_roots WHERE root_id=?").get(authorized.rootId) as { locator_ciphertext: string };
    assert.ok(!rootRow.locator_ciphertext.includes(externalRoot), "授权路径必须加密落库");
    const indexed = store.indexRoot(authorized.rootId);
    assert.equal(indexed.indexed, 1);
    const [external] = store.listAssets({ rootId: authorized.rootId, q: "利润表" });
    assert.ok(external && external.blobId === null, "目录索引只建 manifest，不应复制整个文件夹");
    const [prepared] = store.prepareRunWorkspace("run-file-test", [{ assetId: external.assetId }]);
    assert.ok(prepared.blobId, "正式使用时才创建不可变快照");
    assert.equal(readFileSync(prepared.path, "utf8"), "项目,金额\n收入,100\n");
    assert.ok(existsSync(path.join(store.root, "runs", "run-file-test", "work")), "run 必须预建唯一 Agent 写入区");
    assert.ok(existsSync(path.join(store.root, "runs", "run-file-test", "outputs")), "run 必须预建正式输出物化区");

    const beforeXlsx = path.join(root, "before.xlsx");
    const afterXlsx = path.join(root, "after.xlsx");
    await writeWorkbook(beforeXlsx, 100, "=B2*2");
    await writeWorkbook(afterXlsx, 120, "=B2*3");
    const diff = await semanticDiffFiles(beforeXlsx, afterXlsx);
    assert.equal(diff.kind, "xlsx");
    assert.equal(diff.changed, true);
    const cellDiff = diff.details.cells as { changed: string[] };
    assert.ok(cellDiff.changed.includes("利润!B2"));
    assert.ok(cellDiff.changed.includes("利润!C2"), "公式变化必须独立识别");
    const cellChanges = diff.details.cellChanges as { changed: Array<{ address: string; before: { value: unknown }; after: { value: unknown; formula: string | null } }> };
    assert.equal(cellChanges.changed.find((item) => item.address === "利润!B2")?.before.value, 100);
    assert.equal(cellChanges.changed.find((item) => item.address === "利润!B2")?.after.value, 120);
    const plan = evaluateWorkspaceChangePlan(diff, [
      { description: "更新收入", sheet: "利润", cell: "B2", expectedValue: 120 },
      { description: "更新计算公式", sheet: "利润", cell: "C2", expectedFormula: "=B2*3" },
      { description: "尚未修改的目标", sheet: "利润", cell: "D2", mustChange: true },
    ]);
    assert.equal(plan.complete, false);
    assert.equal(plan.completed.length, 2);
    assert.equal(plan.pending[0]?.address, "利润!D2");

    const scriptBefore = path.join(root, "analysis-before.py");
    const scriptAfter = path.join(root, "analysis-after.py");
    writeFileSync(scriptBefore, "amount = 100\n");
    writeFileSync(scriptAfter, "amount = 120\nprint(amount)\n");
    const scriptDiff = await semanticDiffFiles(scriptBefore, scriptAfter);
    assert.equal(scriptDiff.kind, "text", "动态 Python 脚本必须做行级 diff");
    assert.match(scriptDiff.summary, /文本有 \d+ 行变化/);

    const candidate = path.join(root, "candidate.csv");
    writeFileSync(candidate, "项目,金额\n收入,120\n");
    const change = await createFileChangeSet({
      db, store, runId: "run-change", assetId: external.assetId, candidatePath: candidate,
      validation: { passed: true, checks: ["csv-shape"] },
    });
    assert.equal(change.diff.changed, true);
    assert.equal(existsSync(path.join(path.dirname(candidate), ".finwork-diff-baseline")), false, "语义 diff 临时基线必须立即清理");
    assert.throws(() => store.applyApprovedReplacement(change.changesetId), /用户已批准/, "未批准不得覆盖原文件");
    resolveFileChangeSet(db, change.changesetId, "approved");
    store.applyApprovedReplacement(change.changesetId);
    assert.equal(readFileSync(path.join(externalRoot, "报表", "利润表.csv"), "utf8"), "项目,金额\n收入,120\n");

    const managedCandidate = path.join(root, "managed-candidate.csv");
    writeFileSync(managedCandidate, "敏感财务数据：收入 999999\n");
    const managedChange = await createFileChangeSet({
      db, store, runId: "run-managed-change", assetId: first.assetId, candidatePath: managedCandidate,
      validation: { passed: true, readyForUser: true },
    });
    resolveFileChangeSet(db, managedChange.changesetId, "approved");
    store.applyApprovedChangeSet(managedChange.changesetId);
    assert.equal(store.getAsset(first.assetId).versionId, managedChange.candidateVersionId, "批准受管上传件后必须切换当前版本");

    const staleRun = path.join(store.root, "runs", "stale-run");
    mkdirSync(staleRun, { recursive: true });
    const staleAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(staleRun, staleAt, staleAt);
    const purged = store.purgeStaleRunWorkspaces(24 * 60 * 60 * 1000);
    assert.ok(purged.directories >= 1);
    assert.equal(existsSync(staleRun), false, "过期任务明文副本必须可回收");

    console.log("file-workspace: encrypted CAS + root broker + semantic diff + transactional replace ✓");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

async function writeWorkbook(filePath: string, amount: number, formula: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("利润");
  sheet.addRow(["项目", "金额", "计算"]);
  sheet.addRow(["收入", amount, { formula: formula.slice(1), result: amount * 2 }]);
  await workbook.xlsx.writeFile(filePath);
}
