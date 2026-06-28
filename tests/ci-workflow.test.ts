import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// WP6 / E1: CI 门存在且步骤齐全;typecheck 脚本对主代码真实通过(实跑)。
export const ciWorkflowTestPromise = (async () => {
  // ── AC6.1: CI 门齐全 —— 校验步骤落在可复用 ci-verify.yml;ci.yml 负责触发 + 路由 ──
  // (CI 重构后:ci.yml = 并发取消 + 路径探测 + 调 ci-verify.yml;实际 install/lint/
  //  typecheck/test/golden 步骤在 ci-verify.yml 的并行 job 里。)
  const ci = readFileSync(".github/workflows/ci.yml", "utf-8");
  const verify = readFileSync(".github/workflows/ci-verify.yml", "utf-8");
  for (const step of ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run eval:golden:ci"]) {
    assert.ok(verify.includes(step), `AC6.1 FAIL: ci-verify.yml 缺少步骤 ${step}`);
  }
  assert.ok(/on:\s/.test(ci) && ci.includes("pull_request"), "AC6.1 FAIL: ci.yml 应在 PR 上触发");
  assert.ok(ci.includes("ci-verify.yml"), "AC6.1 FAIL: ci.yml 应通过 ci-verify.yml 跑校验");

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
