// calculate_payroll_batch 的 structuredContent → 工资卡片数据整形。
// 严格校验:任一行字段不完整即整体返回 null,回退纯文本展示——
// 卡片显示的数字必须与 structuredContent 完全一致,宁可不渲染,不可凑数。

export type PayrollCardRow = {
  employeeName: string;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  taxCurrent: number;
  netPay: number;
  formula?: string;
  coldStart: boolean;
};

export type PayrollCardData = {
  rows: PayrollCardRow[];
  failures: string[];
  coldStarts: string[];
  totalNetPay: number;
  totalTax: number;
  taxConfigVersion?: string;
};

export function parsePayrollStructured(structured: unknown): PayrollCardData | null {
  if (!structured || typeof structured !== "object") return null;
  const source = structured as {
    results?: unknown;
    failures?: unknown;
    coldStarts?: unknown;
    totalNetPay?: unknown;
    totalTax?: unknown;
    taxConfigVersion?: unknown;
  };
  if (!Array.isArray(source.results)) return null;

  const coldStarts = stringArray(source.coldStarts);
  const coldStartSet = new Set(coldStarts);
  const rows: PayrollCardRow[] = [];

  for (const item of source.results) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    const employeeName = typeof r.employeeName === "string" ? r.employeeName : null;
    const grossPay = finite(r.grossPay);
    const socialInsurance = finite(r.socialInsurance);
    const housingFund = finite(r.housingFund);
    const specialDeduction = finite(r.specialDeduction);
    const taxCurrent = finite(r.taxCurrent);
    const netPay = finite(r.netPay);
    if (
      employeeName == null || grossPay == null || socialInsurance == null ||
      housingFund == null || specialDeduction == null || taxCurrent == null || netPay == null
    ) {
      return null;
    }
    const detail = r.detail as { formula?: unknown } | undefined;
    rows.push({
      employeeName,
      grossPay,
      socialInsurance,
      housingFund,
      specialDeduction,
      taxCurrent,
      netPay,
      formula: detail && typeof detail.formula === "string" ? detail.formula : undefined,
      coldStart: coldStartSet.has(employeeName)
    });
  }

  // 异常置顶:首次计算(累计起点待核对)的员工排在前面,其余保持原序
  rows.sort((a, b) => Number(b.coldStart) - Number(a.coldStart));

  return {
    rows,
    failures: stringArray(source.failures),
    coldStarts,
    totalNetPay: finite(source.totalNetPay) ?? round2(rows.reduce((sum, r) => sum + r.netPay, 0)),
    totalTax: finite(source.totalTax) ?? round2(rows.reduce((sum, r) => sum + r.taxCurrent, 0)),
    taxConfigVersion: typeof source.taxConfigVersion === "string" ? source.taxConfigVersion : undefined
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
