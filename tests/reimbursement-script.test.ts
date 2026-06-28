// reimbursement-check skill 固定脚本 reimbursement.py 的 parity 守护:
// 经 venv python 跑 selftest_reimbursement.py(校验+排序 T2/T3/T4 与原 TS golden 逐项一致)进 CI。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const reimbursementScriptTestPromise = (async () => {
  const script = path.join(
    process.cwd(),
    "agent-skills/skills/reimbursement-check/scripts/selftest_reimbursement.py"
  );
  let stdout = "";
  try {
    stdout = execFileSync(getPythonPath(), [script], { encoding: "utf-8" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    assert.fail(`reimbursement parity 自测非零退出:\n${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`);
  }
  assert.ok(stdout.includes("PASS"), `reimbursement parity 自测应输出 PASS,实际:\n${stdout}`);
  console.log("reimbursement-script: reimbursement.py parity(校验+排序逐项一致)✓");
})();
