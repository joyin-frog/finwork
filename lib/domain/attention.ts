// 总览页关注区推导:由业务数据 + 财务日历自动生成,urgent 在前。
// 每条 AttentionItem 的主动作指向一次对话入口——对话即任务。

import type { CalendarContext } from "./tax-calendar";
import type { PayrollPeriodSummary } from "@/lib/db/finance-store";
import { urgentObligations, daysBetween, formatAmount, type CashObligation } from "./cash-obligations";

export type AttentionItem = {
  id: string;
  source: "rule" | "gate";
  sourceLabel: string;
  roleId?: string;
  severity: "urgent" | "normal";
  title: string;
  actions: { label: string; href: string; primary?: boolean }[];
  occurredAt?: string;
};

const FILING_URGENT_DAYS = 5;

export function deriveAttentionItems(
  calendar: CalendarContext,
  payroll: PayrollPeriodSummary,
  obligations: CashObligation[] = []
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 合同收付:同一份「已确认」台账派生的临近未完成项(语义与改造前的待办推导完全一致,
  // 走 urgentObligations 的 status 待办过滤,不放宽)
  const [ty, tm, td] = calendar.isoDate.split("-").map(Number);
  const today = new Date(ty, (tm ?? 1) - 1, td ?? 1);
  for (const o of urgentObligations(obligations, today)) {
    const days = daysBetween(today, o.dueDate);
    const md = o.dueDate.slice(5).replace("-", "/");
    const verb = o.kind === "付款" ? "付" : o.kind === "收款" ? "收" : "开票";
    const amt = o.amount != null ? ` ${formatAmount(o.amount)}` : "";
    const when = days < 0 ? `已逾期 ${-days} 天` : days === 0 ? "今天到期" : `还剩 ${days} 天`;
    items.push({
      id: `oblig-${o.documentId}-${o.kind}-${o.dueDate}`,
      source: "rule",
      sourceLabel: "合同收付",
      severity: days <= 7 ? "urgent" : "normal",
      title: `${md} ${verb}「${o.counterparty}」${amt} · ${when}`,
      actions: [
        {
          label: "看合同条款",
          href:
            "/chat/new?prompt=" +
            encodeURIComponent(
              `关于「${o.counterparty}」这笔${o.kind}(到期 ${o.dueDate},来源 ${o.sourceDoc ?? ""}),帮我看下合同条款并准备处理`
            ),
          primary: true,
        },
      ],
    });
  }

  // 申报截止 ≤5 天
  const filing = calendar.deadlines[0];
  if (filing && filing.daysLeft <= FILING_URGENT_DAYS) {
    items.push({
      id: "tax-filing",
      source: "rule",
      sourceLabel: "申报截止",
      severity: "urgent",
      title:
        filing.daysLeft === 0
          ? `今天是 ${filing.day} 日申报截止日(个税扣缴、增值税及附加)`
          : `距 ${filing.day} 日申报截止还有 ${filing.daysLeft} 天(个税扣缴、增值税及附加)`,
      actions: [
        {
          label: "做申报前检查",
          href: "/chat/new?prompt=" + encodeURIComponent("帮我做申报前检查:核对本月个税与增值税申报数据是否就绪"),
          primary: true,
        },
      ],
    });
  }

  // 工资草稿待确认
  if (payroll.draftCount > 0) {
    items.push({
      id: "payroll-draft",
      source: "rule",
      sourceLabel: "工资草稿",
      severity: "urgent",
      title: `${payroll.month} 月工资草稿 ${payroll.draftCount} 人待确认(${payroll.draftEmployees.slice(0, 3).join("、")}${payroll.draftCount > 3 ? " 等" : ""})`,
      actions: [
        {
          label: "核对并确认",
          href:
            "/chat/new?prompt=" +
            encodeURIComponent(`请展示 ${payroll.year} 年 ${payroll.month} 月工资草稿明细,我核对后确认`),
          primary: true,
        },
      ],
    });
  }

  // 算薪窗口未开算
  if (calendar.windows.includes("payroll_prep") && payroll.draftCount === 0 && payroll.confirmedCount === 0) {
    items.push({
      id: "payroll-not-started",
      source: "rule",
      sourceLabel: "算薪窗口",
      severity: "normal",
      title: `算薪窗口:${payroll.month} 月工资尚未计算`,
      actions: [
        {
          label: "开始算薪",
          href: "/chat/new?prompt=" + encodeURIComponent("请帮我计算本月薪资个税"),
          primary: true,
        },
      ],
    });
  }

  // 结账窗口
  if (calendar.windows.includes("closing")) {
    items.push({
      id: "month-closing",
      source: "rule",
      sourceLabel: "结账窗口",
      severity: "normal",
      title: "月末结账窗口:核对发票收齐与计提",
      actions: [
        {
          label: "开始核对",
          href:
            "/chat/new?prompt=" +
            encodeURIComponent("月末结账:帮我核对本月报销发票是否收齐、有哪些待登记台账"),
          primary: true,
        },
      ],
    });
  }

  // urgent 全部在前，同级保持原序
  items.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === "urgent" ? -1 : 1;
  });

  return items;
}
