/**
 * 金额勾稽校验。
 *
 * 原则:AI 不负责"读准"金额,负责"校验"金额。单据自带冗余(明细Σ=合计=大写),
 * 用数学矛盾暴露废笔/漏读,三者一致才自动通过,不平即标⚠️交人工,不由 AI 擅判。
 *
 * 金额一律整数分(fen)口径,对齐 lib/domain/money.ts。
 */

const DIGITS: Record<string, number> = {
  零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9, 两: 2,
};
const SMALL_UNITS: Record<string, number> = { 拾: 10, 佰: 100, 仟: 1000 };
const BIG_UNITS: Record<string, number> = { 万: 10000, 亿: 100000000 };

/** 大写整数部分 → 元(整数);含非法字符返回 null。 */
function parseIntegerCN(s: string): number | null {
  if (s === "") return 0;
  let total = 0; // 已结算的大节(万/亿)累计
  let section = 0; // 当前节内累计
  let current = 0; // 待落位的数字
  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch];
    } else if (ch in SMALL_UNITS) {
      // "拾"前无数字视为 1(壹拾=拾=10),规范虽写"壹拾"但宽松兼容
      section += (current === 0 ? 1 : current) * SMALL_UNITS[ch];
      current = 0;
    } else if (ch in BIG_UNITS) {
      section += current;
      total += section * BIG_UNITS[ch];
      section = 0;
      current = 0;
    } else {
      return null; // 非法字符 → 无法可靠解析
    }
  }
  return total + section + current;
}

/** 大写小数部分 → 分(0-99);含非法字符返回 null。"整/正"忽略。 */
function parseDecimalCN(s: string): number | null {
  let fen = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch];
    } else if (ch === "角") {
      fen += current * 10;
      current = 0;
    } else if (ch === "分") {
      fen += current;
      current = 0;
    } else if (ch === "整" || ch === "正") {
      // 元整/元正:结束标记,忽略
    } else {
      return null;
    }
  }
  return fen;
}

/** 中文大写金额 → 整数分;无法可靠解析返回 null。 */
export function parseChineseAmount(text: string): number | null {
  if (!text) return null;
  const s = text.trim().replace(/^人民币/, "");
  if (!s) return null;

  const parts = s.split(/[元圆]/);
  const intPart = parts[0];
  const decPart = parts.length >= 2 ? parts.slice(1).join("") : "";

  const yuan = parseIntegerCN(intPart);
  if (yuan === null) return null;
  const fen = parseDecimalCN(decPart);
  if (fen === null) return null;

  return yuan * 100 + fen;
}

export type ReconcileResult =
  | { ok: true; confidence: "high"; valueFen: number }
  | { ok: false; reason: "no_cross_check"; valueFen: number }
  | { ok: false; reason: "mismatch"; mismatch: string; candidates: Array<{ source: string; fen: number }> };

/** 三来源(明细逐行/合计/大写)勾稽;一致→高置信度,不一致→指出对不上处,单来源→无从勾稽。 */
export function reconcileAmount(input: {
  lineItemsFen?: number[];
  totalFen?: number;
  capitalFen?: number;
}): ReconcileResult {
  const sources: Array<{ source: string; fen: number }> = [];
  if (input.lineItemsFen !== undefined) {
    sources.push({ source: "明细", fen: input.lineItemsFen.reduce((a, b) => a + b, 0) });
  }
  if (input.totalFen !== undefined) sources.push({ source: "合计", fen: input.totalFen });
  if (input.capitalFen !== undefined) sources.push({ source: "大写", fen: input.capitalFen });

  if (sources.length === 0) throw new Error("金额缺失:未提供任何金额来源");
  if (sources.some((s) => s.fen <= 0)) throw new Error("金额必须大于 0,0 或负数不生成凭证行");

  // 单来源:无从交叉验证,一律交人工
  if (sources.length < 2) {
    return { ok: false, reason: "no_cross_check", valueFen: sources[0].fen };
  }

  // 全部一致 → 高置信度自动通过
  const allEqual = sources.every((s) => s.fen === sources[0].fen);
  if (allEqual) return { ok: true, confidence: "high", valueFen: sources[0].fen };

  // 不一致:按值分组,多数派为准,少数派即"对不上"处
  const byValue = new Map<number, string[]>();
  for (const s of sources) {
    const list = byValue.get(s.fen) ?? [];
    list.push(s.source);
    byValue.set(s.fen, list);
  }
  let majorityVal = sources[0].fen;
  let majoritySize = 0;
  for (const [val, list] of byValue) {
    if (list.length > majoritySize) {
      majoritySize = list.length;
      majorityVal = val;
    }
  }
  const mismatch = sources.filter((s) => s.fen !== majorityVal).map((s) => s.source).join("、");
  return { ok: false, reason: "mismatch", mismatch, candidates: sources };
}
