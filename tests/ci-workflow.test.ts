import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// WP6 / E1: CI 门存在且步骤齐全；typecheck 由 CI 独立步骤真实执行。
export const ciWorkflowTestPromise = (async () => {
  // ── AC6.1: CI 门齐全 —— 校验步骤落在可复用 ci-verify.yml;ci.yml 负责触发 + 路由 ──
  // (CI 重构后:ci.yml = 并发取消 + 路径探测 + 调 ci-verify.yml;实际 install/lint/
  //  typecheck/test 步骤在 ci-verify.yml 的并行 job 里。)
  const ci = readFileSync(".github/workflows/ci.yml", "utf-8");
  const verify = readFileSync(".github/workflows/ci-verify.yml", "utf-8");
  for (const step of [
    "pnpm install --frozen-lockfile",
    "pnpm run lint",
    "pnpm run typecheck",
    "pnpm test",
  ]) {
    assert.ok(verify.includes(step), `AC6.1 FAIL: ci-verify.yml 缺少步骤 ${step}`);
  }
  assert.ok(/on:\s/.test(ci) && ci.includes("pull_request"), "AC6.1 FAIL: ci.yml 应在 PR 上触发");
  assert.ok(ci.includes("ci-verify.yml"), "AC6.1 FAIL: ci.yml 应通过 ci-verify.yml 跑校验");

  // ── AC6.2: package.json 有 typecheck 脚本；实际执行由 CI 的独立步骤负责 ──
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.typecheck, "AC6.2 FAIL: 缺少 typecheck 脚本");

  // ── AC7: CI 守护者守护——windows_smoke job + release windows 矩阵 ──────
  // 断言 ci-verify.yml 含 windows_smoke job 且其步骤含 windows-smoke.mjs
  assert.ok(verify.includes("windows_smoke"), "AC7 FAIL: ci-verify.yml 应包含 windows_smoke job");
  assert.ok(verify.includes("windows-smoke.mjs"), "AC7 FAIL: ci-verify.yml 的 windows_smoke 步骤应包含 windows-smoke.mjs");

  // 断言 release.yml 含 windows-latest 矩阵项
  const release = readFileSync(".github/workflows/release.yml", "utf-8");
  assert.ok(release.includes("windows-latest"), "AC7 FAIL: release.yml 应包含 windows-latest 矩阵项");

  console.log("ci-workflow: all checks passed ✓");
})();
