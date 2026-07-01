import assert from "node:assert/strict";
import { parseChineseAmount, reconcileAmount } from "../lib/domain/voucher-reconcile.ts";

// 金额勾稽校验:大写解析 + 明细Σ/合计/大写 三来源交叉验证。
// 单据自带冗余,用数学矛盾暴露问题(废笔/漏读),AI 不擅自判定,不平即标⚠️人工。
export const voucherReconcileTestPromise = (async () => {
  // ── parseChineseAmount:中文大写 → 整数分 ──────────────────────────────
  assert.equal(parseChineseAmount("叁仟柒佰元整"), 370000, "P1 FAIL: 叁仟柒佰元整 → 370000分(3700元)");
  assert.equal(parseChineseAmount("壹拾叁万柒仟柒佰元整"), 13770000, "P2 FAIL: 壹拾叁万柒仟柒佰元整 → 13770000分");
  assert.equal(parseChineseAmount("壹佰元零伍分"), 10005, "P3 FAIL: 壹佰元零伍分 → 10005分(100.05元)");
  assert.equal(parseChineseAmount("贰拾叁元贰角叁分"), 2323, "P4 FAIL: 贰拾叁元贰角叁分 → 2323分(23.23元)");
  // 废笔/非法字符 → 无法可靠解析 → null(交给勾稽+人工,不猜)
  assert.equal(parseChineseAmount("叁仟X柒佰"), null, "P5 FAIL: 含非法字符应返回 null");
  assert.equal(parseChineseAmount(""), null, "P6 FAIL: 空串应返回 null");
  assert.equal(parseChineseAmount("   "), null, "P7 FAIL: 纯空白应返回 null");

  // ── reconcileAmount:三来源一致 → 高置信度自动通过 ─────────────────────
  // 图4 真值:住宿1377 + 餐饮2323 = 合计3700 = 大写叁仟柒佰
  const ok = reconcileAmount({ lineItemsFen: [137700, 232300], totalFen: 370000, capitalFen: 370000 });
  assert.equal(ok.ok, true, "R1 FAIL: 三来源一致应通过");
  assert.equal(ok.ok && ok.confidence, "high", "R1 FAIL: 应为高置信度");
  assert.equal(ok.ok && ok.valueFen, 370000, "R1 FAIL: 勾稽值应为 370000分");

  // ── 大写与合计不符(废笔读进大写) → 标⚠️,精确指出大写对不上 ───────────
  const bad = reconcileAmount({ lineItemsFen: [137700, 232300], totalFen: 370000, capitalFen: 13770000 });
  assert.equal(bad.ok, false, "R2 FAIL: 大写不符应不通过");
  assert.equal(!bad.ok && bad.reason, "mismatch", "R2 FAIL: reason 应为 mismatch");
  assert.ok(!bad.ok && bad.reason === "mismatch" && bad.mismatch.includes("大写"), "R2 FAIL: 应精确指出「大写」对不上");
  assert.ok(
    !bad.ok && bad.reason === "mismatch" && bad.candidates.length === 3,
    "R2 FAIL: 应列出全部 3 个候选来源供人工比对"
  );

  // ── 仅一处金额线索(无从勾稽) → 一律⚠️人工,不自动通过 ─────────────────
  const single = reconcileAmount({ totalFen: 370000 });
  assert.equal(single.ok, false, "R3 FAIL: 单来源不能自动通过");
  assert.equal(!single.ok && single.reason, "no_cross_check", "R3 FAIL: reason 应为 no_cross_check");

  // ── 明细Σ 与合计对不上(漏读一行) → mismatch 指向明细/合计 ─────────────
  const detailBad = reconcileAmount({ lineItemsFen: [137700], totalFen: 370000, capitalFen: 370000 });
  assert.equal(detailBad.ok, false, "R4 FAIL: 明细漏读应不通过");
  assert.equal(!detailBad.ok && detailBad.reason, "mismatch", "R4 FAIL: reason 应为 mismatch");
  assert.ok(!detailBad.ok && detailBad.reason === "mismatch" && bad.mismatch.length > 0, "R4 FAIL: 应指出对不上处");

  // ── 金额为 0 / 负数 → 报错,不生成凭证行 ───────────────────────────────
  assert.throws(() => reconcileAmount({ totalFen: 0, capitalFen: 0 }), /金额/, "R5 FAIL: 0 金额应抛错");
  assert.throws(() => reconcileAmount({ totalFen: -100, capitalFen: -100 }), /金额/, "R6 FAIL: 负金额应抛错");

  console.log("voucher-reconcile: 大写解析 / 三来源勾稽 / 单来源拦截 / 废笔靠矛盾暴露 / 0负报错 ✓");
})();
