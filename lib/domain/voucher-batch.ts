/**
 * 批量处理:一次传整批单据,逐张勾稽+映射+分录,汇总+出清单。
 *
 * 治本 scaling:agent 读完单据、提完字段后一次调用处理全批,把逐张逐工具的 40+ 次 LLM 往返
 * 压成 1 次。内部纯复用 voucher-reconcile / account-mapping / voucher-build / -summary / -sheet。
 */
import { parseChineseAmount, reconcileAmount, type ReconcileResult } from "@/lib/domain/voucher-reconcile";
import { yuanToFen } from "@/lib/domain/money";
import { resolveAccount, type MappingEntry } from "@/lib/domain/account-mapping";
import { buildVoucherLines, type VoucherLine } from "@/lib/domain/voucher-build";
import { summarizeVouchers, type SlipResult, type VoucherSummary } from "@/lib/domain/voucher-summary";
import { buildVoucherSheet, type VoucherSheet } from "@/lib/domain/voucher-sheet";
import type { KingdeeAccount } from "@/lib/db/finance-store";

export type BatchSlip = {
  file: string;
  date: string;
  lineItems: Array<{ summary: string; amountYuan: number }>;
  totalYuan?: number;
  capitalText?: string;
  advanceYuan?: number;
  payeeName?: string;
  departmentName?: string;
};

export type BatchInput = {
  slips: BatchSlip[];
  mappings: MappingEntry[];
  chart: KingdeeAccount[];
  paymentAccount: { code: string; name?: string };
  advanceAccount?: { code: string; name?: string };
};

export type BatchVoucher = {
  file: string;
  date: string;
  amount: ReconcileResult;
  lines: VoucherLine[];
  balanced: boolean;
  status: "auto" | "needs_confirm" | "failed";
  issues: string[];
};

export type BatchOutput = {
  vouchers: BatchVoucher[];
  summary: VoucherSummary;
  sheet: VoucherSheet;
};

export function processVoucherBatch(input: BatchInput): BatchOutput {
  const { slips, mappings, chart, paymentAccount, advanceAccount } = input;
  const vouchers: BatchVoucher[] = [];
  const slipResults: SlipResult[] = [];

  for (const slip of slips) {
    const issues: string[] = [];

    // ① 金额勾稽
    let amount: ReconcileResult;
    let amountIssue: string | undefined;
    try {
      amount = reconcileAmount({
        lineItemsFen: slip.lineItems.length ? slip.lineItems.map((i) => yuanToFen(i.amountYuan)) : undefined,
        totalFen: slip.totalYuan != null ? yuanToFen(slip.totalYuan) : undefined,
        capitalFen: slip.capitalText ? (parseChineseAmount(slip.capitalText) ?? undefined) : undefined,
      });
    } catch (e) {
      amount = { ok: false, reason: "no_cross_check", valueFen: 0 };
      amountIssue = `金额异常:${e instanceof Error ? e.message : String(e)}`;
    }
    if (!amount.ok && !amountIssue) {
      amountIssue = amount.reason === "mismatch" ? `金额勾稽不平:${amount.mismatch}对不上` : "金额无从勾稽,需人工确认";
    }
    if (amountIssue) issues.push(amountIssue);

    // ② 逐费用明细映射科目(未命中不阻断,清编码待人工填)
    const expenses: Array<{ summary: string; account: string; accountName?: string; amountYuan: number }> = [];
    let allMapped = true;
    let accountIssue: string | undefined;
    for (const item of slip.lineItems) {
      const m = resolveAccount(item.summary, mappings, chart);
      if (m.ok) {
        expenses.push({ summary: item.summary, account: m.code, accountName: m.name, amountYuan: item.amountYuan });
      } else {
        allMapped = false;
        accountIssue = `科目待确认:「${item.summary}」`;
        issues.push(accountIssue);
        expenses.push({ summary: item.summary, account: "", amountYuan: item.amountYuan });
      }
    }

    // ③ 构造分录(含预借款冲销)
    const built = buildVoucherLines({
      expenses,
      paymentAccount,
      departmentName: slip.departmentName,
      advanceYuan: slip.advanceYuan,
      advanceAccount,
      payeeName: slip.payeeName,
    });

    const status: BatchVoucher["status"] = amount.ok && allMapped ? "auto" : "needs_confirm";
    vouchers.push({ file: slip.file, date: slip.date, amount, lines: built.lines, balanced: built.balanced, status, issues });
    slipResults.push({ file: slip.file, ocrOk: true, amountOk: amount.ok, amountIssue, accountOk: allMapped, accountIssue });
  }

  const summary = summarizeVouchers(slipResults);
  const sheet = buildVoucherSheet(vouchers.map((v) => ({ date: v.date, lines: v.lines })));
  return { vouchers, summary, sheet };
}
