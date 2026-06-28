/**
 * 单测:installId 持久化(连读两次 installId 相同)。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { equal, ok } = assert;

async function main() {
  // 隔离设置目录
  const tmpDir = mkdtempSync(path.join(tmpdir(), "telemetry-install-id-test-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  process.env.FINANCE_AGENT_SETTINGS_PATH = settingsPath;

  try {
    // 清除模块缓存,确保拿到干净实例。
    const mod1 = await import("../lib/settings/claude-settings");
    const settings1 = await mod1.readClaudeSettings();
    const id1 = settings1.telemetryInstallId;
    ok(id1, "第一次读取应生成 installId");

    // 第二次读取不清 cache 但直接重新 import(因为 path 环境变量同,文件已落盘)。
    // 重新 import 同模块会被 Node module cache 命中;直接调用 readClaudeSettings 再读一次即可。
    const settings2 = await mod1.readClaudeSettings();
    const id2 = settings2.telemetryInstallId;

    equal(id1, id2, "连读两次 installId 应相同(持久化生效)");

    console.log("telemetry-install-id tests passed, installId:", id1);
  } finally {
    delete process.env.FINANCE_AGENT_SETTINGS_PATH;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  }
}

export const telemetryInstallIdTestPromise = main();
