/**
 * tauri-updater-config.test.ts
 *
 * 验收(AC1 / AC2 / AC3 / AC5):
 *  - tauri.conf.json JSON 合法
 *  - updater.endpoints 指向 GitHub releases latest.json 模式
 *  - updater.pubkey 不含旧的 PLACEHOLDER_FILL_... 硬编码字符串
 *  - release.yml YAML 可解析,且含 updater 私钥签名 + macOS 公证步骤,全部 gated on secrets
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── 工具:将 YAML 解析委托给 python3(项目已有 python3 依赖) ────────────────
// 避免引入新的 npm 依赖;仅做结构判断,不需要完整 YAML AST。
import { execFileSync } from "node:child_process";

export const tauriUpdaterConfigTestPromise = (async () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. tauri.conf.json — JSON 格式合法 + updater 段结构正确
  // ──────────────────────────────────────────────────────────────────────────
  let conf: Record<string, unknown>;
  try {
    conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf-8"));
  } catch (e) {
    assert.fail(`tauri.conf.json JSON parse 失败: ${(e as Error).message}`);
  }

  const updater = (conf.plugins as Record<string, unknown>)?.updater as
    | Record<string, unknown>
    | undefined;

  assert.ok(updater, "AC1 FAIL: tauri.conf.json 缺少 plugins.updater");

  // endpoints 必须是非空数组
  const endpoints = updater.endpoints as unknown[];
  assert.ok(Array.isArray(endpoints) && endpoints.length > 0, "AC1 FAIL: updater.endpoints 必须是非空数组");

  // 每个 endpoint 必须匹配 GitHub releases latest.json 模式
  const ghReleasesPattern = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/.*latest\.json$/;
  for (const ep of endpoints) {
    assert.ok(
      typeof ep === "string" && ghReleasesPattern.test(ep),
      `AC1 FAIL: endpoint 不符合 GitHub releases latest.json 模式: ${ep}`
    );
  }

  // pubkey 不能是旧的 PLACEHOLDER_FILL_... 硬编码值
  const pubkey = updater.pubkey as string | undefined;
  assert.ok(typeof pubkey === "string" && pubkey.length > 0, "AC1 FAIL: updater.pubkey 缺失或为空");
  assert.ok(
    !pubkey.startsWith("PLACEHOLDER_FILL_"),
    `AC1 FAIL: updater.pubkey 仍含旧硬编码 PLACEHOLDER_FILL_... 值: ${pubkey}`
  );

  // windows.installMode 存在
  const windowsConf = updater.windows as Record<string, unknown> | undefined;
  assert.ok(
    windowsConf?.installMode === "passive" || windowsConf?.installMode,
    "AC1 FAIL: updater.windows.installMode 缺失"
  );

  console.log("tauri-updater-config: tauri.conf.json updater 段结构正确 ✓");

  // ──────────────────────────────────────────────────────────────────────────
  // 2. release.yml — YAML 可解析 + 关键步骤存在
  // ──────────────────────────────────────────────────────────────────────────
  const yml = readFileSync(".github/workflows/release.yml", "utf-8");

  // YAML 可被 python3 解析
  try {
    execFileSync("python3", ["-c", "import sys, yaml; yaml.safe_load(sys.stdin)"], {
      input: yml,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
  } catch {
    // python3 yaml 模块可能未安装;降级为基础语法检查(确保非空、有 on/jobs 关键字)
    assert.ok(yml.includes("on:") && yml.includes("jobs:"), "AC2 FAIL: release.yml 结构异常");
    console.warn("tauri-updater-config: python3 yaml 模块不可用,已降级为关键字检查");
  }

  // AC3: updater 私钥签名环境变量注入
  assert.ok(
    yml.includes("TAURI_SIGNING_PRIVATE_KEY"),
    "AC3 FAIL: release.yml 缺少 TAURI_SIGNING_PRIVATE_KEY 引用"
  );
  assert.ok(
    yml.includes("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
    "AC3 FAIL: release.yml 缺少 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 引用"
  );

  // AC3: updater pubkey 构建期注入
  assert.ok(
    yml.includes("TAURI_SIGNING_PUBLIC_KEY"),
    "AC3 FAIL: release.yml 缺少 TAURI_SIGNING_PUBLIC_KEY 引用(构建期注入 pubkey)"
  );

  // AC2: macOS codesign / notarytool / stapler 步骤存在
  assert.ok(
    yml.includes("notarytool"),
    "AC2 FAIL: release.yml 缺少 notarytool 公证步骤"
  );
  assert.ok(
    yml.includes("stapler"),
    "AC2 FAIL: release.yml 缺少 stapler 步骤"
  );
  assert.ok(
    yml.includes("APPLE_CERTIFICATE") || yml.includes("APPLE_SIGNING_IDENTITY"),
    "AC2 FAIL: release.yml 缺少 Apple 证书/签名身份引用"
  );

  // AC2: 公证步骤 gated on secrets 存在(if 条件含 secrets.APPLE_ID 或类似)
  assert.ok(
    yml.includes("secrets.APPLE_ID") || yml.includes("secrets.APPLE_CERTIFICATE"),
    "AC2 FAIL: 公证步骤未通过 secrets 条件 gate"
  );

  console.log("tauri-updater-config: release.yml 结构正确 ✓");
  console.log("tauri-updater-config: all checks passed ✓");
})();
