import { NextResponse } from "next/server";
import { getInvoiceLedgerStats, getPayrollPeriodSummary, getBusinessOverview } from "@/lib/db/finance-store";
import { listConfirmedMetaDocRows, listRecentWorkItems } from "@/lib/db/sqlite";
import { getCalendarContext } from "@/lib/domain/tax-calendar";
import { deriveAttentionItems } from "@/lib/domain/attention";
import { deriveCashObligations, obligationsInMonth, type ObligationSourceDoc } from "@/lib/domain/cash-obligations";
import type { DocMetadata, MetaStatus } from "@/lib/knowledge/types";
import { appendServerLog } from "@/lib/runtime/server-log";

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
      attention: deriveAttentionItems(calendar, payroll, obligations),
      business: getBusinessOverview(now),
      obligations: obligationsInMonth(obligations, year, month),
      recentWork: listRecentWorkItems(8),
    };

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("[cockpit/summary] error:", error);
    void appendServerLog(`[cockpit/summary] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
