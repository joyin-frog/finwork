import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import type { PayrollCardData } from "./payroll-card-data";
import { formatCny } from "@/lib/format";

/**
 * 工资批次结果卡片:异常(计算失败/首次计算)置顶,合计随后,
 * 员工明细成表,每行可展开个税计算过程——数字可追溯是合规基础设施。
 */
export function PayrollResultCard({ data }: { data: PayrollCardData }) {
  return (
    <div className="rounded-lg border border-border bg-card text-body overflow-hidden">
      {data.failures.length ? (
        <div className="px-3 py-2 border-b border-border bg-destructive/10 text-destructive text-meta flex flex-col gap-1">
          <span className="flex items-center gap-2 font-medium">
            <HugeiconsIcon icon={Alert02Icon} size={13} aria-hidden="true" />
            {data.failures.length} 人计算失败,未写入草稿,需人工处理
          </span>
          {data.failures.map((failure) => (
            <span key={failure} className="pl-5">{failure}</span>
          ))}
        </div>
      ) : null}
      {data.coldStarts.length ? (
        <div className="px-3 py-2 border-b border-[color:var(--tone-notice)]/30 bg-[color:var(--tone-notice)]/12 text-meta flex items-start gap-2">
          <HugeiconsIcon icon={Alert02Icon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {data.coldStarts.join("、")} 按本年首次计算处理,请与个税扣缴端核对累计起点。
          </span>
        </div>
      ) : null}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-3 text-meta text-muted-foreground">
        <span>
          {data.rows.length} 人 · 实发合计 <strong className="text-foreground">{formatCny(data.totalNetPay)}</strong>
          {" · "}本期个税合计 <strong className="text-foreground">{formatCny(data.totalTax)}</strong>
        </span>
        {data.taxConfigVersion ? <span className="shrink-0">税率配置 {data.taxConfigVersion}</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left font-normal px-3 py-1.5">姓名</th>
              <th className="text-right font-normal px-2 py-1.5">税前</th>
              <th className="text-right font-normal px-2 py-1.5">五险</th>
              <th className="text-right font-normal px-2 py-1.5">公积金</th>
              <th className="text-right font-normal px-2 py-1.5">专项扣除</th>
              <th className="text-right font-normal px-2 py-1.5">本期个税</th>
              <th className="text-right font-normal px-3 py-1.5">实发</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <PayrollRow key={row.employeeName} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PayrollRow({ row }: { row: PayrollCardData["rows"][number] }) {
  return (
    <>
      <tr className="border-b border-border/60 last:border-0">
        <td className="px-3 py-1.5">
          <span className="flex items-center gap-2">
            {row.employeeName}
            {row.coldStart ? (
              <span className="text-caption px-1.5 py-0.5 rounded-full bg-[color:var(--tone-notice)]/12 border border-[color:var(--tone-notice)]/30">首次计算</span>
            ) : null}
          </span>
          {row.formula ? (
            <details className="mt-0.5">
              <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">计算过程</summary>
              <p className="text-caption text-muted-foreground whitespace-pre-wrap pt-0.5">{row.formula}</p>
            </details>
          ) : null}
        </td>
        <td className="text-right px-2 py-1.5 tabular-nums">{formatCny(row.grossPay)}</td>
        <td className="text-right px-2 py-1.5 tabular-nums">{formatCny(row.socialInsurance)}</td>
        <td className="text-right px-2 py-1.5 tabular-nums">{formatCny(row.housingFund)}</td>
        <td className="text-right px-2 py-1.5 tabular-nums">{formatCny(row.specialDeduction)}</td>
        <td className="text-right px-2 py-1.5 tabular-nums">{formatCny(row.taxCurrent)}</td>
        <td className="text-right px-3 py-1.5 tabular-nums font-medium">{formatCny(row.netPay)}</td>
      </tr>
    </>
  );
}

