import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getPythonPath } from "../lib/runtime/paths.ts";

// Verifies analyze_csv accumulates in integer cents (no float drift).
// Also CR-S1: .xls routes to xlrd, never openpyxl.
export const pythonWorkerTestPromise = (async () => {
  const fixturePath = path.join(tmpdir(), `finance-agent-csv-test-${Date.now()}.csv`);
  const pythonPath = getPythonPath();
  if (!existsSync(pythonPath)) {
    console.log("python-worker: python missing, skip ⚠");
    return;
  }
  const workerPath = path.join(process.cwd(), "workers", "finance_worker.py");

  try {
    writeFileSync(fixturePath, "amount,category,invoice_no\n0.1,A,1\n0.1,A,2\n0.1,A,3\n", "utf-8");

    const stdout = execFileSync(pythonPath, [workerPath, "analyze-csv", fixturePath], { encoding: "utf-8" });
    const out = JSON.parse(stdout) as { row_count: number; by_category: Record<string, number>; warnings: unknown[] };

    assert.equal(out.row_count, 3, "pythonWorker: row_count should be 3");
    assert.equal(out.by_category.A, 0.3, "pythonWorker: by_category.A must be exactly 0.3 (no float drift)");
  } finally {
    try { unlinkSync(fixturePath); } catch { /* already gone */ }
  }

  // ── CR-S1: .xls must use xlrd (openpyxl never sees .xls) ──────────────
  {
    const xls = path.join(process.cwd(), "tests", "fixtures", "spreadsheet", "legacy-input.xls");
    assert.ok(existsSync(xls), "xls fixture must exist");

    const text = execFileSync(pythonPath, [workerPath, "extract-text", xls], { encoding: "utf-8" });
    assert.ok(text.includes("Name"), "xls extract should include header Name");
    assert.ok(text.includes("42"), "xls extract should include cell 42");

    const inspected = JSON.parse(
      execFileSync(pythonPath, [workerPath, "inspect-excel", xls], { encoding: "utf-8" })
    ) as { engine?: string; format?: string; sheets: Array<{ headers: unknown[] }> };
    assert.equal(inspected.engine, "xlrd", "inspect-excel on .xls must report engine=xlrd");
    assert.equal(inspected.format, "xls");
    assert.ok(inspected.sheets[0]?.headers?.includes("Name"));

    // Guard: openpyxl.load_workbook must not be reachable for .xls — prove by feeding .xls
    // to a tiny script that only openpyxl would accept OOXML; worker path above already uses xlrd.
    // convert-xls roundtrip
    const dir = mkdtempSync(path.join(tmpdir(), "fa-xls-"));
    try {
      const outXlsx = path.join(dir, "out.xlsx");
      const conv = JSON.parse(
        execFileSync(pythonPath, [workerPath, "convert-xls", xls, outXlsx], { encoding: "utf-8" })
      ) as { ok: boolean; outputPath?: string };
      assert.equal(conv.ok, true, "convert-xls should succeed");
      assert.ok(existsSync(outXlsx));
      // openpyxl can open the converted file
      const probe = execFileSync(
        pythonPath,
        ["-c", `import openpyxl; wb=openpyxl.load_workbook(r"${outXlsx}"); print(wb.active['A1'].value)`],
        { encoding: "utf-8" }
      ).trim();
      assert.equal(probe, "Name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // selfcheck lists xlrd
    const selfcheck = JSON.parse(
      execFileSync(pythonPath, [workerPath, "--selfcheck"], { encoding: "utf-8" })
    ) as { deps: Record<string, string>; missing: string[] };
    assert.ok("xlrd" in selfcheck.deps, "selfcheck must report xlrd");
    assert.ok(!selfcheck.missing.includes("xlrd"));
  }

  // Negative: openpyxl cannot open .xls — documents why routing matters
  {
    const xls = path.join(process.cwd(), "tests", "fixtures", "spreadsheet", "legacy-input.xls");
    let failed = false;
    try {
      execFileSync(
        pythonPath,
        ["-c", `import openpyxl; openpyxl.load_workbook(r"${xls}")`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch {
      failed = true;
    }
    assert.equal(failed, true, "openpyxl must fail on .xls (routing justification)");
  }

  // 通用代码入口已下线：worker 不再接受 stdin Python。
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-nogui-"));
    try {
      let blocked = false;
      let errText = "";
      try {
        execFileSync(pythonPath, [workerPath, "run"], {
          encoding: "utf-8",
          cwd: dir,
          env: { ...process.env, FINANCE_AGENT_OUTPUT_DIR: dir },
          input: "print(1+1)\n",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        blocked = true;
        const err = e as { stderr?: string; stdout?: string; message?: string };
        errText = `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`;
      }
      assert.equal(blocked, true, "generic stdin Python must be rejected");
      assert.match(errText, /usage: finance_worker|不支持/, "rejection should expose fixed-command usage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("python-worker: all checks passed ✓");
})();
