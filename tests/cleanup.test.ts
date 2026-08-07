import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// purgeStaleOutputDirs 只清 tmpdir 下的 finance-agent-output-* 历史回落目录（无会话
// outputDir 时才落这里,没人引用)。会话内 <files>/<conv>/generate 是持久产物(登记进
// chat_attachments、由 /api/files 与文件库供文件),绝不能被它触碰——PR #21 审查发现早期实现
// 误删该目录,本测试同时守住这条红线。
export const cleanupTestPromise = (async () => {
  // 用 mkdtemp 假 tmpRoot 注入,不真扫共享的 os.tmpdir()
  const fakeTmp = mkdtempSync(path.join(tmpdir(), "fa-cleanup-test-"));
  try {
    const { scheduleCleanup, purgeStaleOutputDirs } = await import("../lib/runtime/cleanup.ts");

    // ── 1. scheduleCleanup 是 no-op:不抛错 ──────────────────────────────
    assert.doesNotThrow(() => scheduleCleanup("/whatever", 1000), "scheduleCleanup 应为安全 no-op");

    // ── 2. tmpRoot 不存在时:best-effort,不抛错 ──────────────────────────
    assert.doesNotThrow(
      () => purgeStaleOutputDirs(1000, path.join(fakeTmp, "absent")),
      "tmpRoot 不存在时不应抛错"
    );

    const old = new Date(Date.now() - 48 * 3600_000);
    const mkOutputDir = (name: string, stale: boolean) => {
      const dir = path.join(fakeTmp, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "out.txt"), "x");
      if (stale) utimesSync(dir, old, old);
      return dir;
    };

    const staleDir = mkOutputDir("finance-agent-output-stale", true);
    const freshDir = mkOutputDir("finance-agent-output-fresh", false);
    // 名字不匹配的旧目录:即使过期也不能动(比如会话 files 目录被挪来这里也不该被扫)
    const unrelatedDir = mkOutputDir("some-other-dir", true);
    // 前缀匹配但是文件不是目录:跳过
    const prefixFile = path.join(fakeTmp, "finance-agent-output-file");
    writeFileSync(prefixFile, "x");
    utimesSync(prefixFile, old, old);

    // ── 3. 仅删超过 maxAge 的 finance-agent-output-* 目录 ────────────────
    purgeStaleOutputDirs(24 * 3600_000, fakeTmp);

    assert.equal(existsSync(staleDir), false, "超过 24h 的 finance-agent-output-* 应被删除");
    assert.equal(existsSync(freshDir), true, "新的 finance-agent-output-* 不应被删除");
    assert.equal(existsSync(unrelatedDir), true, "名字不匹配的目录即使过期也不应被动");
    assert.equal(existsSync(prefixFile), true, "前缀匹配的普通文件应跳过");

    // ── 4. maxAge 极大时:即使旧目录也不删 ──────────────────────────────
    const staleDir2 = mkOutputDir("finance-agent-output-stale-2", true);
    purgeStaleOutputDirs(365 * 86400_000, fakeTmp); // 一年
    assert.equal(existsSync(staleDir2), true, "maxAge 远大于目录年龄时不应删除");
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true });
  }

  console.log("cleanup: all 4 checks passed ✓");
})();
