// 总览页待办推导:由业务数据 + 财务日历自动生成,不做手工管理。
// 每条待办都是一次对话的入口(href 直达对应任务),这是"对话即任务"形态下的调度方式。

import type { CalendarContext } from "./tax-calendar";
import type { PayrollPeriodSummary } from "@/lib/db/finance-store";
import { urgentObligations, daysBetween, formatAmount, type CashObligation } from "./cash-obligations";

export type CockpitTodo = {
  id: string;
  severity: "urgent" | "normal";
  label: string;
  href: string;
};

const FILING_URGENT_DAYS = 5;

export function deriveCockpitTodos(
  calendar: CalendarContext,
  payroll: PayrollPeriodSummary,
  obligations: CashObligation[] = []
): CockpitTodo[] {
  const todos: CockpitTodo[] = [];

  // 合同收付:同一份「已确认」台账派生的临近未完成项进待办(付款/收款/开票)
  const [ty, tm, td] = calendar.isoDate.split("-").map(Number);
  const today = new Date(ty, (tm ?? 1) - 1, td ?? 1);
  for (const o of urgentObligations(obligations, today)) {
    const days = daysBetween(today, o.dueDate);
    const md = o.dueDate.slice(5).replace("-", "/");
    const verb = o.kind === "付款" ? "付" : o.kind === "收款" ? "收" : "开票";
    const amt = o.amount != null ? ` ${formatAmount(o.amount)}` : "";
    const when = days < 0 ? `已逾期 ${-days} 天` : days === 0 ? "今天到期" : `还剩 ${days} 天`;
    todos.push({
      id: `oblig-${o.documentId}-${o.kind}-${o.dueDate}`,
      severity: days <= 7 ? "urgent" : "normal",
      label: `${md} ${verb}「${o.counterparty}」${amt} · ${when}`,
      href:
        "/chat/new?prompt=" +
        encodeURIComponent(`关于「${o.counterparty}」这笔${o.kind}(到期 ${o.dueDate},来源 ${o.sourceDoc ?? ""}),帮我看下合同条款并准备处理`),
    });
  }

  const filing = calendar.deadlines[0];
  if (filing && filing.daysLeft <= FILING_URGENT_DAYS) {
    todos.push({
      id: "tax-filing",
      severity: "urgent",
      label:
        filing.daysLeft === 0
          ? `今天是 ${filing.day} 日申报截止日(个税扣缴、增值税及附加)`
          : `距 ${filing.day} 日申报截止还有 ${filing.daysLeft} 天(个税扣缴、增值税及附加)`,
      href: "/chat/new?prompt=" + encodeURIComponent("帮我做申报前检查:核对本月个税与增值税申报数据是否就绪")
    });
  }

  if (payroll.draftCount > 0) {
    todos.push({
      id: "payroll-draft",
      severity: "urgent",
      label: `${payroll.month} 月工资草稿 ${payroll.draftCount} 人待确认(${payroll.draftEmployees.slice(0, 3).join("、")}${payroll.draftCount > 3 ? " 等" : ""})`,
      href:
        "/chat/new?prompt=" +
        encodeURIComponent(`请展示 ${payroll.year} 年 ${payroll.month} 月工资草稿明细,我核对后确认`)
    });
  }

  if (calendar.windows.includes("payroll_prep") && payroll.draftCount === 0 && payroll.confirmedCount === 0) {
    todos.push({
      id: "payroll-not-started",
      severity: "normal",
      label: `算薪窗口:${payroll.month} 月工资尚未计算`,
      href: "/chat/new?prompt=" + encodeURIComponent("请帮我计算本月薪资个税")
    });
  }

  if (calendar.windows.includes("closing")) {
    todos.push({
      id: "month-closing",
      severity: "normal",
      label: "月末结账窗口:核对发票收齐与计提",
      href: "/chat/new?prompt=" + encodeURIComponent("月末结账:帮我核对本月报销发票是否收齐、有哪些待登记台账")
    });
  }

  return todos;
}
