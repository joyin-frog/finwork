/**
 * relative-time 测试
 *
 * 运行：npx tsx tests/relative-time.test.ts
 *
 * 覆盖：
 * - RT1 SQLite UTC 串（无时区标记）按 UTC 解析——不再被本地时区偏移
 * - RT2 带 Z 标记的 ISO 串行为不变
 * - RT3 null/空串回退
 */
import assert from "node:assert/strict";

export const relativeTimeTestPromise = (async () => {
  const { relativeTime, parseDbTimestamp } = await import("../lib/utils/relative-time.ts");

  // ── RT1: SQLite "YYYY-MM-DD HH:MM:SS"（UTC 无标记）按 UTC 解析 ─────────────
  {
    // 构造"30 分钟前"的 UTC 时刻，按 SQLite datetime('now') 的格式序列化
    const utc = new Date(Date.now() - 30 * 60_000);
    const sqliteStr = utc.toISOString().slice(0, 19).replace("T", " ");
    assert.equal(
      parseDbTimestamp(sqliteStr).getTime(),
      Math.floor(utc.getTime() / 1000) * 1000,
      "RT1 FAIL: SQLite UTC 串解析后的时间戳应与原 UTC 时刻一致（秒精度）"
    );
    const label = relativeTime(sqliteStr);
    assert.equal(label, "30 分钟前", `RT1 FAIL: 30 分钟前的 SQLite UTC 串应显示"30 分钟前"，实际"${label}"（偏 8 小时=时区 bug 复发）`);
    console.log("relative-time RT1: SQLite UTC 串按 UTC 解析 ✓");
  }

  // ── RT2: 带 Z 的 ISO 串行为不变 ─────────────────────────────────────────────
  {
    const iso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const label = relativeTime(iso);
    assert.equal(label, "2 小时前", `RT2 FAIL: 带 Z 的 ISO 串应显示"2 小时前"，实际"${label}"`);
    console.log("relative-time RT2: 带 Z ISO 串行为不变 ✓");
  }

  // ── RT3: null/空串回退 ──────────────────────────────────────────────────────
  {
    assert.equal(relativeTime(null), "", "RT3 FAIL: null 应回退空串");
    assert.equal(relativeTime(""), "", "RT3 FAIL: 空串应回退空串");
    console.log("relative-time RT3: null/空串回退 ✓");
  }

  console.log("relative-time: all RT1–RT3 ✓");
})();
