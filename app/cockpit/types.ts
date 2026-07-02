import type { AttentionItem } from "@/lib/domain/attention";
import type { CashObligation } from "@/lib/domain/cash-obligations";
import type { BusinessOverview, InvoiceLedgerStats, PayrollPeriodSummary } from "@/lib/db/finance-store";

export type CockpitSummary = {
  payroll: PayrollPeriodSummary;
  invoices: InvoiceLedgerStats;
  attention: AttentionItem[];
  business: BusinessOverview;
  /** 本月合同收付到期(供财务日历时间地图) */
  obligations: CashObligation[];
};
