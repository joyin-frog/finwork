import assert from "node:assert/strict";
import { processVoucherBatch } from "../lib/domain/voucher-batch.ts";
import type { KingdeeAccount } from "../lib/db/finance-store.ts";

// 批量处理:一次传整批单据,内部逐张勾稽+映射+分录,汇总+出清单。治本:把 40+ 次 LLM 往返压成 1 次。
export const voucherBatchTestPromise = (async () => {
  const chart: KingdeeAccount[] = [
    { code: "6602.08", name: "管理费用-水电费", type: "费用", dimension: "部门" },
    { code: "6602.04", name: "管理费用-旅差费", type: "费用", dimension: "部门" },
    { code: "1002", name: "银行存款", type: "资产", dimension: "银行账号" },
    { code: "1221.03", name: "其他应收款-个人往来", type: "资产", dimension: "员工" },
  ];
  const mappings = [
    { keyword: "水电费", code: "6602.08" },
    { keyword: "住宿", code: "6602.04" },
    { keyword: "餐饮", code: "6602.04" },
  ];

  const out = processVoucherBatch({
    slips: [
      // ① 水电费单笔:勾稽ok + 映射ok → auto
      { file: "shuidian.pdf", date: "2025-01-16", lineItems: [{ summary: "水电费", amountYuan: 6155.8 }], totalYuan: 6155.8, capitalText: "陆仟壹佰伍拾伍元捌角", departmentName: "行政部" },
      // ② 报销单多明细 + 预借款:住宿/餐饮都能映射,带原借款5000 → 冲销分录
      { file: "baoxiao.jpg", date: "2026-06-01", lineItems: [{ summary: "住宿费", amountYuan: 1377 }, { summary: "餐饮费", amountYuan: 2323 }], totalYuan: 3700, capitalText: "叁仟柒佰元整", advanceYuan: 5000, payeeName: "胡明班", departmentName: "综合部" },
      // ③ 未知费用:映射不到 → needs_confirm
      { file: "unknown.jpg", date: "2026-06-02", lineItems: [{ summary: "神秘费用", amountYuan: 999 }], totalYuan: 999, capitalText: "玖佰玖拾玖元整", departmentName: "综合部" },
    ],
    mappings,
    chart,
    paymentAccount: { code: "1002", name: "银行存款" },
    advanceAccount: { code: "1221.03", name: "其他应收款-个人往来" },
  });

  // ── 每张诊断 ──
  assert.equal(out.vouchers.length, 3, "PB1 FAIL: 3 张");
  assert.equal(out.vouchers[0].status, "auto", "PB1 FAIL: 水电费勾稽+映射都过→auto");
  assert.equal(out.vouchers[0].lines.length, 2, "PB1 FAIL: 水电费借1贷1");
  assert.equal(out.vouchers[2].status, "needs_confirm", "PB1 FAIL: 未知费用映射不到→needs_confirm");
  assert.ok(out.vouchers[2].issues.length > 0, "PB1 FAIL: needs_confirm 应有 issue");

  // ── ② 报销单:预借款冲销(借费用3700 + 借银行退回1300 / 贷其他应收款5000)──
  const v2 = out.vouchers[1];
  assert.equal(v2.balanced, true, "PB2 FAIL: 报销单借贷平衡");
  assert.ok(v2.lines.some((l) => l.account === "1221.03" && l.creditYuan === 5000), "PB2 FAIL: 冲销贷其他应收款5000");
  assert.ok(v2.lines.some((l) => l.account === "1002" && l.debitYuan === 1300), "PB2 FAIL: 退回借银行1300");

  // ── 汇总统计 ──
  assert.equal(out.summary.total, 3, "PB3 FAIL: total=3");
  assert.equal(out.summary.autoPass, 2, "PB3 FAIL: auto=2(水电费+报销单)");
  assert.equal(out.summary.needConfirm, 1, "PB3 FAIL: needConfirm=1(未知)");

  // ── 清单:所有凭证行摊平(2+4+2=8 行)──
  assert.equal(out.sheet.rows.length, 8, "PB4 FAIL: 清单 8 行(2+4+2)");
  assert.equal(out.sheet.headers[0], "日期", "PB4 FAIL: 清单表头");

  // ── 默认/传入科目也必须存在于导入科目表,否则不能 auto ──
  const invalidDefaultAccounts = processVoucherBatch({
    slips: [
      { file: "detail-chart.pdf", date: "2026-06-03", lineItems: [{ summary: "水电费", amountYuan: 100 }], totalYuan: 100, capitalText: "壹佰元整" },
      { file: "advance.pdf", date: "2026-06-04", lineItems: [{ summary: "住宿费", amountYuan: 100 }], totalYuan: 100, capitalText: "壹佰元整", advanceYuan: 100, payeeName: "张三" },
    ],
    mappings,
    chart: chart.filter((account) => account.code !== "1002" && account.code !== "1221.03"),
    paymentAccount: { code: "1002", name: "银行存款" },
    advanceAccount: { code: "1221.03", name: "其他应收款-个人往来" },
  });
  assert.equal(invalidDefaultAccounts.vouchers[0].status, "needs_confirm", "PB5 FAIL: 付款科目不在科目表时不能 auto");
  assert.ok(invalidDefaultAccounts.vouchers[0].issues.some((issue) => issue.includes("付款科目待确认")), "PB5 FAIL: 应提示付款科目待确认");
  assert.ok(invalidDefaultAccounts.vouchers[1].issues.some((issue) => issue.includes("预借款科目待确认")), "PB5 FAIL: 冲销时应提示预借款科目待确认");

  console.log("voucher-batch: 批量勾稽/映射/预借款冲销/汇总/清单一次出 ✓");
})();
