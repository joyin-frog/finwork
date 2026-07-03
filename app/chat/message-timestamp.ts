/**
 * messageTimestamp — ISO 时间字符串 → 消息工具条相对时间文字。
 * 格式: 「刚刚」/ 「N 分钟前」/ 「昨天 HH:mm」/ 「M月d日」
 *
 * 不依赖 React,可在 Node.js 环境直接导入测试。
 */
export function messageTimestamp(isoStr: string | null): string {
  if (!isoStr) return "";
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return "";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  // < 2 分钟 → 刚刚
  if (diffMin < 2) return "刚刚";

  // < 60 分钟 → N 分钟前
  if (diffMin < 60) return `${diffMin} 分钟前`;

  // 判断是否是「今天」还是「昨天」还是更早
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const dateMs = date.getTime();

  if (dateMs >= yesterdayStart && dateMs < todayStart) {
    // 昨天
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `昨天 ${hh}:${mm}`;
  }

  if (dateMs >= todayStart) {
    // 今天,但超过 60 分钟(上面已处理 <60 分钟)
    const diffH = Math.floor(diffMin / 60);
    return `${diffH} 小时前`;
  }

  // 更早 → M月d日
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}月${day}日`;
}
