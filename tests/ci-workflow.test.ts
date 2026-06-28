import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// WP6 / E1: CI 门存在且步骤齐全;typecheck 脚本对主代码真实通过(实跑)。
export const ciWorkflowTestPromise = (async () => {
  // ── AC6.1: ci.yml 存在且含 install + lint + typecheck + test + golden ──
  const yml = readFileSync(".github/workflows/ci.yml", "utf-8");
  for (const step of ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run eval:golden:ci"]) {
    assert.ok(yml.includes(step), `AC6.1 FAIL: ci.yml 缺少步骤 ${step}`);
  }
  assert.ok(/on:\s/.test(yml) && yml.includes("pull_request"), "AC6.1 FAIL: ci.yml 应在 PR 上触发");

  // ── AC6.2: package.json 有 typecheck 脚本,且对主代码真实通过 ────────────
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.typecheck, "AC6.2 FAIL: 缺少 typecheck 脚本");

  // 实跑 tsc(排除 tests 的主代码配置),退出非 0 会抛 → 测试失败
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.typecheck.json"], { stdio: "pipe", timeout: 120_000 });
  } catch (error) {
    const out = (error as { stdout?: Buffer; stderr?: Buffer });
    const detail = `${out.stdout?.toString() ?? ""}${out.stderr?.toString() ?? ""}`.slice(0, 2000);
    assert.fail(`AC6.2 FAIL: 主代码 typecheck 未通过:\n${detail}`);
  }

  console.log("ci-workflow: all checks passed ✓");
})();
