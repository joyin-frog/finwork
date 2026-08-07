/**
 * 财务对话压缩的「关键事实」确定性提取（L8）。
 *
 * 为什么不全交给模型摘要：压缩发生在上下文吃紧时，而财务对话里最不能丢的恰恰是
 * 最容易被摘要抹平的东西——**口径、期间、科目、具体金额**。AS0-19 已经验过这件事
 * （压缩后要保住「不含税收入」与 `(实际-预算)/预算`）。
 *
 * 这里只做规则提取，不调模型：规则的召回不如模型，但**确定**。最终摘要是
 * 「确定性事实块 + 模型叙述」，事实块负责不丢数，叙述负责可读。
 */

export type CompactionFacts = {
  /** 金额（带前后文），如「不含税收入 1,234,567.89 元」。 */
  amounts: string[];
  /** 期间：2026-07 / 2026年7月 / 2026Q3 / 本月 等。 */
  periods: string[];
  /** 口径与科目类关键词命中的原句。 */
  conventions: string[];
};

/** 口径类关键词：命中即整句保留（这些句子丢了，后续计算口径就会漂）。 */
const CONVENTION_KEYWORDS = [
  "口径", "含税", "不含税", "税率", "科目", "会计科目", "凭证",
  "折旧", "摊销", "权责发生制", "收付实现制", "汇率", "币种",
  "预算", "环比", "同比", "毛利", "净利",
];

// 金额：至少一位数字，允许千分位与小数，后接币种/单位词。
const AMOUNT_RE = /(?:[¥$€£]\s*)?\d[\d,]*(?:\.\d+)?\s*(?:元|万元|亿元|美元|港元|欧元|RMB|CNY|USD)?/g;
const AMOUNT_UNIT_RE = /(?:[¥$€£]|元|万元|亿元|美元|港元|欧元|RMB|CNY|USD|%)/;
const PERIOD_RE =
  /(?:\d{4}\s*[-/年]\s*\d{1,2}\s*月?(?:\s*[-/]\s*\d{1,2}\s*日?)?|\d{4}\s*年|\d{4}\s*Q[1-4]|[第本上下]\s*[一二三四1-4]?\s*(?:季度|月|年度))/g;

export function extractCompactionFacts(texts: string[], limit = 40): CompactionFacts {
  const amounts = new Set<string>();
  const periods = new Set<string>();
  const conventions = new Set<string>();

  for (const raw of texts) {
    const text = (raw ?? "").trim();
    if (!text) continue;

    for (const period of text.match(PERIOD_RE) ?? []) periods.add(normalize(period));

    // 金额带上前文若干字，否则「1,234,567」这种孤零零的数字没有意义。
    for (const match of text.matchAll(AMOUNT_RE)) {
      const value = match[0].trim();
      // 必须带币种/单位，否则会把年份、编号、序号全都当成金额。
      if (!AMOUNT_UNIT_RE.test(value)) continue;
      const start = Math.max(0, (match.index ?? 0) - 16);
      const context = text.slice(start, (match.index ?? 0) + value.length).replace(/\s+/g, " ").trim();
      amounts.add(context);
    }

    for (const sentence of splitSentences(text)) {
      if (CONVENTION_KEYWORDS.some((keyword) => sentence.includes(keyword))) {
        conventions.add(normalize(sentence).slice(0, 120));
      }
    }
  }

  return {
    amounts: [...amounts].slice(0, limit),
    periods: [...periods].slice(0, limit),
    conventions: [...conventions].slice(0, limit),
  };
}

/** 事实为空时返回空串——不产出只有标题没有内容的噪声块。 */
export function formatFactsBlock(facts: CompactionFacts): string {
  const sections: string[] = [];
  if (facts.conventions.length) sections.push(`口径与科目：\n${bullets(facts.conventions)}`);
  if (facts.periods.length) sections.push(`涉及期间：${facts.periods.join("、")}`);
  if (facts.amounts.length) sections.push(`金额：\n${bullets(facts.amounts)}`);
  if (sections.length === 0) return "";
  return ["<关键事实 note=\"确定性提取，压缩时不得丢失\">", ...sections, "</关键事实>"].join("\n");
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function splitSentences(text: string): string[] {
  return text
    .split(/[。；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
