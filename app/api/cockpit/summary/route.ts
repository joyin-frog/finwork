import { NextResponse } from "next/server";
import { getInvoiceLedgerStats, getPayrollPeriodSummary, getBusinessOverview } from "@/lib/db/finance-store";
import { listConfirmedMetaDocRows } from "@/lib/db/sqlite";
import { getCalendarContext } from "@/lib/domain/tax-calendar";
import { deriveCockpitTodos } from "@/lib/domain/cockpit-todos";
import { deriveCashObligations, obligationsInMonth, type ObligationSourceDoc } from "@/lib/domain/cash-obligations";
import type { DocMetadata, MetaStatus } from "@/lib/knowledge/types";

function parseMeta(s: string): DocMetadata | null {
  try {
    return JSON.parse(s) as DocMetadata;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const calendar = getCalendarContext(now);
    const payroll = getPayrollPeriodSummary(year, month);
    const invoices = getInvoiceLedgerStats(year, month);

    const oblDocs: ObligationSourceDoc[] = listConfirmedMetaDocRows().map((r) => ({
      id: r.id,
      fileName: r.file_name,
      metadata: parseMeta(r.metadata),
      metaStatus: r.meta_status as MetaStatus,
    }));
    const obligations = deriveCashObligations(oblDocs);

    const data = {
      payroll,
      invoices,
      todos: deriveCockpitTodos(calendar, payroll, obligations),
      business: getBusinessOverview(now),
      obligations: obligationsInMonth(obligations, year, month),
    };

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("[cockpit/summary] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
