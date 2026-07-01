import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SuccessIcon, WarningIcon } from "@/lib/icons";
import { formatCny } from "@/lib/format";
import { parsePayrollStructured } from "./payroll-card-data";
import { PayrollResultCard } from "./payroll-result-card";
import { parseReimbursementStructured, type ReimbursementCardData } from "./reimbursement-card-data";
import {
  parseVoucherDraftStructured,
  parseVoucherValidationStructured,
  type VoucherDraftCardData,
  type VoucherValidationCardData
} from "./kingdee-card-data";
import { ReceiptCard, parseCalcReceiptStructured } from "./receipt-card";

/** 已实现专属卡片的财务工具列表(裸名)。与下方 ToolResultCard 分发逻辑保持一致。 */
export const TOOLS_WITH_RESULT_CARD = [
  "calculate_payroll_batch",
  "check_reimbursement_batch",
  "export_kingdee_draft",
  "validate_kingdee_voucher",
] as const;

/**
 * 结构化结果 → 财务可核对卡片的统一分发。
 * 解析失败一律返回 null 回退纯文本——卡片数字必须与 structuredContent 完全一致。
 */
export function ToolResultCard({ name, structured }: { name: string; structured: unknown }) {
  if (structured == null) return null;
  const bare = name.replace(/^mcp__\w+__/, "");
  let card: ReactNode = null;
  if (bare === "calculate_payroll_batch") {
    const data = parsePayrollStructured(structured);
    card = data ? <PayrollResultCard data={data} /> : null;
  } else if (bare === "check_reimbursement_batch") {
    const data = parseReimbursementStructured(structured);
    card = data ? <ReimbursementResultCard data={data} /> : null;
  } else if (bare === "export_kingdee_draft") {
    const data = parseVoucherDraftStructured(structured);
    card = data ? <VoucherDraftCard data={data} /> : null;
  } else if (bare === "validate_kingdee_voucher") {
    const data = parseVoucherValidationStructured(structured);
    card = data ? <VoucherValidationCard data={data} /> : null;
  } else {
    // 通用兜底:任何带 CalcReceipt 形状结构化结果的工具(如 tax_calculator)渲染可下钻回执卡片。
    const receipt = parseCalcReceiptStructured(structured);
    card = receipt ? <ReceiptCard receipt={receipt} /> : null;
  }
  return card ? <div className="px-1 pb-1">{card}</div> : null;
}

function ReimbursementResultCard({ data }: { data: ReimbursementCardData }) {
  return (
    <div className="rounded-lg border border-border bg-card text-body overflow-hidden">
      <div className={`px-3 py-2 border-b text-meta flex items-center gap-2 ${
        data.abnormalCount > 0 ? "border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12" : "border-border text-muted-foreground"
      }`}>
        {data.abnormalCount > 0
          ? <HugeiconsIcon icon={WarningIcon} size={13} className="shrink-0" aria-hidden="true" />
          : <HugeiconsIcon icon={SuccessIcon} size={13} className="shrink-0" aria-hidden="true" />}
        <span>{data.summary}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left font-normal px-3 py-1.5">姓名</th>
              <th className="text-left font-normal px-2 py-1.5">日期</th>
              <th className="text-left font-normal px-2 py-1.5">类目</th>
              <th className="text-right font-normal px-2 py-1.5">金额</th>
              <th className="text-left font-normal px-2 py-1.5">发票号</th>
              <th className="text-left font-normal px-3 py-1.5">状态</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={`${row.invoiceNo}-${row.employeeName}`} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-1.5">{row.employeeName}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{row.expenseDate}</td>
                <td className="px-2 py-1.5">{row.category}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatCny(row.amount)}</td>
                <td className="px-2 py-1.5 text-muted-foreground font-mono">{row.invoiceNo}</td>
                <td className="px-3 py-1.5">
                  {row.warnings.length ? (
                    <span className="inline-flex items-start gap-1 text-[color:var(--tone-notice)]">
                      <HugeiconsIcon icon={WarningIcon} size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{row.warnings.join("；")}</span>
                    </span>
                  ) : (
                    <HugeiconsIcon icon={SuccessIcon} size={13} className="text-muted-foreground" aria-label="通过" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VoucherDraftCard({ data }: { data: VoucherDraftCardData }) {
  return (
    <div className="rounded-lg border border-border bg-card text-body overflow-hidden">
      {data.simulated ? (
        <div className="px-3 py-2 border-b border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12 text-meta flex items-center gap-2">
          <HugeiconsIcon icon={WarningIcon} size={13} className="shrink-0" aria-hidden="true" />
          <span>模拟模式:草稿未写入金蝶系统,仅供核对。</span>
        </div>
      ) : null}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-3 text-meta text-muted-foreground">
        <span>
          {data.id} · {data.company} · {data.period}
        </span>
        {data.balanced ? (
          <span className="inline-flex items-center gap-1 shrink-0"><HugeiconsIcon icon={SuccessIcon} size={12} aria-hidden="true" />借贷平衡</span>
        ) : (
          <span className="inline-flex items-center gap-1 shrink-0 text-destructive">
            <HugeiconsIcon icon={WarningIcon} size={12} aria-hidden="true" />
            借贷不平衡:借 {formatCny(data.totalDebit)} / 贷 {formatCny(data.totalCredit)}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left font-normal px-3 py-1.5">摘要</th>
              <th className="text-left font-normal px-2 py-1.5">借方科目</th>
              <th className="text-right font-normal px-2 py-1.5">借方金额</th>
              <th className="text-left font-normal px-2 py-1.5">贷方科目</th>
              <th className="text-right font-normal px-3 py-1.5">贷方金额</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => (
              <tr key={entry.lineNumber} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-1.5">
                  {entry.summary}
                  <span className="block text-caption text-muted-foreground">{entry.date}</span>
                </td>
                <td className="px-2 py-1.5">{entry.debitAccount} {entry.debitAccountName}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatCny(entry.debitAmount)}</td>
                <td className="px-2 py-1.5">{entry.creditAccount} {entry.creditAccountName}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatCny(entry.creditAmount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border text-muted-foreground">
              <td className="px-3 py-1.5" colSpan={2}>合计</td>
              <td className="px-2 py-1.5 text-right tabular-nums font-medium text-foreground">{formatCny(data.totalDebit)}</td>
              <td className="px-2 py-1.5" />
              <td className="px-3 py-1.5 text-right tabular-nums font-medium text-foreground">{formatCny(data.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function VoucherValidationCard({ data }: { data: VoucherValidationCardData }) {
  return (
    <div className="rounded-lg border border-border bg-card text-body overflow-hidden">
      <div className={`px-3 py-2 text-meta flex items-center gap-2 ${
        data.valid ? "text-muted-foreground" : "bg-destructive/10 text-destructive"
      }`}>
        {data.valid ? <HugeiconsIcon icon={SuccessIcon} size={13} aria-hidden="true" /> : <HugeiconsIcon icon={WarningIcon} size={13} aria-hidden="true" />}
        <span>{data.valid ? "凭证校验通过" : `凭证校验未通过(${data.errors.length} 个错误)`}</span>
      </div>
      {data.errors.length ? (
        <ul className="px-3 py-2 border-t border-border text-meta text-destructive flex flex-col gap-1">
          {data.errors.map((error) => <li key={error}>• {error}</li>)}
        </ul>
      ) : null}
      {data.warnings.length ? (
        <ul className="px-3 py-2 border-t border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12 text-meta flex flex-col gap-1">
          {data.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

