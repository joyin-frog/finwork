/**
 * 功能2-链路3: 报销 ReimbursementItem 产出结构化 ruleHits + CalcReceipt
 *
 * 严格 TDD（CLAUDE.md §5）:
 *   RE-T1 在实现前 RED — items[0].ruleHits 为 undefined，断言失败。
 *   实现后（types.ts 加 RuleHit/ruleHits?/receipt?，reimbursement.ts 补充逻辑）GREEN。
 */
import assert from "node:assert/strict";
import {
  validateReimbursements,
  mapWarningsToRuleHits,
} from "../lib/domain/reimbursement.ts";

export const reimbursementReceiptTestPromise = (async () => {
  const policy = { singleLimit: 1500 };

  // ── RE-T1: ruleHits / receipt 字段存在（RED: 实现前 undefined）──────────
  const items = validateReimbursements(
    [
      {
        employeeName: "张三",
        expenseDate: "2026-06-01",
        invoiceNo: "INV-001",
        category: "交通",
        amount: 200,
      },
      {
        employeeName: "李四",
        expenseDate: "2026-06-02",
        invoiceNo: "INV-002",
        category: "住宿",
        amount: 2000, // 超过 singleLimit=1500
      },
    ],
    policy
  );
  assert.ok(
    items[0].ruleHits !== undefined,
    "RE-T1 FAIL: ruleHits 字段未产出（需在 validateReimbursements 后补充 ruleHits）"
  );
  assert.ok(
    items[0].receipt !== undefined,
    "RE-T1 FAIL: receipt 字段未产出（需在 validateReimbursements 后补充 receipt）"
  );

  // ── RE-T2: 超标规则命中（threshold + actual）──────────────────────────────
  const over = items[1];
  assert.ok(
    over.warnings.includes("超过单笔标准"),
    "RE-T2 FAIL: warnings 应含 超过单笔标准（回归：Python 脚本规则应仍生效）"
  );
  const overHit = over.ruleHits!.find((h) => h.rule === "single_limit_exceeded");
  assert.ok(overHit, "RE-T2 FAIL: ruleHits 应含 single_limit_exceeded");
  assert.equal(
    overHit!.threshold,
    1500,
    "RE-T2 FAIL: threshold 应为 policy.singleLimit=1500"
  );
  assert.equal(
    overHit!.actual,
    2000,
    "RE-T2 FAIL: actual 应为 item.amount=2000"
  );

  // ── RE-T3: 干净报销（无警告）ruleHits=[], receipt.steps=[] ─────────────────
  const clean = items[0];
  assert.deepEqual(clean.warnings, [], "RE-T3 FAIL: 干净报销 warnings 应为空");
  assert.deepEqual(clean.ruleHits, [], "RE-T3 FAIL: 干净报销 ruleHits 应为空数组");
  assert.deepEqual(clean.receipt!.steps, [], "RE-T3 FAIL: 干净报销 receipt.steps 应为空");

  // ── RE-T4: receipt.value / unit / basis ──────────────────────────────────
  assert.equal(clean.receipt!.value, 200, "RE-T4 FAIL: receipt.value 应为 item.amount=200");
  assert.equal(clean.receipt!.unit, "CNY", "RE-T4 FAIL: unit");
  assert.equal(
    clean.receipt!.basis.settlementStatus,
    "draft",
    "RE-T4 FAIL: 报销回执 settlementStatus 应为 draft"
  );
  assert.ok(
    clean.receipt!.basis.caliberVersion.includes("1500"),
    `RE-T4 FAIL: caliberVersion 应含 singleLimit=1500，实际: ${clean.receipt!.basis.caliberVersion}`
  );
  assert.equal(
    clean.receipt!.basis.asOf,
    "2026-06",
    "RE-T4 FAIL: asOf 应取 expenseDate 的年月"
  );

  // ── RE-T5: source 含发票号 ────────────────────────────────────────────────
  assert.equal(
    clean.receipt!.source[0].ref,
    "INV-001",
    "RE-T5 FAIL: source.ref 应为发票号"
  );
  assert.equal(
    clean.receipt!.source[0].recordCount,
    1,
    "RE-T5 FAIL: source.recordCount 应为 1"
  );

  // ── RE-T6: 批内发票重复 → ruleHits 含 duplicate_invoice ─────────────────
  const dupItems = validateReimbursements(
    [
      {
        employeeName: "A",
        expenseDate: "2026-06-01",
        invoiceNo: "DUP-1",
        category: "交通",
        amount: 100,
      },
      {
        employeeName: "B",
        expenseDate: "2026-06-02",
        invoiceNo: "DUP-1",
        category: "交通",
        amount: 100,
      },
    ],
    policy
  );
  const dupHit = dupItems[0].ruleHits!.find((h) => h.rule === "duplicate_invoice");
  assert.ok(
    dupHit,
    "RE-T6 FAIL: 批内重复的 ruleHits 应含 duplicate_invoice"
  );

  // ── RE-T7: mapWarningsToRuleHits 纯函数，可单独测试 ───────────────────────
  const hits = mapWarningsToRuleHits(
    ["超过单笔标准", "发票号重复"],
    { amount: 3000 },
    { singleLimit: 1500 }
  );
  assert.equal(hits.length, 2, "RE-T7 FAIL: 2 条 warning → 2 条 ruleHit");
  assert.equal(hits[0].rule, "single_limit_exceeded", "RE-T7 FAIL: rule[0]");
  assert.equal(hits[0].threshold, 1500, "RE-T7 FAIL: threshold");
  assert.equal(hits[0].actual, 3000, "RE-T7 FAIL: actual");
  assert.equal(hits[1].rule, "duplicate_invoice", "RE-T7 FAIL: rule[1]");

  // ── RE-T8: 有规则命中时 receipt.caveats 非空 ─────────────────────────────
  assert.ok(
    over.receipt!.caveats && over.receipt!.caveats.length > 0,
    "RE-T8 FAIL: 有规则命中时 receipt.caveats 应非空"
  );

  console.log("reimbursement-receipt: all 8 checks passed ✓");
})();
