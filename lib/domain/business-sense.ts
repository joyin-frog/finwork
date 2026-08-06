/**
 * 业务常识勾稽:确定性断言查不到的「数字本身不可能」。
 *
 * 来源(2026-08-04 历史财务评测 HISTORY-005):确定性分满分 1.0、硬门全过,交付文档里
 * 却写着「前 5 大客户占 Q1 收入 116%」「Q4 单季营业利润占全年利润总额 135%」。
 * 单元格值和公式逐个都对——错的是数字合不合理,而当时只有 LLM judge 在看这件事。
 *
 * 本模块是纯函数,不做 IO,供评测断言与后续 T3 输出校验复用。
 */

/** 命中的一处不可能占比。 */
export type ImpossibleShare = {
  /** 原文片段(百分比 + 其前置语境),用于报告定位 */
  excerpt: string;
  /** 解析出的百分比数值 */
  percent: number;
};

/** 占比语义:这类百分比的上限天然是 100%。 */
const SHARE_HINTS = ["占比", "占", "比重", "份额", "构成", "权重"];

/**
 * 变动 / 达成语义:这类百分比合法地可以超过 100%(同比增长 135% 完全正常),
 * 一律排除,否则会把正常增长误报成业务矛盾。
 */
const CHANGE_HINTS = [
  "同比", "环比", "增长", "增幅", "增速", "上升", "提升", "涨",
  "下降", "降幅", "减少", "跌", "变动", "变化",
  "完成率", "达成率", "达成", "完成", "超额", "执行率",
];

/** 百分比之前多少字符算「近语境」。太长会拉进无关句子,太短会漏掉长定语。 */
const CONTEXT_WINDOW = 16;

/**
 * 分句边界:语境不得跨句。
 * 「A占比116%；B同比增长300%；C占总额142%」里,若窗口跨过分号,C 那处会被 B 的
 * 「同比增长」误排除。**换行不算边界**——表格/排版经常把标签和数值断成两行。
 */
const CLAUSE_BREAK = /[。；;，,、！？!?（）()]/g;

/**
 * 容差:5 个各自四舍五入的占比相加可能显示成 100.1%,那是精度不是矛盾。
 * 超过这个幅度才算真的不可能。
 */
const SHARE_TOLERANCE_PCT = 0.5;

/**
 * 找出文本中所有「占比类百分比 > 100%」。
 *
 * 只在百分比前的近语境里出现占比词、且不出现变动词时才判定,宁可漏报也不误报——
 * 误报会把正常的增长率打成失败。
 */
export function findImpossibleShares(text: string): ImpossibleShare[] {
  if (!text) return [];
  const hits: ImpossibleShare[] = [];
  const pattern = /(\d[\d,]*(?:\.\d+)?)\s*%/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const percent = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(percent) || percent <= 100 + SHARE_TOLERANCE_PCT) continue;
    const start = Math.max(0, match.index - CONTEXT_WINDOW);
    const rawContext = clauseTail(text.slice(start, match.index));
    // 跨行/多空格的语境要先压平,否则「占\n全年利润总额」这种会漏判。
    const context = rawContext.replace(/\s+/g, "");
    if (CHANGE_HINTS.some((hint) => context.includes(hint))) continue;
    if (!SHARE_HINTS.some((hint) => context.includes(hint))) continue;
    hits.push({
      excerpt: `${rawContext}${match[0]}`.replace(/\s+/g, " ").trim(),
      percent,
    });
  }
  return hits;
}

/** 取最后一个分句边界之后的片段;没有边界就原样返回。 */
function clauseTail(context: string): string {
  CLAUSE_BREAK.lastIndex = 0;
  let cut = 0;
  let match: RegExpExecArray | null;
  while ((match = CLAUSE_BREAK.exec(context)) !== null) {
    cut = match.index + match[0].length;
  }
  return context.slice(cut);
}
