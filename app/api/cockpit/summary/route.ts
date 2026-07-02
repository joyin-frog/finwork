import { NextResponse } from "next/server";
import { getPayrollPeriodSummary, getBusinessOverview } from "@/lib/db/finance-store";
import { listConfirmedMetaDocRows, listRecentWorkItems } from "@/lib/db/sqlite";
import { getCalendarContext } from "@/lib/domain/tax-calendar";
import { deriveAttentionItems, blockedDispatchToAttentionItem, sortAttentionItems } from "@/lib/domain/attention";
import { deriveCashObligations, obligationsInMonth, type ObligationSourceDoc } from "@/lib/domain/cash-obligations";
import { listRoleDispatchSummary, listBlockedDispatches } from "@/lib/db/dispatch-store";
import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
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

    const oblDocs: ObligationSourceDoc[] = listConfirmedMetaDocRows().map((r) => ({
      id: r.id,
      fileName: r.file_name,
      metadata: parseMeta(r.metadata),
      metaStatus: r.meta_status as MetaStatus,
    }));
    const obligations = deriveCashObligations(oblDocs);

    // 关注区：rule 供给源 + gate 供给源合并排序
    const ruleItems = deriveAttentionItems(calendar, payroll, obligations);
    const blockedDispatches = listBlockedDispatches(7);
    const gateItems = blockedDispatches.map((row) => {
      const reg = ROLE_REGISTRY.find((r) => r.id === row.roleId);
      const roleName = reg?.name ?? row.roleId;
      return blockedDispatchToAttentionItem(row, roleName);
    });
    const attention = [...ruleItems, ...gateItems];
    sortAttentionItems(attention);

    // 团队面板：有调度记录的角色（name/charter 从 ROLE_REGISTRY 取）
    const dispatchSummaries = listRoleDispatchSummary();
    const team = dispatchSummaries.map((s) => {
      const reg = ROLE_REGISTRY.find((r) => r.id === s.roleId);
      return {
        roleId: s.roleId,
        name: reg?.name ?? s.roleId,
        charter: reg?.charter ?? "",
        dispatchCount: s.count,
        lastAt: s.lastAt,
        lastSummary: s.lastSummary,
      };
    });

    const data = {
      payroll,
      attention,
      business: getBusinessOverview(now),
      obligations: obligationsInMonth(obligations, year, month),
      recentWork: listRecentWorkItems(8),
      team: team,
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
