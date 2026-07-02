import assert from "node:assert/strict";
import { summarizeVouchers } from "../lib/domain/voucher-summary.ts";
import type { SlipResult } from "../lib/domain/voucher-summary.ts";

// 汇总:把每张单据的金额勾稽 + 科目映射结果聚合成大表,统计 ✅自动/⚠️待确认/❌失败。
// AC6:某张 OCR 失败跳过,不影响其余行的计数与状态。
export const voucherSummaryTestPromise = (async () => {
  const results: SlipResult[] = [
    { file: "1.jpg", ocrOk: true, amountOk: true, accountOk: true }, // 全通过 → auto
    { file: "2.jpg", ocrOk: true, amountOk: false, amountIssue: "大写与合计对不上", accountOk: true }, // 金额⚠️
    { file: "3.jpg", ocrOk: false }, // OCR 失败 → failed(跳过)
    { file: "4.jpg", ocrOk: true, amountOk: true, accountOk: false, accountIssue: "科目未命中,需人工" }, // 科目⚠️
  ];

  const s = summarizeVouchers(results);

  // ── 计数 ──
  assert.equal(s.total, 4, "S1 FAIL: total=4");
  assert.equal(s.autoPass, 1, "S1 FAIL: 自动通过=1(仅 1.jpg)");
  assert.equal(s.needConfirm, 2, "S1 FAIL: 待确认=2(2.jpg 金额 + 4.jpg 科目)");
  assert.equal(s.failed, 1, "S1 FAIL: 失败=1(3.jpg OCR 挂)");

  // ── 逐行状态 ──
  assert.equal(s.rows[0].status, "auto", "S2 FAIL: 1.jpg 应自动通过");
  assert.equal(s.rows[1].status, "needs_confirm", "S2 FAIL: 2.jpg 应待确认");
  assert.ok(s.rows[1].issues.includes("大写与合计对不上"), "S2 FAIL: 2.jpg issue 应含金额说明");
  assert.equal(s.rows[2].status, "failed", "S2 FAIL: 3.jpg 应失败");
  assert.equal(s.rows[3].status, "needs_confirm", "S2 FAIL: 4.jpg 应待确认");
  assert.ok(s.rows[3].issues.includes("科目未命中,需人工"), "S2 FAIL: 4.jpg issue 应含科目说明");

  // ── AC6: 失败行不干扰其余(去掉失败行,计数仍自洽)──
  assert.equal(s.autoPass + s.needConfirm + s.failed, s.total, "S3 FAIL: 三类之和=total,无漏计");

  // ── 一张单据同时金额+科目都⚠️ → 两条 issue 都在,但只计一次待确认 ──
  const both = summarizeVouchers([
    { file: "x.jpg", ocrOk: true, amountOk: false, amountIssue: "金额存疑", accountOk: false, accountIssue: "科目存疑" },
  ]);
  assert.equal(both.needConfirm, 1, "S4 FAIL: 一张多问题只计一次待确认");
  assert.equal(both.rows[0].issues.length, 2, "S4 FAIL: 两条 issue 都列出");

  // ── 空批次 → 全 0,不崩 ──
  const empty = summarizeVouchers([]);
  assert.equal(empty.total, 0, "S5 FAIL: 空批次 total=0");
  assert.equal(empty.rows.length, 0, "S5 FAIL: 空批次无行");

  console.log("voucher-summary: 计数/逐行状态/失败跳过不干扰/多问题合并/空批次 ✓");
})();
