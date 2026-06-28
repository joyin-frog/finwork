// Chinese PII patterns
const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "身份证",
    pattern: /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]/g,
    replacement: "[已脱敏:身份证]",
  },
  {
    name: "统一社会信用代码",
    pattern: /\b[0-9A-Z]{2}\d{6}[0-9A-HJ-NP-RTUWXY]{10}\b/g,
    replacement: "[已脱敏:统一社会信用代码]",
  },
  {
    name: "手机号",
    pattern: /1[3-9]\d[ -]?\d{4}[ -]?\d{4}/g,
    replacement: "[已脱敏:手机号]",
  },
  {
    name: "邮箱",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[已脱敏:邮箱]",
  },
  {
    name: "银行卡",
    pattern: /\b\d{4}(?:[ -]?\d){12,15}\b/g,
    replacement: "[已脱敏:银行卡]",
  },
];

export type PiiMatch = {
  name: string;
  count: number;
};

/**
 * Detect and scrub Chinese PII (ID cards, phone numbers, emails, bank cards).
 * Returns scrubbed text and match statistics.
 */
export function scrubPii(text: string): { scrubbed: string; matches: PiiMatch[] } {
  let scrubbed = text;
  const matches: PiiMatch[] = [];

  for (const { name, pattern, replacement } of PII_PATTERNS) {
    const matches_before = scrubbed.match(pattern);
    if (matches_before && matches_before.length > 0) {
      matches.push({ name, count: matches_before.length });
      scrubbed = scrubbed.replace(pattern, replacement);
    }
  }

  return { scrubbed, matches };
}

/** 仅返回脱敏后文本(丢弃命中统计),用于落盘 / 出网前的就地脱敏。 */
export function redact(text: string): string {
  return scrubPii(text).scrubbed;
}
