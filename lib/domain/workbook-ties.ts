/**
 * 跨表勾稽:确定性核对「一组单元格之和 = 另一组之和」。
 *
 * 规则由调用方声明,引擎不猜。财务勾稽的形态高度一致——
 * 资产合计 = 负债合计 + 所有者权益合计、四个季度合计 = 全年、
 * 现金流量表期末现金 = 资产负债表货币资金——都能写成这一种形式。
 *
 * 读不到值时判 `unverifiable` 而不是 `failed`:缺重算 Provider 导致公式无缓存
 * 是常态,把「没测成」记成「测挂了」会污染结论(见 CONTEXT.md 不变量 2)。
 */

export type TieCheck = {
  label: string;
  /** 等式左边的单元格地址，如 `资产负债表!C59`；多个则求和 */
  left: string[];
  /** 等式右边的单元格地址；多个则求和 */
  right: string[];
  /**
   * 允许的绝对误差。财务报表常见到分位舍入，默认 0.01 元。
   * 需要按比例容忍时用 relativeTolerance。
   */
  tolerance?: number;
  /** 相对容差（占左值的比例），与 tolerance 取较大者 */
  relativeTolerance?: number;
};

export type TieResult = {
  label: string;
  status: "passed" | "failed" | "unverifiable";
  leftValue: number | null;
  rightValue: number | null;
  difference: number | null;
  detail: string;
};

const DEFAULT_TOLERANCE = 0.01;

function sumAddresses(
  addresses: string[],
  values: Record<string, number | string | boolean | null | undefined>,
): { total: number; unreadable: string[] } {
  let total = 0;
  const unreadable: string[] = [];
  for (const address of addresses) {
    const raw = values[address];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      total += raw;
      continue;
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw.replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        total += parsed;
        continue;
      }
    }
    unreadable.push(address);
  }
  return { total, unreadable };
}

export function checkWorkbookTies(
  values: Record<string, number | string | boolean | null | undefined>,
  checks: TieCheck[],
): TieResult[] {
  return checks.map((check) => {
    const left = sumAddresses(check.left, values);
    const right = sumAddresses(check.right, values);
    const unreadable = [...left.unreadable, ...right.unreadable];
    if (unreadable.length) {
      return {
        label: check.label,
        status: "unverifiable" as const,
        leftValue: null,
        rightValue: null,
        difference: null,
        detail: `读不到值，未验证：${unreadable.join("、")}`,
      };
    }
    const difference = left.total - right.total;
    const tolerance = Math.max(
      check.tolerance ?? DEFAULT_TOLERANCE,
      Math.abs(left.total) * (check.relativeTolerance ?? 0),
    );
    const passed = Math.abs(difference) <= tolerance;
    return {
      label: check.label,
      status: passed ? ("passed" as const) : ("failed" as const),
      leftValue: left.total,
      rightValue: right.total,
      difference,
      detail: passed
        ? `${round(left.total)} = ${round(right.total)}`
        : `${round(left.total)} ≠ ${round(right.total)}，差 ${round(difference)}（容差 ${round(tolerance)}）`,
    };
  });
}

/** 资产负债表恒等式:任何一份资产负债表都该成立,不需要调用方声明。 */
export function balanceSheetTie(
  totalAssets: string,
  totalLiabilities: string,
  totalEquity: string,
): TieCheck {
  return {
    label: "资产 = 负债 + 所有者权益",
    left: [totalAssets],
    right: [totalLiabilities, totalEquity],
    relativeTolerance: 0.0001,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
