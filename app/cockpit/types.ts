import type { AttentionItem } from "@/lib/domain/attention";
import type { CashObligation } from "@/lib/domain/cash-obligations";
import type { BusinessOverview, InvoiceLedgerStats, PayrollPeriodSummary } from "@/lib/db/finance-store";
import type { RecentWorkItem } from "@/lib/db/sqlite";

/** 团队面板单行（CV-3 §5.1） */
export type TeamRoleItem = {
  roleId: string;
  name: string;
  charter: string;
  dispatchCount: number;
  lastAt: string | null;
  lastSummary: string | null;
};

export type CockpitSummary = {
  payroll: PayrollPeriodSummary;
  invoices: InvoiceLedgerStats;
  attention: AttentionItem[];
  business: BusinessOverview;
  /** 本月合同收付到期(供财务日历时间地图) */
  obligations: CashObligation[];
  /** 最近工作列表（CV-2 §4.1） */
  recentWork: RecentWorkItem[];
  /** 团队面板（CV-3 §5.1）：有调度记录的角色列表 */
  team: TeamRoleItem[];
};
