/**
 * 功能2-链路2: 对账 ReconResult 产出 CalcReceipt
 *
 * 严格 TDD（CLAUDE.md §5）:
 *   RR-T1 在实现前 RED — r.receipt 为 undefined，断言 assert.ok 失败。
 *   实现后（ReconResult 加 receipt 字段，reconcileBankStatement 调用 buildReconReceipt）GREEN。
 */
import assert from "node:assert/strict";
import { reconcileBankStatement } from "../lib/domain/reconciliation.ts";

export const reconciliationReceiptTestPromise = (async () => {
  // ── RR-T1: receipt 字段存在（RED: 实现前 r.receipt === undefined）──────────
  const r = reconcileBankStatement(
    [
      { date: "2026-06-01", amount: 100, direction: "in" },
      { date: "2026-06-02", amount: 50, direction: "out" },
    ],
    [
      { date: "2026-06-01", amount: 100, direction: "in" },
      { date: "2026-06-02", amount: 50, direction: "out" },
    ]
  );
  assert.ok(r.receipt, "RR-T1 FAIL: receipt 字段未产出（需在 ReconResult 加 receipt 并在 reconcileBankStatement 构建）");

  // ── RR-T2: receipt.value = matchedTotal ──────────────────────────────────
  assert.equal(
    r.receipt.value,
    r.summary.matchedTotal,
    "RR-T2 FAIL: receipt.value 应等于 matchedTotal"
  );
  assert.equal(r.receipt.value, 150, "RR-T2 FAIL: 2 笔合计 150");

  // ── RR-T3: steps 数等于 matched 数（每笔勾对一步）──────────────────────────
  assert.equal(
    r.receipt.steps.length,
    r.matched.length,
    "RR-T3 FAIL: steps 数应等于 matched 数"
  );
  assert.equal(r.receipt.steps.length, 2, "RR-T3 FAIL: 2 笔匹配对应 2 步");

  // ── RR-T4: 每步 label 含银行/账面行号，inputs 含金额 ──────────────────────
  const step0 = r.receipt.steps[0];
  assert.ok(
    step0.label.includes("[0]"),
    `RR-T4 FAIL: 第一步 label 应含下标 [0]，实际: ${step0.label}`
  );
  assert.equal(
    step0.inputs.bankAmount,
    100,
    "RR-T4 FAIL: step.inputs.bankAmount"
  );
  assert.equal(
    step0.inputs.bookAmount,
    100,
    "RR-T4 FAIL: step.inputs.bookAmount"
  );
  assert.equal(step0.subtotal, 100, "RR-T4 FAIL: step.subtotal 应为匹配金额");

  // ── RR-T5: source 含银行和账面行数 ──────────────────────────────────────
  const bankSrc = r.receipt.source.find((s) => s.ref === "bank");
  const bookSrc = r.receipt.source.find((s) => s.ref === "book");
  assert.ok(bankSrc, "RR-T5 FAIL: source 缺 ref='bank'");
  assert.ok(bookSrc, "RR-T5 FAIL: source 缺 ref='book'");
  assert.equal(bankSrc!.recordCount, 2, "RR-T5 FAIL: bank recordCount 应为 2");
  assert.equal(bookSrc!.recordCount, 2, "RR-T5 FAIL: book recordCount 应为 2");

  // ── RR-T6: basis 字段 ──────────────────────────────────────────────────
  assert.equal(r.receipt.unit, "CNY", "RR-T6 FAIL: unit");
  assert.equal(
    r.receipt.basis.settlementStatus,
    "draft",
    "RR-T6 FAIL: 对账回执 settlementStatus 应为 draft（需人工确认）"
  );
  assert.equal(
    r.receipt.basis.caliberVersion,
    "reconciliation-v1",
    "RR-T6 FAIL: caliberVersion"
  );
  assert.equal(
    r.receipt.basis.asOf,
    "2026-06",
    "RR-T6 FAIL: asOf 应取输入最晚日期的年月"
  );

  // ── RR-T7: 账银两平时 caveats 为 undefined 或空 ──────────────────────────
  assert.ok(
    r.receipt.caveats === undefined || r.receipt.caveats.length === 0,
    "RR-T7 FAIL: 账银两平时不应有 caveats"
  );

  // ── RR-T8: 未两平时 caveats 非空（提示未达项）──────────────────────────────
  const unbal = reconcileBankStatement(
    [{ date: "2026-06-10", amount: 999, direction: "in" }],
    []
  );
  assert.ok(
    unbal.receipt.caveats && unbal.receipt.caveats.length > 0,
    "RR-T8 FAIL: 未两平时 receipt.caveats 应非空"
  );

  // ── RR-T9: 无匹配时 steps 空，value=0 ──────────────────────────────────
  assert.equal(unbal.receipt.steps.length, 0, "RR-T9 FAIL: 无匹配时 steps 应为空数组");
  assert.equal(unbal.receipt.value, 0, "RR-T9 FAIL: 无匹配时 value 应为 0");

  console.log("reconciliation-receipt: all 9 checks passed ✓");
})();
