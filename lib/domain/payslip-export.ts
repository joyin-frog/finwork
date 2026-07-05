// 工资条导出纯函数。无 DB、无 IO。
// 只处理 confirmed 记录；draft 进 skippedDrafts（结算状态红线）。
import type { StoredPayrollRecord } from "@/lib/db/finance-store";
import { checkSumConsistent, collectNumericIssues } from "@/lib/safety/numeric-check";

export type PayslipRow = {
  employeeName: string;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  taxCurrent: number;
  netPay: number;
};

export type PayslipTotals = {
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  taxCurrent: number;
  netPay: number;
};

export type PayslipExport = {
  year: number;
  month: number;
  rows: PayslipRow[];
  totals: PayslipTotals;
  skippedDrafts: string[];
  hasConfirmed: boolean;
  /** 精度/合计勾稽告警（空=无问题） */
  numericWarnings: string[];
};

/**
 * 从某月工资记录中提取已确认工资条导出数据。
 * - 只取 status==="confirmed" 的记录
 * - draft 记录进 skippedDrafts（不入表）
 * - 合计按整数分累加避免浮点尾差
 * - 不自洽时 numericWarnings 告警，不静默
 */
export function buildPayslipExport(
  records: StoredPayrollRecord[],
  year: number,
  month: number
): PayslipExport {
  const confirmedRecords = records.filter((r) => r.status === "confirmed");
  const draftRecords = records.filter((r) => r.status !== "confirmed");

  const skippedDrafts = draftRecords.map((r) => r.employeeName);

  const rows: PayslipRow[] = confirmedRecords.map((r) => ({
    employeeName: r.employeeName,
    grossPay: r.grossPay,
    socialInsurance: r.socialInsurance,
    housingFund: r.housingFund,
    specialDeduction: r.specialDeduction,
    taxCurrent: r.taxCurrent,
    netPay: r.netPay,
  }));

  // 整数分累加避免浮点尾差
  const sumField = (field: keyof Omit<PayslipRow, "employeeName">): number => {
    const cents = rows.reduce((acc, r) => acc + Math.round(r[field] * 100), 0);
    return cents / 100;
  };

  const totals: PayslipTotals = {
    grossPay: sumField("grossPay"),
    socialInsurance: sumField("socialInsurance"),
    housingFund: sumField("housingFund"),
    specialDeduction: sumField("specialDeduction"),
    taxCurrent: sumField("taxCurrent"),
    netPay: sumField("netPay"),
  };

  // 勾稽校验：每列 sum(明细)=合计
  const numericWarnings: string[] = [];
  for (const [field, label] of [
    ["grossPay", "税前合计"],
    ["socialInsurance", "五险合计"],
    ["housingFund", "公积金合计"],
    ["specialDeduction", "专项合计"],
    ["taxCurrent", "个税合计"],
    ["netPay", "实发合计"],
  ] as const) {
    const issues = collectNumericIssues([
      checkSumConsistent(
        totals[field],
        rows.map((r) => r[field]),
        label
      ),
    ]);
    for (const issue of issues) numericWarnings.push(issue.detail);
  }

  return {
    year,
    month,
    rows,
    totals,
    skippedDrafts,
    hasConfirmed: rows.length > 0,
    numericWarnings,
  };
}
