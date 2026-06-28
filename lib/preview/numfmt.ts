/**
 * numfmt.ts — 轻量财务数字格式化工具
 *
 * 把 ExcelJS cell.numFmt 字符串 + 原始数字值格式化为可展示字符串。
 * 无外部依赖;识别不了的格式回落原值字符串,不报错、不猜。
 *
 * 支持的常见财务格式:
 *   #,##0          千分位整数
 *   #,##0.00       千分位两位小数
 *   ¥#,##0.00 / ¥#,##0 / "$"#,##0.00  货币
 *   0%             整数百分比
 *   0.0%           一位小数百分比
 *   0.00%          两位小数百分比
 *   0              整数(无千分位)
 *   0.00           两位小数
 *   @              文本,原样
 *   日期格式        回落给调用方(ExcelJS 已把 Date 转为 string)
 *   #,##0;[Red]-#,##0  负数红字(展示层仅格式化数字,颜色由 CSS 处理)
 *   #,##0;(#,##0)   负数括号
 */

export type FormatResult = {
  text: string;
  /** true 表示数字为负,CSS 可据此加红色 */
  negative: boolean;
  /** true 表示这是一个数字格式(可用于右对齐判定) */
  isNumeric: boolean;
};

/**
 * 格式化数字单元格。
 * @param value  ExcelJS cell 的 result/原始值(已是 number | string | null)
 * @param numFmt ExcelJS cell.numFmt(可能为 undefined/"")
 */
export function formatNumber(value: unknown, numFmt?: string): FormatResult {
  // 如果不是数字,直接回落字符串
  if (typeof value !== "number") {
    return { text: value == null ? "" : String(value), negative: false, isNumeric: false };
  }

  const fmt = (numFmt ?? "").trim();
  if (!fmt || fmt === "General" || fmt === "general") {
    // General:整数显示整数,小数显示小数(最多保留12位有效数)
    return { text: String(value), negative: value < 0, isNumeric: true };
  }

  // 纯文本格式
  if (fmt === "@") {
    return { text: String(value), negative: false, isNumeric: false };
  }

  // 百分比格式:先乘100
  const pctMatch = fmt.match(/^(0+)(\.0+)?%$/);
  if (pctMatch) {
    const decimalStr = pctMatch[2] ?? "";
    const decimals = decimalStr.length > 0 ? decimalStr.length - 1 : 0;
    const pct = value * 100;
    return {
      text: pct.toFixed(decimals) + "%",
      negative: value < 0,
      isNumeric: true,
    };
  }

  // 解析正/负分段: "正格式;负格式" 或 "正格式;[Red]负格式" 或 "正格式;(负格式)"
  const segments = splitFormatSegments(fmt);
  const posFormat = segments[0] ?? fmt;
  const negFormat = segments[1]; // 可能有负格式段

  const isNeg = value < 0;
  const absValue = Math.abs(value);

  if (isNeg && negFormat !== undefined) {
    const negResult = applyPositiveFormat(negFormat.replace(/^\[Red\]/i, ""), absValue);
    // 括号格式:原样返回(格式里已包含括号)
    if (negFormat.includes("(")) {
      return { text: negResult, negative: true, isNumeric: true };
    }
    return { text: "-" + negResult, negative: true, isNumeric: true };
  }

  const text = applyPositiveFormat(posFormat, absValue);
  return { text: isNeg ? "-" + text : text, negative: isNeg, isNumeric: true };
}

/**
 * 判断 numFmt 字符串是否属于数字格式(用于对齐判定)。
 */
export function isNumericFormat(numFmt?: string): boolean {
  if (!numFmt || numFmt === "@") return false;
  if (numFmt === "General" || numFmt === "general") return true;
  // 包含 0 # . % 货币符的一般是数字格式;排除纯文本
  return /[0#%]/.test(numFmt) && !numFmt.startsWith('"');
}

// ─── 内部工具 ────────────────────────────────────────────────────────────────

/**
 * 把 "正;负" 或 "正;负;零" 格式字符串按分号拆开,但忽略双引号内的分号。
 */
function splitFormatSegments(fmt: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of fmt) {
    if (ch === '"') { inQuote = !inQuote; current += ch; }
    else if (ch === ";" && !inQuote) { parts.push(current); current = ""; }
    else { current += ch; }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * 把一个正格式段应用到绝对值上。
 * 支持:千分位、小数位、货币前缀(¥ / $ / "xxx")、百分比。
 */
function applyPositiveFormat(fmt: string, absValue: number): string {
  // 剥掉括号包裹(负数括号格式 "(#,##0)")
  const inner = fmt.replace(/^\((.+)\)$/, "$1");

  // 提取货币前缀:¥ 直接提取;双引号包裹的字符串(如 "$")提取
  let currencyPrefix = "";
  let fmtRest = inner;

  // 处理 "xxx"前缀
  const quotedPrefix = fmtRest.match(/^"([^"]*)"(.*)$/);
  if (quotedPrefix) {
    currencyPrefix = quotedPrefix[1];
    fmtRest = quotedPrefix[2];
  } else if (fmtRest.startsWith("¥") || fmtRest.startsWith("$")) {
    currencyPrefix = fmtRest[0];
    fmtRest = fmtRest.slice(1);
  }

  // 去掉剩余的引号包裹后缀(如 # "元")
  fmtRest = fmtRest.replace(/"[^"]*"/g, (m) => m.slice(1, -1));

  // 百分比(段内)
  const pctInner = fmtRest.match(/^(#*0+)(\.0+)?%$/);
  if (pctInner) {
    const decimalStr = pctInner[2] ?? "";
    const decimals = decimalStr.length > 0 ? decimalStr.length - 1 : 0;
    return currencyPrefix + (absValue * 100).toFixed(decimals) + "%";
  }

  // 确定是否千分位
  const useComma = fmtRest.includes(",");

  // 确定小数位数
  const decimalDot = fmtRest.indexOf(".");
  let decimals = 0;
  if (decimalDot >= 0) {
    const decimalPart = fmtRest.slice(decimalDot + 1).replace(/[^0#]/g, "");
    decimals = decimalPart.length;
  }

  // 格式化数字
  const fixed = absValue.toFixed(decimals);
  const parts = fixed.split(".");
  let intPart = parts[0];
  const fracPart = parts[1];

  if (useComma) {
    intPart = addThousandSeparators(intPart);
  }

  const numStr = fracPart !== undefined ? intPart + "." + fracPart : intPart;
  return currencyPrefix + numStr;
}

function addThousandSeparators(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
