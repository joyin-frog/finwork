/** 在 haystack 里找 needle 的所有出现位置(大小写不敏感),返回 [start,end) 字符区间。空 needle 返回 []。 */
export function findMatches(haystack: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const q = needle.trim().toLowerCase();
  if (!q) return out;
  const hay = haystack.toLowerCase();
  let i = hay.indexOf(q);
  while (i !== -1) {
    out.push([i, i + q.length]);
    i = hay.indexOf(q, i + q.length); // 不重叠
  }
  return out;
}
