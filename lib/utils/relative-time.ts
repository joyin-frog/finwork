/** ISO 时间字符串 → 中文相对时间("刚刚"/"N 分钟前"/…)。四处内联实现阈值不一致(review 修复,2026-07-02)。 */
export function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 60) return min <= 1 ? "刚刚" : `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}
