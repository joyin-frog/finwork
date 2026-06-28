// 数值校验:工具金额输出的事后 sanity 网(红线 2 校验侧 + 红线 4 不静默)。
// 不替代确定性计算,只在结果不自洽时告警,避免算错静默通过。
// 注意:detail 由调用方提供 label,金额与姓名可(已在工具正常输出中),但不得放入身份证/银行卡等需硬遮标识符。

/** 1 分容差:吸收分摊尾差与浮点误差,避免误报。 */
const CENT_TOLERANCE = 1;

export type NumericIssue = { kind: "sum" | "precision" | "value"; detail: string };

/** 元→整数分(四舍五入到分)。 */
function toCents(yuan: number): number {
  return Math.round(yuan * 100);
}

/**
 * 金额是否为合法"分"精度(以元为单位时最多 2 位小数)且为有限数。
 * 命中返回问题,正常返回 null。
 */
export function checkMoneyPrecision(valueYuan: number, label = "金额"): NumericIssue | null {
  if (!Number.isFinite(valueYuan)) {
    return { kind: "value", detail: `${label} 非有限数` };
  }
  if (Math.abs(valueYuan * 100 - toCents(valueYuan)) > 1e-6) {
    return { kind: "precision", detail: `${label} 超出分精度(${valueYuan})` };
  }
  return null;
}

/**
 * 明细之和是否等于合计(容差 1 分)。total/parts 单位=元。
 * 命中返回问题,正常返回 null。
 */
export function checkSumConsistent(total: number, parts: number[], label = "合计"): NumericIssue | null {
  if (!Number.isFinite(total) || parts.some((p) => !Number.isFinite(p))) {
    return { kind: "value", detail: `${label} 含非有限数` };
  }
  const sumCents = parts.reduce((acc, p) => acc + toCents(p), 0);
  const totalCents = toCents(total);
  if (Math.abs(sumCents - totalCents) > CENT_TOLERANCE) {
    return {
      kind: "sum",
      detail: `${label} 明细之和(${(sumCents / 100).toFixed(2)})≠合计(${(totalCents / 100).toFixed(2)})`,
    };
  }
  return null;
}

/** 跑一组检查,返回所有命中的问题(空数组=全部通过)。null 表示该项通过。 */
export function collectNumericIssues(checks: Array<NumericIssue | null>): NumericIssue[] {
  return checks.filter((c): c is NumericIssue => c !== null);
}
