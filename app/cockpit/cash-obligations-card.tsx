"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Invoice01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount, summarizeObligations, type CashObligation, type ObligationTotals } from "@/lib/domain/cash-obligations";

/** 金额文案:已填合计 + 未填笔数(红线4:缺额不补 0,只说「未填额」)。 */
function amountText(t: ObligationTotals): string {
  if (t.count === 0) return "无";
  if (t.amount === 0 && t.unknownAmount > 0) return `${t.unknownAmount} 笔未填额`;
  const base = formatAmount(t.amount);
  return t.unknownAmount > 0 ? `${base}+ · ${t.unknownAmount} 笔未填额` : base;
}

function SummaryCell({ label, count, sub, tone }: { label: string; count: number; sub: string; tone: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 p-2.5 min-w-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <strong className="text-figure tabular-nums leading-none" style={count > 0 ? ({ color: tone } as CSSProperties) : undefined}>
        {count}
        <span className="text-meta font-normal text-muted-foreground"> 笔</span>
      </strong>
      <em className="text-meta text-muted-foreground not-italic truncate">{sub}</em>
    </div>
  );
}

export function CashObligationsCard({ obligations }: { obligations: CashObligation[] }) {
  const s = summarizeObligations(obligations);
  return (
    <Card>
      <CardHeader>
        <div className="flex size-6 items-center justify-center rounded-md fa-toned" style={{ "--tone": "var(--tone-invoice)" } as CSSProperties}>
          <HugeiconsIcon icon={Invoice01Icon} size={13} aria-hidden />
        </div>
        <CardTitle>合同收付总览</CardTitle>
        <Link href="/knowledge" className="ml-auto flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground">
          合同目录
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} aria-hidden />
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {obligations.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <SummaryCell label="本月应付" count={s.payable.count} sub={amountText(s.payable)} tone="var(--tone-warn)" />
              <SummaryCell label="本月应收" count={s.receivable.count} sub={amountText(s.receivable)} tone="var(--tone-ok)" />
              <SummaryCell label="待开票" count={s.toInvoice.count} sub={s.toInvoice.count > 0 ? "笔待开" : "无"} tone="var(--tone-notice)" />
            </div>
            <ul className="flex flex-col gap-2 border-t border-border pt-2">
              {obligations.map((o) => (
                <li
                  key={`${o.documentId}-${o.kind}-${o.dueDate}`}
                  className={`flex items-center justify-between gap-2 text-body ${o.done ? "opacity-50" : ""}`}
                >
                  <span className="truncate text-muted-foreground">
                    <span className="tabular-nums">{o.dueDate.slice(5).replace("-", "/")}</span> {o.kind}「{o.counterparty}」
                    {o.amount != null ? ` ${formatAmount(o.amount)}` : ""}
                  </span>
                  <span
                    className="fa-tone-pill shrink-0"
                    style={{ "--tone": o.done ? "var(--tone-neutral)" : "var(--tone-notice)" } as CSSProperties}
                  >
                    {o.status}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex flex-col items-start gap-2 py-2">
            <p className="text-body text-muted-foreground">本月暂无已确认的合同收付到期。</p>
            <Link href="/knowledge" className="text-meta hover:underline" style={{ color: "var(--tone-skill)" }}>
              上传合同 / 确认要素 →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
