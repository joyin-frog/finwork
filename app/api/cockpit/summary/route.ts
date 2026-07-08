import { NextResponse } from "next/server";
import { getPayrollPeriodSummary, getBusinessOverview, getInvoiceLedgerStats, hasMetricsForMonth, listCashObligations } from "@/lib/db/finance-store";
import { listRecentWorkItems } from "@/lib/db/sqlite";
import { getCalendarContext } from "@/lib/domain/tax-calendar";
import { deriveAttentionItems, blockedDispatchToAttentionItem, sortAttentionItems } from "@/lib/domain/attention";
import { obligationsInMonth } from "@/lib/domain/cash-obligations";
import { listRoleDispatchSummary, listBlockedDispatches } from "@/lib/db/dispatch-store";
import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { listSkills } from "@/lib/agent/skills-store";
import { appendServerLog } from "@/lib/runtime/server-log";
import { redact } from "@/lib/safety/pii";

export async function GET() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const calendar = getCalendarContext(now);
    const payroll = getPayrollPeriodSummary(year, month);

    // WP1b: 读切换——从 fact_obligations 表读，而不是每次重派生
    const obligations = listCashObligations();

    // 新增参数：发票台账统计 + 上月指标存在性 + filing-precheck starter
    const invoiceStats = getInvoiceLedgerStats(year, month);
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const metricsForLastMonth = hasMetricsForMonth(prevYear, prevMonth);

    let filingPrecheckStarter: string | undefined;
    try {
      const skills = await listSkills();
      const precheckSkill = skills.find((s) => s.name === "filing-precheck");
      filingPrecheckStarter = precheckSkill?.starter || undefined;
    } catch {
      filingPrecheckStarter = undefined;
    }

    // 关注区：rule 供给源 + gate 供给源合并排序
    const ruleItems = deriveAttentionItems(calendar, payroll, obligations, invoiceStats, metricsForLastMonth, filingPrecheckStarter);
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
    void appendServerLog(`[cockpit/summary] ${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
