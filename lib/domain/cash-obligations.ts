// 现金义务派生(确定性):把 P1「已确认」合同 metadata 的收付/开票到期,转成结构化义务,
// 喂给总览的财务日历(本月时间地图)与待办(临近未完成切片)。纯函数、无 LLM、可复算(红线 2)。
// 红线 3:只认 meta_status==='confirmed'(草稿不算);每条带 status,跨期不混。
// 红线 4:无可信到期日 / 无方向(status)→ 跳过,不编。
import type { DocMetadata, KeyDate, MetaStatus } from "@/lib/knowledge/types";

export type ObligationKind = "付款" | "收款" | "开票";

export type CashObligation = {
  documentId: number;
  counterparty: string;
  kind: ObligationKind;
  /** 金额(元);metadata 未填则 undefined,不编 */
  amount?: number;
  /** 到期日 YYYY-MM-DD */
  dueDate: string;
  /** 业务状态:待付/已付/待收/已收/待开票/已开票 */
  status: string;
  recurrence?: DocMetadata["recurrence"];
  sourceDoc?: string;
  /** 已完成(已付/已收/已开票),展示弱化、不进待办 */
  done: boolean;
};

export type ObligationSourceDoc = {
  id: number;
  fileName: string;
  metadata: DocMetadata | null;
  metaStatus: MetaStatus;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PENDING = new Set(["待付", "待收", "待开票"]);

/** status 给方向(用户口径):含"付"→付款、含"收"→收款、含"开票"→开票。 */
function kindFromStatus(status: string | undefined): ObligationKind | null {
  if (!status) return null;
  if (status.includes("开票")) return "开票";
  if (status.includes("付")) return "付款";
  if (status.includes("收")) return "收款";
  return null;
}

function isDone(status: string): boolean {
  return status.startsWith("已"); // 已付 / 已收 / 已开票
}

/** 按方向挑义务到期日:付款→付款/到期日、收款→到期/交付日、开票→开票日;都没有则取最早有效日期。 */
function pickDueDate(kind: ObligationKind, keyDates: KeyDate[] | undefined): string | null {
  const valid = (keyDates ?? []).filter((k) => ISO_DATE.test(k.date));
  if (valid.length === 0) return null;
  const prefer: Record<ObligationKind, KeyDate["kind"][]> = {
    付款: ["付款", "到期"],
    收款: ["到期", "交付"],
    开票: ["开票"],
  };
  for (const want of prefer[kind]) {
    const hit = valid.find((k) => k.kind === want);
    if (hit) return hit.date;
  }
  return valid.map((k) => k.date).sort()[0];
}

/** 从已确认文档派生现金义务。只吃 confirmed;无方向/无到期日则跳过(不编)。按到期日升序。 */
export function deriveCashObligations(docs: ObligationSourceDoc[]): CashObligation[] {
  const out: CashObligation[] = [];
  for (const d of docs) {
    if (d.metaStatus !== "confirmed" || !d.metadata) continue;
    const m = d.metadata;
    const status = m.status?.trim();
    const kind = kindFromStatus(status);
    if (!kind || !status) continue;
    const dueDate = pickDueDate(kind, m.keyDates);
    if (!dueDate) continue;
    out.push({
      documentId: d.id,
      counterparty: m.counterparty?.trim() || "未填对方",
      kind,
      amount: typeof m.amount === "number" && Number.isFinite(m.amount) ? m.amount : undefined,
      dueDate,
      status,
      recurrence: m.recurrence,
      sourceDoc: m.sourceFile?.trim() || d.fileName,
      done: isDone(status),
    });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** 本月义务(供财务日历的时间地图),已按到期日升序。 */
export function obligationsInMonth(obls: CashObligation[], year: number, month: number): CashObligation[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  return obls.filter((o) => o.dueDate.startsWith(prefix));
}

/** 紧迫义务(供待办):未完成 + 状态待办 + 到期在 withinDays 天内(含已逾期),按到期最近优先。 */
export function urgentObligations(
  obls: CashObligation[],
  today: Date,
  withinDays = 14,
  pending: Set<string> = DEFAULT_PENDING
): CashObligation[] {
  return obls
    .filter((o) => !o.done && pending.has(o.status))
    .map((o) => ({ o, days: daysBetween(today, o.dueDate) }))
    .filter(({ days }) => days <= withinDays)
    .sort((a, b) => a.days - b.days)
    .map(({ o }) => o);
}

/** o.dueDate 距 today 的天数(负=已逾期);按本地日历日计。 */
export function daysBetween(today: Date, dueDate: string): number {
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = dueDate.split("-").map(Number);
  const due = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return Math.round((due - t) / 86_400_000);
}

/** 金额人话化:≥1万显示「X.X万」,否则「X元」。 */
export function formatAmount(yuan: number): string {
  if (yuan >= 10_000) return `${Math.round(yuan / 1_000) / 10}万`;
  return `${Math.round(yuan).toLocaleString("zh-CN")}元`;
}

export type ObligationTotals = {
  /** 未完成义务笔数 */
  count: number;
  /** 已填金额合计(元);缺金额的不计入(红线4) */
  amount: number;
  /** 金额未填的笔数(amount 仅为「已知部分」) */
  unknownAmount: number;
};

export type ObligationSummary = {
  payable: ObligationTotals; // 待付
  receivable: ObligationTotals; // 待收
  toInvoice: { count: number }; // 待开票
};

/**
 * 汇总未完成(!done)义务,按方向(付款/收款/开票)聚合,供总览 KPI / 合同收付主卡。
 * 红线 2:求和落在确定性纯函数里,可复算;红线 4:金额缺失不补 0,单列 unknownAmount。
 */
export function summarizeObligations(obls: CashObligation[]): ObligationSummary {
  const blank = (): ObligationTotals => ({ count: 0, amount: 0, unknownAmount: 0 });
  const payable = blank();
  const receivable = blank();
  let toInvoice = 0;
  for (const o of obls) {
    if (o.done) continue;
    if (o.kind === "开票") {
      toInvoice += 1;
      continue;
    }
    const bucket = o.kind === "付款" ? payable : receivable;
    bucket.count += 1;
    if (typeof o.amount === "number") bucket.amount += o.amount;
    else bucket.unknownAmount += 1;
  }
  return { payable, receivable, toInvoice: { count: toInvoice } };
}
