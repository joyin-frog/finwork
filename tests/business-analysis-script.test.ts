// business-analysis skill 的 bundled 脚本 parse_statements.py 的确定性守护:
// 经 venv python 跑脚本自测(构造合成会小企表→解析→断言),把"固定脚本"的确定性纳入 CI。
// 这是"确定性数学也可以是 skill 脚本(而非 TS 工具),但必须有测试守护"的样板。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const businessAnalysisScriptTestPromise = (async () => {
  const script = path.join(
    process.cwd(),
    "agent-skills/skills/business-analysis/scripts/selftest_parse_statements.py"
  );
  let stdout = "";
  try {
    stdout = execFileSync(getPythonPath(), [script], { encoding: "utf-8" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    assert.fail(`parse_statements 自测非零退出:\n${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`);
  }
  assert.ok(stdout.includes("PASS"), `parse_statements 自测应输出 PASS,实际:\n${stdout}`);
  console.log("business-analysis-script: parse_statements 确定性自测通过 ✓");
})();
