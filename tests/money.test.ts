import assert from "node:assert/strict";
import {
  yuanToFen,
  fenToYuan,
  roundHalfUp,
  roundBankers,
  roundFen,
  allocateFen,
} from "../lib/domain/money.ts";

// 整数分金额工具:yuanToFen / fenToYuan / roundHalfUp / roundBankers / allocateFen(尾差调整)
export const moneyTestPromise = (async () => {
  // ── yuanToFen ──────────────────────────────────────────────────────────
  assert.equal(yuanToFen(1.23), 123, "T1 FAIL: 1.23元 → 123分");
  assert.equal(yuanToFen(0.01), 1, "T2 FAIL: 0.01元(1分) → 1分");
  assert.equal(yuanToFen(0), 0, "T3 FAIL: 0元 → 0分");
  // JS 浮点陷阱: 0.1+0.2 = 0.30000000000000004，但 Math.round×100 应补回 30
  assert.equal(yuanToFen(0.1 + 0.2), 30, "T4 FAIL: 浮点陷阱 0.1+0.2 应补回 30分");
  assert.equal(yuanToFen(100), 10000, "T5 FAIL: 100元 → 10000分");
  assert.throws(() => yuanToFen(Number.NaN), /无效金额/, "T6 FAIL: NaN 应抛错");
  assert.throws(() => yuanToFen(Infinity), /无效金额/, "T7 FAIL: Infinity 应抛错");

  // ── fenToYuan ──────────────────────────────────────────────────────────
  assert.equal(fenToYuan(123), 1.23, "T8 FAIL: 123分 → 1.23元");
  assert.equal(fenToYuan(1), 0.01, "T9 FAIL: 1分 → 0.01元");
  assert.equal(fenToYuan(0), 0, "T10 FAIL: 0分 → 0元");
  assert.throws(() => fenToYuan(1.5), /整数/, "T11 FAIL: 非整数分应抛错");

  // ── roundHalfUp ────────────────────────────────────────────────────────
  assert.equal(roundHalfUp(2.5), 3, "T12 FAIL: 2.5 四舍五入 → 3");
  assert.equal(roundHalfUp(2.4), 2, "T13 FAIL: 2.4 → 2");
  assert.equal(roundHalfUp(1.5), 2, "T14 FAIL: 1.5 → 2");
  assert.equal(roundHalfUp(0.5), 1, "T15 FAIL: 0.5 → 1");
  assert.equal(roundHalfUp(-2.5), -2, "T16 FAIL: -2.5 half_up → -2(向正无穷)");

  // ── roundBankers (银行家舍入) ──────────────────────────────────────────
  assert.equal(roundBankers(0.5), 0, "T17 FAIL: 0.5 银行家→偶数 0");
  assert.equal(roundBankers(1.5), 2, "T18 FAIL: 1.5 银行家→偶数 2");
  assert.equal(roundBankers(2.5), 2, "T19 FAIL: 2.5 银行家→偶数 2");
  assert.equal(roundBankers(3.5), 4, "T20 FAIL: 3.5 银行家→偶数 4");
  assert.equal(roundBankers(2.4), 2, "T21 FAIL: 2.4 → 2(普通)");
  assert.equal(roundBankers(2.6), 3, "T22 FAIL: 2.6 → 3(普通)");

  // ── roundFen 路由 ──────────────────────────────────────────────────────
  assert.equal(roundFen(2.5, "half_up"), 3, "T23 FAIL: roundFen half_up 2.5→3");
  assert.equal(roundFen(2.5, "bankers"), 2, "T24 FAIL: roundFen bankers 2.5→2");

  // ── allocateFen 尾差调整(核心) ─────────────────────────────────────────
  // 1000分 ÷ 3 部门 → [333, 333, 334]，之和严格=1000
  {
    const parts = allocateFen(1000, [1, 1, 1]);
    assert.equal(parts.length, 3, "T25 FAIL: 应分3份");
    assert.equal(parts[0], 333, "T25 FAIL: 第1份=333");
    assert.equal(parts[1], 333, "T25 FAIL: 第2份=333");
    assert.equal(parts[2], 334, "T25 FAIL: 第3份=334(尾差补回)");
    assert.equal(
      parts.reduce((a, b) => a + b, 0),
      1000,
      "T25 FAIL: 三份之和必须等于1000"
    );
  }

  // 不等权重分摊
  {
    const parts = allocateFen(1000, [3, 2, 1]); // 500, 333.33, 166.67
    const sum = parts.reduce((a, b) => a + b, 0);
    assert.equal(sum, 1000, "T26 FAIL: 不等权重尾差之和=1000");
    assert.ok(parts.every(Number.isInteger), "T26 FAIL: 各份必须是整数分");
  }

  // 权重全零 → 均分
  {
    const parts = allocateFen(10, [0, 0, 0]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 10, "T27 FAIL: 全零权重均分之和=10");
  }

  // totalFen 非整数 → 抛错
  assert.throws(() => allocateFen(1000.5, [1, 1]), /整数/, "T28 FAIL: totalFen 非整数应抛错");

  // 单项
  {
    const parts = allocateFen(100, [1]);
    assert.deepEqual(parts, [100], "T29 FAIL: 单项直接返回总额");
  }

  // 空权重 → 空数组
  {
    const parts = allocateFen(100, []);
    assert.deepEqual(parts, [], "T30 FAIL: 空权重返回空数组");
  }

  console.log("money: yuanToFen / fenToYuan / roundHalfUp / roundBankers / allocateFen 尾差调整 ✓");
})();
