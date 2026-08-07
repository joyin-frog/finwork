import assert from "node:assert/strict";
import { findImpossibleShares } from "../lib/domain/business-sense.ts";

export const businessSenseTestPromise = (async () => {
  // ── 真实失败复现:HISTORY-005 交付文档里的两处不可能占比 ──────────────
  // 这两条当时 deterministicScore=1.0 全过,只有 LLM judge 发现。
  const junshi = findImpossibleShares("前5大客户占Q1收入116%，集中度偏高。");
  assert.equal(junshi.length, 1, "H005 FAIL: 应命中「前5大客户占Q1收入116%」");
  assert.equal(junshi[0]!.percent, 116);

  const q4 = findImpossibleShares("Q4单季营业利润占全年利润总额135%，结构性因素所致。");
  assert.equal(q4.length, 1, "H005 FAIL: 应命中「单季利润占全年135%」");
  assert.equal(q4[0]!.percent, 135);

  // ── 合法的超百分比不得误报 ────────────────────────────────────────────
  // 误报比漏报更贵:会把正常增长打成业务失败。
  for (const legal of [
    "研发费用同比增长135%，主要因团队扩张。",
    "营业收入环比上升 220%。",
    "预算完成率 120%，超额达成。",
    "净利润较上年提升 180%。",
    "本期营收增幅 150%。",
  ]) {
    assert.equal(
      findImpossibleShares(legal).length,
      0,
      `误报 FAIL: 变动类百分比不应命中 —— ${legal}`,
    );
  }

  // ── 合法占比 / 边界 ───────────────────────────────────────────────────
  assert.equal(findImpossibleShares("前五大客户占收入比重 98.7%。").length, 0);
  assert.equal(findImpossibleShares("三项费用占营业收入 100%。").length, 0);
  // 四舍五入容差内不报:5 个各自舍入的占比相加可能显示 100.1%
  assert.equal(
    findImpossibleShares("各产品线占比合计 100.3%。").length,
    0,
    "容差 FAIL: 舍入级别的超出属精度不属矛盾",
  );
  assert.equal(
    findImpossibleShares("各产品线占比合计 101%。").length,
    1,
    "容差 FAIL: 超出容差应命中",
  );

  // ── 跨行语境仍应命中 ──────────────────────────────────────────────────
  assert.equal(
    findImpossibleShares("Q4 单季营业利润占\n全年利润总额\n135%").length,
    1,
    "跨行 FAIL: 语境压平后应命中",
  );

  // ── 多处命中与空输入 ──────────────────────────────────────────────────
  const multi = findImpossibleShares("A占比116%；B同比增长300%；C占总额 142%。");
  assert.equal(multi.length, 2, "多处 FAIL: 应命中两处占比、排除一处增长");
  assert.deepEqual(multi.map((hit) => hit.percent), [116, 142]);

  assert.deepEqual(findImpossibleShares(""), []);

  console.log("business-sense: all 6 checks passed ✓");
})();
