import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getPythonPath } from "../lib/runtime/paths.ts";

// Verifies analyze_csv accumulates in integer cents (no float drift).
// 0.1 + 0.1 + 0.1 with float addition yields 0.30000000000000004; the fix
// should produce exactly 0.3.
export const pythonWorkerTestPromise = (async () => {
  const fixturePath = path.join(tmpdir(), `finance-agent-csv-test-${Date.now()}.csv`);
  try {
    writeFileSync(fixturePath, "amount,category,invoice_no\n0.1,A,1\n0.1,A,2\n0.1,A,3\n", "utf-8");

    const pythonPath = getPythonPath();
    const workerPath = path.join(process.cwd(), "workers", "finance_worker.py");
    const stdout = execFileSync(pythonPath, [workerPath, "analyze-csv", fixturePath], { encoding: "utf-8" });
    const out = JSON.parse(stdout) as { row_count: number; by_category: Record<string, number>; warnings: unknown[] };

    assert.equal(out.row_count, 3, "pythonWorker: row_count should be 3");
    assert.equal(out.by_category.A, 0.3, "pythonWorker: by_category.A must be exactly 0.3 (no float drift)");

    console.log("python-worker: all checks passed ✓");
  } finally {
    try { unlinkSync(fixturePath); } catch { /* already gone */ }
  }
})();
