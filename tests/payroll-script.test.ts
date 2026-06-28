// payroll-calc skill 的固定脚本 payroll.py(累计预扣算法)的 **parity 守护**:
// 经 venv python 跑 selftest_payroll.py(T1-T7 与原 TS 引擎 golden 逐分一致),把
// "核心算数从 TS 迁到脚本、零回归"的证据纳入 CI。算法已不在 TS;tax-cumulative.ts 仅是同步 shell 包装。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const payrollScriptTestPromise = (async () => {
  const script = path.join(
    process.cwd(),
    "agent-skills/skills/payroll-calc/scripts/selftest_payroll.py"
  );
  let stdout = "";
  try {
    stdout = execFileSync(getPythonPath(), [script], { encoding: "utf-8" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    assert.fail(`payroll parity 自测非零退出:\n${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`);
  }
  assert.ok(stdout.includes("PASS"), `payroll parity 自测应输出 PASS,实际:\n${stdout}`);
  console.log("payroll-script: payroll.py 累计预扣 parity(T1-T7 逐分一致)✓");
})();
