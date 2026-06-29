import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const cleanupTestPromise = (async () => {
  const root = mkdtempSync(path.join(tmpdir(), "finance-agent-cleanup-test-"));
  // getAppDataDir() 优先读 FINANCE_AGENT_APP_DATA_DIR(再回落 FINANCE_AGENT_DATA_DIR)。
  // 必须设这个高优先级变量,否则其它测试遗留的 APP_DATA_DIR 会盖过本测试 → 扫错目录。
  const origAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const origData = process.env.FINANCE_AGENT_DATA_DIR;
  const origFiles = process.env.FINANCE_AGENT_FILES_DIR;
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;
  delete process.env.FINANCE_AGENT_DATA_DIR; // 排除回落变量干扰
  delete process.env.FINANCE_AGENT_FILES_DIR; // FILES_DIR 会绕过 /<id> 后缀,必须清掉

  try {
    const { scheduleCleanup, purgeStaleOutputDirs } = await import("../lib/runtime/cleanup.ts");

    // ── 1. scheduleCleanup 是 no-op:不抛错 ──────────────────────────────
    assert.doesNotThrow(() => scheduleCleanup("/whatever", 1000), "scheduleCleanup 应为安全 no-op");

    // ── 2. 父目录不存在时:best-effort,不抛错 ────────────────────────────
    assert.doesNotThrow(() => purgeStaleOutputDirs(1000), "无 files 目录时不应抛错");

    // 构造 <root>/files/<conv>/generate 结构
    const filesDir = path.join(root, "files");
    const mkGenerate = (conv: string) => {
      const gen = path.join(filesDir, conv, "generate");
      mkdirSync(gen, { recursive: true });
      writeFileSync(path.join(gen, "out.txt"), "x");
      return gen;
    };

    const staleGen = mkGenerate("conv-stale");
    const freshGen = mkGenerate("conv-fresh");
    // 无 generate 子目录的会话目录:应被安全跳过
    mkdirSync(path.join(filesDir, "conv-nogen"), { recursive: true });

    // 把 stale 的 generate mtime 调到 48h 前(写文件后再设,避免被覆盖)
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(staleGen, old, old);

    // ── 3. 仅清理超过 maxAge 的 generate,保留新的与无关目录 ──────────────
    purgeStaleOutputDirs(24 * 3600_000);

    assert.equal(existsSync(staleGen), false, "超过 24h 的 generate 应被删除");
    assert.equal(existsSync(freshGen), true, "新的 generate 不应被删除");
    assert.equal(existsSync(path.join(filesDir, "conv-nogen")), true, "无 generate 的目录应被跳过保留");

    // ── 4. maxAge 极大时:即使旧目录也不删 ──────────────────────────────
    const staleGen2 = mkGenerate("conv-stale-2");
    utimesSync(staleGen2, old, old);
    purgeStaleOutputDirs(365 * 86400_000); // 一年
    assert.equal(existsSync(staleGen2), true, "maxAge 远大于目录年龄时不应删除");
  } finally {
    if (origAppData === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = origAppData;
    if (origData !== undefined) process.env.FINANCE_AGENT_DATA_DIR = origData;
    if (origFiles !== undefined) process.env.FINANCE_AGENT_FILES_DIR = origFiles;
    rmSync(root, { recursive: true, force: true });
  }

  console.log("cleanup: all 4 checks passed ✓");
})();
