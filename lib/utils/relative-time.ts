/** ISO 时间字符串 → 中文相对时间("刚刚"/"N 分钟前"/…)。四处内联实现阈值不一致(review 修复,2026-07-02)。 */

/**
 * SQLite `datetime('now')` 输出 "YYYY-MM-DD HH:MM:SS"——UTC 但无时区标记，
 * 直接 `new Date()` 会被 JS 按本地时区解析，UTC+8 下所有相对时间偏 8 小时
 * (2026-07-08 看板真机验证实锤)。命中该格式时补 "Z" 按 UTC 解析；
 * 带时区标记(Z/±HH:MM)或其它格式的输入原样交给 Date。
 */
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function parseDbTimestamp(s: string): Date {
  return new Date(SQLITE_UTC_RE.test(s) ? `${s.replace(" ", "T")}Z` : s);
}

export function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "";
  const diff = Date.now() - parseDbTimestamp(isoStr).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 60) return min <= 1 ? "刚刚" : `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}
