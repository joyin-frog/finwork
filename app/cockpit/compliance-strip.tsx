"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calculator01Icon, Invoice01Icon, ClipboardIcon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Card, CardContent } from "@/components/ui/card";
import type { InvoiceLedgerStats, PayrollPeriodSummary } from "@/lib/db/finance-store";

/** 周期性合规细条:薪税 / 发票 / 报销——降权为一行状态,不再各占大卡。 */
export function ComplianceStrip({
  payroll,
  invoices,
}: {
  payroll: PayrollPeriodSummary | null;
  invoices: InvoiceLedgerStats | null;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-4 text-body">
        <span className="text-meta text-muted-foreground shrink-0">周期性合规</span>

        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md fa-toned" style={{ "--tone": "var(--tone-payroll)" } as CSSProperties}>
            <HugeiconsIcon icon={Calculator01Icon} size={14} aria-hidden />
          </div>
          <span>本月工资</span>
          <span className="text-small tabular-nums text-muted-foreground">
            草稿 {payroll?.draftCount ?? "--"} · 确认 {payroll?.confirmedCount ?? "--"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md fa-toned" style={{ "--tone": "var(--tone-invoice)" } as CSSProperties}>
            <HugeiconsIcon icon={Invoice01Icon} size={14} aria-hidden />
          </div>
          <span>发票登记</span>
          <span className="text-small tabular-nums text-muted-foreground">
            本月 {invoices?.addedThisMonth ?? "--"} · 累计 {invoices?.total ?? "--"}
          </span>
        </div>

        <Link
          href="/chat/new?prompt=请帮我校验报销单据"
          className="flex items-center gap-2 ml-auto text-muted-foreground hover:text-foreground transition-colors"
        >
          <div className="flex size-7 items-center justify-center rounded-md fa-toned" style={{ "--tone": "var(--tone-invoice)" } as CSSProperties}>
            <HugeiconsIcon icon={ClipboardIcon} size={14} aria-hidden />
          </div>
          <span>报销校验</span>
          <HugeiconsIcon icon={ArrowRight01Icon} size={13} aria-hidden />
        </Link>
      </CardContent>
    </Card>
  );
}
