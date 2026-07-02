/**
 * 凭证汇总:把每张单据的金额勾稽 + 科目映射结果聚合成"汇总大表"数据。
 *
 * 交互模式=汇总确认:全部识别完出大表,用户挑⚠️行集中比对。此函数产出该表的
 * 数据层与统计(✅自动/⚠️待确认/❌失败),某张失败跳过不影响其余(AC6)。
 */

/** 单张单据处理结果(金额勾稽/科目映射的结论,由 skill 层从 ReconcileResult/AccountResolution 归一)。 */
export type SlipResult = {
  file: string;
  ocrOk: boolean;
  amountOk?: boolean;
  amountIssue?: string;
  accountOk?: boolean;
  accountIssue?: string;
};

export type VoucherRow = {
  file: string;
  status: "auto" | "needs_confirm" | "failed";
  issues: string[];
};

export type VoucherSummary = {
  rows: VoucherRow[];
  total: number;
  autoPass: number;
  needConfirm: number;
  failed: number;
};

/** 聚合一批单据结果为汇总大表 + 统计。 */
export function summarizeVouchers(results: SlipResult[]): VoucherSummary {
  const rows: VoucherRow[] = results.map((r) => {
    if (!r.ocrOk) {
      return { file: r.file, status: "failed", issues: ["图片无法识别(OCR 失败),已跳过"] };
    }
    const issues: string[] = [];
    if (r.amountOk === false && r.amountIssue) issues.push(r.amountIssue);
    if (r.accountOk === false && r.accountIssue) issues.push(r.accountIssue);
    const clean = r.amountOk !== false && r.accountOk !== false;
    return { file: r.file, status: clean ? "auto" : "needs_confirm", issues };
  });

  return {
    rows,
    total: rows.length,
    autoPass: rows.filter((r) => r.status === "auto").length,
    needConfirm: rows.filter((r) => r.status === "needs_confirm").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}
