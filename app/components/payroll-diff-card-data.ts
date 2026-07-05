// diff_payroll_period 的 structuredContent → 差异卡片数据整形。
// 严格校验：任一字段不完整即整体返回 null，回退纯文本展示——
// 卡片显示的数字必须与 structuredContent 完全一致，宁可不渲染，不可凑数。

import { formatCny } from "@/lib/format";

/**
 * 带符号的 delta 展示串：正数带 "+"、负数带 "-"、零为 "—"。
 * 复核卡片必须让减薪（负 delta）显示减号，否则减薪会被误读为加薪。
 * 抽成纯函数以便单测锁定（此前内联逻辑漏了负号）。
 */
export function formatSignedDelta(delta: number): string {
  if (delta === 0) return "—";
  return (delta > 0 ? "+" : "-") + formatCny(Math.abs(delta));
}

export type PayrollDiffFieldData = {
  prior: number;
  current: number;
  delta: number;
};

export type PayrollDiffRowData = {
  employeeName: string;
  fields: {
    grossPay: PayrollDiffFieldData;
    socialInsurance: PayrollDiffFieldData;
    housingFund: PayrollDiffFieldData;
    specialDeduction: PayrollDiffFieldData;
    taxCurrent: PayrollDiffFieldData;
    netPay: PayrollDiffFieldData;
  };
  maxAbsDelta: number;
  changed: boolean;
  flags: string[];
};

export type PayrollDiffCardData = {
  year: number;
  month: number;
  /** 格式 "YYYY 年 MM 月"，无上月期间时 null */
  comparedFromPeriod: string | null;
  rows: PayrollDiffRowData[];
  newEmployees: string[];
  dropped: string[];
};

export function parsePayrollDiffStructured(structured: unknown): PayrollDiffCardData | null {
  if (!structured || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;

  const year = finite(s.year);
  const month = finite(s.month);
  if (year == null || month == null) return null;

  const comparedFromPeriod =
    typeof s.comparedFromPeriod === "string" ? s.comparedFromPeriod : null;

  if (!Array.isArray(s.rows)) return null;

  const rows: PayrollDiffRowData[] = [];
  for (const item of s.rows) {
    const row = parseRow(item);
    if (!row) return null;
    rows.push(row);
  }

  const newEmployees = stringArray(s.newEmployees);
  const dropped = stringArray(s.dropped);

  return { year, month, comparedFromPeriod, rows, newEmployees, dropped };
}

function parseRow(item: unknown): PayrollDiffRowData | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;

  const employeeName = typeof r.employeeName === "string" ? r.employeeName : null;
  if (!employeeName) return null;

  const maxAbsDelta = finite(r.maxAbsDelta);
  const changed = typeof r.changed === "boolean" ? r.changed : null;
  if (maxAbsDelta == null || changed == null) return null;

  const flags = stringArray(r.flags);

  const fieldsRaw = r.fields;
  if (!fieldsRaw || typeof fieldsRaw !== "object") return null;
  const f = fieldsRaw as Record<string, unknown>;

  const grossPay        = parseDiffField(f.grossPay);
  const socialInsurance = parseDiffField(f.socialInsurance);
  const housingFund     = parseDiffField(f.housingFund);
  const specialDeduction = parseDiffField(f.specialDeduction);
  const taxCurrent      = parseDiffField(f.taxCurrent);
  const netPay          = parseDiffField(f.netPay);

  if (!grossPay || !socialInsurance || !housingFund || !specialDeduction || !taxCurrent || !netPay) {
    return null;
  }

  return {
    employeeName,
    fields: { grossPay, socialInsurance, housingFund, specialDeduction, taxCurrent, netPay },
    maxAbsDelta,
    changed,
    flags,
  };
}

function parseDiffField(v: unknown): PayrollDiffFieldData | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  const prior   = finite(f.prior);
  const current = finite(f.current);
  const delta   = finite(f.delta);
  if (prior == null || current == null || delta == null) return null;
  return { prior, current, delta };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}
