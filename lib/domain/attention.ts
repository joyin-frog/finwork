// 总览页关注区推导:由业务数据 + 财务日历自动生成,urgent 在前。
// 每条 AttentionItem 的主动作指向一次对话入口——对话即任务。

import type { CalendarContext } from "./tax-calendar";
import type { PayrollPeriodSummary, InvoiceLedgerStats } from "@/lib/db/finance-store";
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
/** R7：当月几日后开始检查台账断档（包含边界不算，需 day > 阈值） */
const INVOICE_GAP_CHECK_DAY = 15;
/** R8：当月几日后开始检查上月经营指标（包含边界不算，需 day > 阈值） */
const METRICS_CHECK_DAY = 5;

export function deriveAttentionItems(
  calendar: CalendarContext,
  payroll: PayrollPeriodSummary,
  obligations: CashObligation[] = [],
  invoiceStats: InvoiceLedgerStats = { total: 0, addedThisMonth: 0 },
  hasMetricsForLastMonth: boolean = false,
  filingPrecheckStarter: string | undefined = undefined
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

  // R6: 申报前复核入口（LLM 型）—— tax_filing 窗口时常驻
  if (calendar.windows.includes("tax_filing")) {
    const href = filingPrecheckStarter
      ? "/chat/new?prompt=" + encodeURIComponent(filingPrecheckStarter)
      : "/chat/new";
    items.push({
      id: "filing-precheck",
      source: "rule",
      sourceLabel: "申报前复核",
      roleId: "tax-officer",
      severity: "normal",
      title: "申报前复核（发起对话，消耗额度）",
      actions: [
        {
          label: "发起申报前复核",
          href,
          primary: true,
        },
      ],
    });
  }

  // R7: 台账断档——当月 15 日后且本月新增发票=0
  if (td !== undefined && td > INVOICE_GAP_CHECK_DAY && invoiceStats.addedThisMonth === 0) {
    items.push({
      id: "invoice-ledger-gap",
      source: "rule",
      sourceLabel: "台账断档",
      severity: "normal",
      title: "本月发票台账零登记，请自查是否漏登",
      actions: [
        {
          label: "去自查台账",
          href:
            "/chat/new?prompt=" +
            encodeURIComponent("请帮我检查本月发票台账是否有漏登，并列出需要补录的发票"),
          primary: true,
        },
      ],
    });
  }

  // R8: 上月经营指标未登记——当月 5 日后且上月无指标记录
  if (td !== undefined && td > METRICS_CHECK_DAY && !hasMetricsForLastMonth) {
    items.push({
      id: "metrics-missing",
      source: "rule",
      sourceLabel: "经营指标",
      severity: "normal",
      title: "上月经营指标未登记，请补录以便生成报告",
      actions: [
        {
          label: "补录经营指标",
          href:
            "/chat/new?prompt=" +
            encodeURIComponent("请帮我登记上月经营数据（收入、成本、利润）"),
          primary: true,
        },
      ],
    });
  }

  // urgent 全部在前；同 severity 内 rule 在前、gate 按 occurredAt 降序在后
  sortAttentionItems(items);

  return items;
}

/**
 * 排序规则（编排者裁决 2026-07-02）：
 * - urgent 全部在前；
 * - 同 severity 内：rule 在前，gate 按 occurredAt 降序在后。
 */
export function sortAttentionItems(items: AttentionItem[]): void {
  items.sort((a, b) => {
    // urgent 优先
    if (a.severity !== b.severity) {
      return a.severity === "urgent" ? -1 : 1;
    }
    // 同 severity：rule 在前，gate 在后
    if (a.source !== b.source) {
      return a.source === "rule" ? -1 : 1;
    }
    // 同 source=gate：occurredAt 降序（最新在前）
    if (a.source === "gate" && b.source === "gate") {
      const aT = a.occurredAt ?? "";
      const bT = b.occurredAt ?? "";
      if (aT < bT) return 1;
      if (aT > bT) return -1;
    }
    return 0;
  });
}

/**
 * gate 供给源转换：blocked dispatch 行 → AttentionItem（spec §3.1）
 *
 * 分支 A：conversationId 有 → action.href = /chat/recent?id=，label = 「回到原对话」
 * 分支 B：conversationId 无 → action.href = /chat/new?prompt=（含角色名与 summary），label = 「继续处理」
 */
export function blockedDispatchToAttentionItem(
  row: {
    id: number;
    roleId: string;
    label: string | null;
    summary: string | null;
    blockedReason: string;
    conversationId: string | null;
    endedAt: string | null;
    /** 业务对象标签（有值时拼入标题） */
    businessObject?: string | null;
    /** 期间，格式 YYYY-MM（有值时拼入标题） */
    period?: string | null;
  },
  roleName: string
): AttentionItem {
  const summaryFirstLine = (row.summary ?? "").split("\n")[0].trim();

  // 标题前缀：有对象/期间时拼为「角色名 · 对象 期间」，否则只用角色名
  let titlePrefix = roleName;
  if (row.businessObject || row.period) {
    const parts: string[] = [roleName];
    const objPeriod = [row.businessObject, row.period].filter(Boolean).join(" ");
    parts.push(objPeriod);
    titlePrefix = parts.join(" · ");
  }

  const title = `${titlePrefix}的工作停在确认门：${summaryFirstLine}`;

  let action: { label: string; href: string; primary: true };
  if (row.conversationId) {
    action = {
      label: "回到原对话",
      href: `/chat/recent?id=${row.conversationId}`,
      primary: true,
    };
  } else {
    const prompt = `继续处理${roleName}的任务：${summaryFirstLine}`;
    action = {
      label: "继续处理",
      href: `/chat/new?prompt=${encodeURIComponent(prompt)}`,
      primary: true,
    };
  }

  return {
    id: `gate-${row.id}`,
    source: "gate",
    sourceLabel: "停在确认门",
    roleId: row.roleId,
    severity: "normal",
    title,
    actions: [action],
    occurredAt: row.endedAt ?? undefined,
  };
}
