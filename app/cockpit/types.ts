import type { AttentionItem } from "@/lib/domain/attention";
import type { CashObligation } from "@/lib/domain/cash-obligations";
import type { BusinessOverview, InvoiceLedgerStats, PayrollPeriodSummary } from "@/lib/db/finance-store";
import type { RecentWorkItem } from "@/lib/db/sqlite";

export type CockpitSummary = {
  payroll: PayrollPeriodSummary;
  invoices: InvoiceLedgerStats;
  attention: AttentionItem[];
  business: BusinessOverview;
  /** 本月合同收付到期(供财务日历时间地图) */
  obligations: CashObligation[];
  /** 最近工作列表（CV-2 §4.1） */
  recentWork: RecentWorkItem[];
};
