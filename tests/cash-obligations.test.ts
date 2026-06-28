import assert from "node:assert/strict";
import {
  deriveCashObligations,
  obligationsInMonth,
  urgentObligations,
  summarizeObligations,
  daysBetween,
  formatAmount,
  type ObligationSourceDoc,
} from "../lib/domain/cash-obligations.ts";
import type { DocMetadata, MetaStatus } from "../lib/knowledge/types.ts";

const eq = assert.equal;
const ok = assert.ok;

function doc(id: number, meta: DocMetadata | null, metaStatus: MetaStatus = "confirmed"): ObligationSourceDoc {
  return { id, fileName: `f${id}.pdf`, metadata: meta, metaStatus };
}

export const cashObligationsTestPromise = (async () => {
  // ── AC1: status 给方向 + 按方向选到期日 + 升序 ──
  const obls = deriveCashObligations([
    doc(1, { counterparty: "金蝶", amount: 50000, status: "待付", keyDates: [{ kind: "签订", date: "2026-01-01" }, { kind: "付款", date: "2026-06-30" }] }),
    doc(2, { counterparty: "客户A", amount: 120000, status: "待收", keyDates: [{ kind: "到期", date: "2026-06-20" }] }),
    doc(3, { counterparty: "客户B", status: "待开票", keyDates: [{ kind: "开票", date: "2026-06-15" }] }),
  ]);
  eq(obls.length, 3, "AC1: 三条都应派生");
  eq(obls.find((o) => o.documentId === 1)!.kind, "付款", "AC1: 待付→付款");
  eq(obls.find((o) => o.documentId === 2)!.kind, "收款", "AC1: 待收→收款");
  eq(obls.find((o) => o.documentId === 3)!.kind, "开票", "AC1: 待开票→开票");
  eq(obls.find((o) => o.documentId === 1)!.dueDate, "2026-06-30", "AC1: 付款义务取付款日(非签订)");
  ok(obls[0].dueDate <= obls[1].dueDate && obls[1].dueDate <= obls[2].dueDate, "AC1: 按到期日升序");

  // ── AC2: 只认 confirmed(草稿/none 不入,红线3)──
  eq(
    deriveCashObligations([
      doc(10, { counterparty: "X", status: "待付", keyDates: [{ kind: "付款", date: "2026-06-10" }] }, "draft"),
      doc(11, { counterparty: "Y", status: "待付", keyDates: [{ kind: "付款", date: "2026-06-10" }] }, "none"),
    ]).length,
    0,
    "AC2: 草稿/none 不派生"
  );

  // ── AC3: 无方向/无到期日/坏日期/无 metadata → 跳过不编(红线4)──
  eq(
    deriveCashObligations([
      doc(20, { counterparty: "无状态", amount: 1, keyDates: [{ kind: "付款", date: "2026-06-10" }] }), // 无 status
      doc(21, { counterparty: "无日期", status: "待付", keyDates: [] }), // 无 keyDates
      doc(22, { counterparty: "坏日期", status: "待付", keyDates: [{ kind: "付款", date: "六月十号" }] }), // 非 ISO
      doc(23, null), // 无 metadata
    ]).length,
    0,
    "AC3: 缺方向/缺日期/坏日期/无metadata 全跳过"
  );

  // ── AC4: amount 缺→undefined 不编;已*→done ──
  const noAmt = deriveCashObligations([doc(30, { counterparty: "Z", status: "已付", keyDates: [{ kind: "付款", date: "2026-06-01" }] })]);
  eq(noAmt[0].amount, undefined, "AC4: 无金额→undefined");
  eq(noAmt[0].done, true, "AC4: 已付→done");

  // ── AC5: obligationsInMonth ──
  eq(obligationsInMonth(obls, 2026, 6).length, 3, "AC5: 三条都在 2026-06");
  eq(obligationsInMonth(obls, 2026, 7).length, 0, "AC5: 7月无");

  // ── AC6: urgentObligations(未完成+待办状态+14天内含逾期,逾期最久最前)──
  const today = new Date(2026, 5, 18); // 本地 2026-06-18
  const urgent = urgentObligations(obls, today, 14);
  eq(urgent.length, 3, "AC6: 三条都在窗口(含逾期)");
  eq(urgent[0].documentId, 3, "AC6: 逾期最久(06-15)排最前");
  const doneOne = deriveCashObligations([doc(40, { counterparty: "D", status: "已付", keyDates: [{ kind: "付款", date: "2026-06-19" }] })])[0];
  ok(!urgentObligations([...obls, doneOne], today, 14).some((o) => o.documentId === 40), "AC6: 已付不进紧迫");

  // ── AC7: daysBetween / formatAmount ──
  eq(daysBetween(new Date(2026, 5, 18), "2026-06-20"), 2, "AC7: daysBetween 正");
  eq(daysBetween(new Date(2026, 5, 18), "2026-06-15"), -3, "AC7: daysBetween 逾期为负");
  eq(formatAmount(50000), "5万", "AC7: ≥1万→万");
  eq(formatAmount(8000), "8,000元", "AC7: <1万→元");

  // ── AC8: summarizeObligations(未完成按方向聚合;金额缺失不补0、单列 unknownAmount;done 不计;红线2/4)──
  const noAmtPay = deriveCashObligations([doc(51, { counterparty: "F", status: "待付", keyDates: [{ kind: "付款", date: "2026-06-05" }] })])[0];
  const donePaid = deriveCashObligations([doc(52, { counterparty: "G", amount: 999, status: "已付", keyDates: [{ kind: "付款", date: "2026-06-02" }] })])[0];
  const sum = summarizeObligations([...obls, noAmtPay, donePaid]);
  eq(sum.payable.count, 2, "AC8: 待付2笔(含1笔无金额;已付不计)");
  eq(sum.payable.amount, 50000, "AC8: 待付已知合计5万(无金额不补0、已付999不计)");
  eq(sum.payable.unknownAmount, 1, "AC8: 1笔待付无金额");
  eq(sum.receivable.count, 1, "AC8: 待收1笔");
  eq(sum.receivable.amount, 120000, "AC8: 待收12万");
  eq(sum.toInvoice.count, 1, "AC8: 待开票1笔");

  console.log("cash-obligations: all 8 checks passed ✓");
})();
