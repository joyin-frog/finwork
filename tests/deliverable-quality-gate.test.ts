import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskContract } from "../lib/agent/run-contract.ts";
import {
  copyToDeliveredImmutable,
  finalizeDeliverables,
  MemoryDeliverableStore,
  SqliteDeliverableStore,
  ensureBuiltinValidatorsRegistered,
  selectValidator,
  sha256File,
  upDeliverablesV22,
  resolveInOutputScope,
  getDeliveredDir,
  conversationDirFromOutputDir,
  isDeliveredStoragePath,
} from "../lib/deliverable/index.ts";
import { getSpreadsheetFixtureDir } from "../lib/runtime/spreadsheet-probe.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function baseContract(overrides?: Partial<TaskContract>): TaskContract {
  return {
    version: 1,
    taskKind: "spreadsheet",
    requiredDeliverables: [
      { id: "workbook", mime: XLSX_MIME, count: 1, qualityProfile: "generic" },
    ],
    expectationSnapshot: {},
    spreadsheetRequirement: {
      needsLegacyXlsRead: false,
      needsWrite: true,
      needsRecalc: false,
      needsRender: false,
      needsMacroPreservation: false,
    },
    ...overrides,
  };
}

export const deliverableQualityGateTestPromise = (async () => {
  ensureBuiltinValidatorsRegistered();
  const root = mkdtempSync(path.join(tmpdir(), "fa-q1-"));
  const fixtures = getSpreadsheetFixtureDir();
  const formulaOk = path.join(fixtures, "formula-ok.xlsx");

  try {
    // ── Scope: missing / empty / dir / traversal / symlink escape ──
    {
      const out = path.join(root, "scope-out");
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "ok.txt"), "hello");
      writeFileSync(path.join(out, "empty.txt"), "");
      mkdirSync(path.join(out, "subdir"));

      assert.equal(resolveInOutputScope(out, "missing.txt").ok, false);
      assert.equal((resolveInOutputScope(out, "empty.txt") as { code: string }).code, "empty_file");
      assert.equal((resolveInOutputScope(out, "subdir") as { code: string }).code, "is_directory");

      const escape = resolveInOutputScope(out, "../../etc/passwd");
      // basename 裁剪后应找 passwd（不存在）或若碰巧存在也不在 scope——我们裁 basename
      assert.equal(escape.ok, false);

      const outside = path.join(root, "outside-secret.txt");
      writeFileSync(outside, "secret");
      try {
        symlinkSync(outside, path.join(out, "link.txt"));
        const link = resolveInOutputScope(out, "link.txt");
        assert.equal(link.ok, false);
        assert.equal((link as { code: string }).code, "symlink_escape");
      } catch (e) {
        // 部分 CI 禁 symlink
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      }
    }

    // ── MIME spoof ──
    {
      const out = path.join(root, "mime-out");
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "fake.xlsx"), "not-a-zip");
      const v = selectValidator(XLSX_MIME, "generic");
      const report = await v.validate({
        filePath: path.join(out, "fake.xlsx"),
        fileName: "fake.xlsx",
        expectedMime: XLSX_MIME,
        qualityProfile: "generic",
      });
      assert.equal(report.status, "failed");
      assert.ok(report.errors.some((e) => e.code === "mime_spoof" || e.code === "parser_open_failed"));
    }

    // ── Hash bind: stale expectedSha256 rejected ──
    {
      const out = path.join(root, "hash-out");
      mkdirSync(out, { recursive: true });
      const f = path.join(out, "a.txt");
      writeFileSync(f, "v1");
      const v = selectValidator("text/plain", "generic");
      const bad = await v.validate({
        filePath: f,
        fileName: "a.txt",
        expectedMime: "text/plain",
        qualityProfile: "generic",
        expectedSha256: "0".repeat(64),
      });
      assert.equal(bad.status, "failed");
      assert.ok(bad.errors.some((e) => e.code === "hash_mismatch"));
    }

    // ── Immutable copy + TOCTOU: mutate working after validate hash ──
    {
      const conv = path.join(root, "conv1");
      const generate = path.join(conv, "generate");
      mkdirSync(generate, { recursive: true });
      const working = path.join(generate, "report.txt");
      writeFileSync(working, "good-content");
      const hash = sha256File(working);
      const deliveredDir = getDeliveredDir(conv, "run-1");
      const copy = copyToDeliveredImmutable({
        workingPath: working,
        deliveredDir,
        fileName: "report.txt",
        expectedSha256: hash,
      });
      assert.equal(copy.ok, true);
      if (!copy.ok) throw new Error("copy failed");
      // 改工作文件不影响 delivered
      writeFileSync(working, "tampered");
      assert.equal(sha256File(copy.deliveredPath), hash);
      assert.notEqual(sha256File(working), hash);
    }

    // ── Finalize happy path (text) + evidence only (no Run completed) ──
    {
      const conv = path.join(root, "conv-fin");
      const generate = path.join(conv, "generate");
      mkdirSync(generate, { recursive: true });
      writeFileSync(path.join(generate, "out.txt"), "deliverable body");
      const store = new MemoryDeliverableStore();
      const contract: TaskContract = {
        version: 1,
        taskKind: "text",
        requiredDeliverables: [
          { id: "note", mime: "text/plain", count: 1, qualityProfile: "generic" },
        ],
        expectationSnapshot: {},
      };
      const result = await finalizeDeliverables(
        [{ name: "out.txt", contractDeliverableId: "note" }],
        { runId: "run-text", outputDir: generate, conversationFilesDir: conv, taskContract: contract },
        { store, evidenceSink: store }
      );
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error(result.error);
      assert.equal(result.gate.ok, true);
      assert.ok(result.evidences[0]?.validationStatus === "passed");
      assert.ok(existsSync(result.finalized[0].deliveredPath));
      assert.ok(result.finalized[0].deliveredPath.includes(`${path.sep}delivered${path.sep}`));
      // 绝不写 Run completed
      assert.ok(!("runStatus" in result));
      assert.ok(!("completed" in result));
    }

    // ── Unknown contractDeliverableId ──
    {
      const conv = path.join(root, "conv-unk");
      const generate = path.join(conv, "generate");
      mkdirSync(generate, { recursive: true });
      writeFileSync(path.join(generate, "x.txt"), "x");
      const r = await finalizeDeliverables(
        [{ name: "x.txt", contractDeliverableId: "nope" }],
        { runId: "r", outputDir: generate, taskContract: baseContract() },
        { store: new MemoryDeliverableStore() }
      );
      assert.equal(r.ok, false);
      if (r.ok) throw new Error("expected fail");
      assert.equal(r.code, "unknown_deliverable_id");
    }

    // ── Incomplete contract: missing required → gate not ok ──
    {
      const conv = path.join(root, "conv-miss");
      const generate = path.join(conv, "generate");
      mkdirSync(generate, { recursive: true });
      writeFileSync(path.join(generate, "a.txt"), "a");
      const contract: TaskContract = {
        version: 1,
        taskKind: "text",
        requiredDeliverables: [
          { id: "a", mime: "text/plain", count: 1, qualityProfile: "generic" },
          { id: "b", mime: "text/plain", count: 1, qualityProfile: "generic" },
        ],
        expectationSnapshot: {},
      };
      const store = new MemoryDeliverableStore();
      const r = await finalizeDeliverables(
        [{ name: "a.txt", contractDeliverableId: "a" }],
        { runId: "run-miss", outputDir: generate, conversationFilesDir: conv, taskContract: contract },
        { store, evidenceSink: store }
      );
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error(r.error);
      assert.equal(r.gate.ok, false);
      if (r.gate.ok) throw new Error("expected missing");
      assert.deepEqual(r.gate.missing, ["b"]);
    }

    // ── xlsx fixture open (no recalc required) ──
    if (existsSync(formulaOk)) {
      const conv = path.join(root, "conv-xlsx");
      const generate = path.join(conv, "generate");
      mkdirSync(generate, { recursive: true });
      const dest = path.join(generate, "book.xlsx");
      copyFileSync(formulaOk, dest);
      const store = new MemoryDeliverableStore();
      const r = await finalizeDeliverables(
        [{ name: "book.xlsx", contractDeliverableId: "workbook" }],
        {
          runId: "run-xlsx",
          outputDir: generate,
          conversationFilesDir: conv,
          taskContract: baseContract(),
        },
        { store, evidenceSink: store }
      );
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      if (r.ok) {
        assert.ok(existsSync(r.finalized[0].deliveredPath));
        assert.equal(sha256File(r.finalized[0].deliveredPath), sha256File(dest));
      }
    }

    // ── SQLite store transaction + migration DDL ──
    {
      const dbPath = path.join(root, "q1.db");
      const db = new DatabaseSync(dbPath);
      upDeliverablesV22(db);
      const store = new SqliteDeliverableStore(db);
      const conv = path.join(root, "conv-db");
      const generate = path.join(conv, "generate");
      mkdirSync(generate, { recursive: true });
      writeFileSync(path.join(generate, "db.txt"), "db-body");
      const contract: TaskContract = {
        version: 1,
        taskKind: "text",
        requiredDeliverables: [
          { id: "note", mime: "text/plain", count: 1, qualityProfile: "generic" },
        ],
        expectationSnapshot: {},
      };
      const r = await finalizeDeliverables(
        [{ name: "db.txt", contractDeliverableId: "note" }],
        { runId: "run-db", outputDir: generate, conversationFilesDir: conv, taskContract: contract },
        { store, evidenceSink: store }
      );
      assert.equal(r.ok, true);
      const rows = store.listByRun("run-db");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "delivered");
      assert.equal(store.list("run-db").length, 1);
      db.close();
    }

    // ── Helpers ──
    assert.equal(isDeliveredStoragePath("delivered/run/a.xlsx"), true);
    assert.equal(isDeliveredStoragePath("generate/a.xlsx"), false);
    assert.equal(conversationDirFromOutputDir("/tmp/files/1/generate"), path.normalize("/tmp/files/1"));

    console.log("deliverable-quality-gate: all checks passed ✓");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
