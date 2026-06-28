// tax-incentive skill 的 tax_calc.py(增值税/企业所得税)自测守护:经 venv python 跑
// selftest_tax_calc.py(VAT/CIT 法定税率直算结果钉住)进 CI。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const taxCalcScriptTestPromise = (async () => {
  const script = path.join(process.cwd(), "agent-skills/skills/tax-incentive/scripts/selftest_tax_calc.py");
  let stdout = "";
  try {
    stdout = execFileSync(getPythonPath(), [script], { encoding: "utf-8" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    assert.fail(`tax_calc 自测非零退出:\n${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`);
  }
  assert.ok(stdout.includes("PASS"), `tax_calc 自测应输出 PASS,实际:\n${stdout}`);
  console.log("tax-calc-script: tax_calc.py VAT/CIT ✓");
})();
