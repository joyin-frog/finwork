// finance-analysis skill 的对账固定脚本 reconciliation.py 的 parity 守护:
// 经 venv python 跑 selftest_reconciliation.py(AC2.1/2.2/2.3/2.5 + 严格日期 与原 TS 一致)进 CI。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const reconciliationScriptTestPromise = (async () => {
  const script = path.join(
    process.cwd(),
    "agent-skills/skills/finance-analysis/scripts/selftest_reconciliation.py"
  );
  let stdout = "";
  try {
    stdout = execFileSync(getPythonPath(), [script], { encoding: "utf-8" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    assert.fail(`reconciliation parity 自测非零退出:\n${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`);
  }
  assert.ok(stdout.includes("PASS"), `reconciliation parity 自测应输出 PASS,实际:\n${stdout}`);
  console.log("reconciliation-script: reconciliation.py parity ✓");
})();
