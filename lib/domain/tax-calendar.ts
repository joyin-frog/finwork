// 财务月度日历:财务的时间按截止日组织(报税期/算薪/结账)。
// 申报截止按固定 15 日计算;如遇节假日顺延以税务局通知为准(本模块不做顺延推算)。

export type CalendarWindowId = "tax_filing" | "payroll_prep" | "closing" | "normal";

export type TaxDeadline = {
  name: string;
  /** 当月截止日(号) */
  day: number;
  daysLeft: number;
};

export type CalendarContext = {
  isoDate: string;
  /** 当前命中的窗口(可叠加,不含 normal) */
  windows: CalendarWindowId[];
  primaryWindow: CalendarWindowId;
  windowLabel: string;
  /** 本月尚未过期的申报截止日 */
  deadlines: TaxDeadline[];
  notice: string;
};

export type CalendarOptions = {
  /** 发薪日(号),默认 15;算薪窗口为发薪日前 5 天 */
  payday?: number;
};

const FILING_DEADLINE_DAY = 15;
const CLOSING_START_DAY = 25;
const PAYROLL_PREP_DAYS = 5;

const WINDOW_LABELS: Record<CalendarWindowId, string> = {
  tax_filing: "报税期",
  payroll_prep: "算薪窗口",
  closing: "月末结账窗口",
  normal: "月中平峰"
};

export const CALENDAR_NOTICE = "申报截止如遇节假日顺延,以税务局当月通知为准";

export function getCalendarContext(date: Date, opts: CalendarOptions = {}): CalendarContext {
  const payday = opts.payday ?? 15;
  const day = date.getDate();

  const windows: CalendarWindowId[] = [];
  if (day <= FILING_DEADLINE_DAY) windows.push("tax_filing");
  if (day >= payday - PAYROLL_PREP_DAYS && day < payday) windows.push("payroll_prep");
  if (day >= CLOSING_START_DAY) windows.push("closing");

  const primaryWindow = windows[0] ?? "normal";

  const deadlines: TaxDeadline[] =
    day <= FILING_DEADLINE_DAY
      ? [
          { name: "个税扣缴申报", day: FILING_DEADLINE_DAY, daysLeft: FILING_DEADLINE_DAY - day },
          { name: "增值税及附加申报", day: FILING_DEADLINE_DAY, daysLeft: FILING_DEADLINE_DAY - day }
        ]
      : [];

  return {
    isoDate: toIsoDate(date),
    windows,
    primaryWindow,
    windowLabel: WINDOW_LABELS[primaryWindow],
    deadlines,
    notice: CALENDAR_NOTICE
  };
}

/** 注入 system prompt 的日历段:让 agent 知道当前节点并在相关任务中主动提醒 */
export function buildCalendarPromptSection(date: Date, opts: CalendarOptions = {}): string {
  const ctx = getCalendarContext(date, opts);
  const lines = [
    "## 财务日历",
    `今天是 ${ctx.isoDate},当前处于${ctx.windowLabel}。`
  ];
  if (ctx.deadlines.length > 0) {
    const daysLeft = ctx.deadlines[0].daysLeft;
    const names = ctx.deadlines.map((d) => d.name).join("、");
    lines.push(
      daysLeft === 0
        ? `今天(${ctx.deadlines[0].day} 日)是${names}截止日(${ctx.notice})。`
        : `距 ${ctx.deadlines[0].day} 日${names}截止还有 ${daysLeft} 天(${ctx.notice})。`
    );
  }
  if (ctx.windows.includes("payroll_prep")) {
    lines.push("临近发薪日,工资和个税计算任务优先处理。");
  }
  if (ctx.windows.includes("closing")) {
    lines.push("处于月末结账窗口,留意计提、结转和发票收齐情况。");
  }
  lines.push("处理薪税、申报、结账相关任务时主动提醒临近的截止日;与此无关的对话不要重复日历信息。");
  return lines.join("\n");
}

export type ChatQuickPrompt = {
  label: string;
  prompt: string;
  /** 节奏提示,如"距 15 日申报截止还有 3 天" */
  hint?: string;
};

/** 对话空状态的快捷任务入口:按当前月度节奏排序,最多 3 条,截止最近的排最前。 */
export function getChatQuickPrompts(date: Date, opts: CalendarOptions = {}): ChatQuickPrompt[] {
  const ctx = getCalendarContext(date, opts);
  const prompts: ChatQuickPrompt[] = [];

  if (ctx.deadlines.length > 0) {
    const deadline = ctx.deadlines[0];
    prompts.push({
      label: "申报前数据复核",
      hint: deadline.daysLeft === 0
        ? `今天是 ${deadline.day} 日申报截止日`
        : `距 ${deadline.day} 日申报截止还有 ${deadline.daysLeft} 天`,
      prompt: "申报截止快到了,帮我过一遍本月个税申报数据:哪些员工的工资还没确认?有没有遗漏?"
    });
  }
  if (ctx.windows.includes("payroll_prep")) {
    prompts.push({
      label: "计算本月工资",
      hint: "临近发薪日",
      prompt: "临近发薪日,帮我计算本月工资和个税,我把员工薪资数据发给你。"
    });
  }
  if (ctx.windows.includes("closing")) {
    prompts.push({
      label: "月末结账清单",
      hint: "月末结账窗口",
      prompt: "月末结账了,帮我列一份核对清单:计提、结转、发票收齐情况。"
    });
  }
  // 平峰日(无报税/算薪/结账窗口)的兜底入口:按 P1-P3 重点,经营分析/税务筹划优先;
  // 合同要素提炼属知识库流程(非对话),不放这里;报销保留为普通入口、不再当头条。
  prompts.push(
    { label: "经营分析", prompt: "帮我做经营分析,我把金蝶导出的财务报表发给你。" },
    { label: "查税务优惠", prompt: "帮我看看公司能享受哪些税收优惠、补贴和政策。" },
    { label: "核对报销批次", prompt: "帮我核对一批报销单,我把明细发给你。" }
  );

  return prompts.slice(0, 3);
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
