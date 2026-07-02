/**
 * 凭证 → 金蝶「对照手填清单」(Excel 行数据)。
 *
 * 金蝶云星空无 Excel 导入,最终产物是对照清单:列对齐凭证录入界面,用户照着往金蝶敲。
 * 本函数只出确定性的行数据(列顺序/借贷分列/多凭证摊平),实际写 xlsx 由 run_python(openpyxl)完成。
 */
import type { VoucherLine } from "@/lib/domain/voucher-build";

// 列顺序对齐金蝶凭证录入界面
export const VOUCHER_SHEET_HEADERS = [
  "日期",
  "凭证字",
  "摘要",
  "科目编码",
  "科目全名",
  "核算维度",
  "借方金额",
  "贷方金额",
] as const;

export type VoucherForSheet = {
  date: string;
  voucherWord?: string; // 凭证字,默认「记」
  lines: VoucherLine[];
};

export type VoucherSheet = {
  headers: string[];
  rows: (string | number)[][];
};

/** 多张凭证摊平为清单行:每行含日期/凭证字(金蝶导入要求每行都填)+ 分录字段,借贷分列。 */
export function buildVoucherSheet(vouchers: VoucherForSheet[]): VoucherSheet {
  const rows: (string | number)[][] = [];
  for (const v of vouchers) {
    const word = v.voucherWord?.trim() || "记";
    for (const l of v.lines) {
      rows.push([
        v.date,
        word,
        l.summary,
        l.account,
        l.accountName ?? "",
        l.dimensionValue ?? "",
        l.debitYuan != null ? l.debitYuan : "",
        l.creditYuan != null ? l.creditYuan : "",
      ]);
    }
  }
  return { headers: [...VOUCHER_SHEET_HEADERS], rows };
}
