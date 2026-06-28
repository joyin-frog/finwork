import assert from "node:assert/strict";
import { checkSumConsistent, checkMoneyPrecision, collectNumericIssues } from "../lib/safety/numeric-check";

// 数值校验:明细之和=合计 / 分精度 / 非有限数,容差 1 分。
export const numericCheckTestPromise = (async () => {
  const { ok, equal } = assert;

  // ── 明细之和=合计 ───────────────────────────
  ok(checkSumConsistent(500, [100, 200, 200]) === null, "T1 FAIL: 和一致应通过");
  ok(checkSumConsistent(500, [100, 200, 199.99]) === null, "T2 FAIL: 1分容差内应通过");
  {
    const r = checkSumConsistent(500, [100, 200, 199]);
    ok(r !== null && r.kind === "sum", "T3 FAIL: 差1元应告警 sum");
  }

  // ── 真实薪资不变量 gross = net + social + fund + tax ──
  ok(checkSumConsistent(10000, [7000, 1000, 500, 1500]) === null, "T4 FAIL: 自洽薪资应通过");
  ok(checkSumConsistent(10000, [7000, 1000, 500, 1400]) !== null, "T5 FAIL: 不自洽薪资应告警");

  // ── 分精度 / 非有限数 ───────────────────────
  ok(checkMoneyPrecision(184.32) === null, "T6 FAIL: 合法分精度应通过");
  {
    const r = checkMoneyPrecision(184.325);
    ok(r !== null && r.kind === "precision", "T7 FAIL: 超分精度应告警");
  }
  ok(checkMoneyPrecision(Number.NaN) !== null, "T8 FAIL: NaN 应告警");
  ok(checkSumConsistent(Number.POSITIVE_INFINITY, [1]) !== null, "T9 FAIL: Inf 应告警");

  // ── collectNumericIssues 汇总 ───────────────
  equal(
    collectNumericIssues([null, checkMoneyPrecision(Number.NaN), null]).length,
    1,
    "T10 FAIL: 应收集 1 个问题"
  );

  console.log("numeric-check tests passed");
})();
