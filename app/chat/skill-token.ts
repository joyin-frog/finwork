/**
 * 把规范化的技能 token(`/name `)插入草稿的 [start, end) 区间,返回新文本与光标位置。
 * - 经 `/` 打开:start=「/」位置、end=光标(替换已输入的 "/filter")。
 * - 经 + 菜单打开:start=end=光标(纯插入)。
 *
 * 关键:token 必须是「独立词」——前面紧挨非空白时补一个前导空格。否则 chat-page 里
 * 行内高亮与「文本无 token 就剔除引用」的剪枝正则 `(?<!\S)/name(?!\S)` 都匹配不到,
 * 引用会被悄悄丢掉(经 + 菜单选技能时尤其明显)。token 自带尾随空格保证右边界。
 */
export function insertSkillToken(
  text: string,
  start: number,
  end: number,
  skillName: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const token = `${needsLeadingSpace ? " " : ""}/${skillName} `;
  return { text: `${before}${token}${after}`, caret: before.length + token.length };
}
