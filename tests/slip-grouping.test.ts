import assert from "node:assert/strict";
import { groupSlipFiles } from "../lib/domain/slip-grouping.ts";

// 自动识别单据文件夹结构 → 分组(一组 = 一张凭证的全部材料)。
// 规则:一级子文件夹各成一组;根目录散文件(含多页PDF)各自一组。子文件夹/多页PDF/混用都支持。
export const slipGroupingTestPromise = (async () => {
  const groups = groupSlipFiles([
    // 子文件夹一笔:付款单+2发票+回单 → 一组
    "0601-付杰强/付款单.jpg",
    "0601-付杰强/发票1.jpg",
    "0601-付杰强/发票2.jpg",
    "0601-付杰强/银行回单.pdf",
    // 根目录多页PDF → 自成一组(一个PDF=一笔)
    "水电费回单.pdf",
    // 根目录散图 → 自成一组
    "报销单.jpg",
    // 系统/隐藏文件 → 过滤
    ".DS_Store",
    "0601-付杰强/.DS_Store",
    // 非单据类型 → 过滤
    "备注.txt",
  ]);

  // ── 3 组:付杰强(子文件夹) / 水电费.pdf / 报销单.jpg ──
  assert.equal(groups.length, 3, "G1 FAIL: 应 3 组");

  const payJie = groups.find((g) => g.group === "0601-付杰强");
  assert.ok(payJie, "G2 FAIL: 子文件夹应成一组");
  assert.equal(payJie!.files.length, 4, "G2 FAIL: 组内 4 个单据文件(过滤 .DS_Store)");
  assert.ok(payJie!.files.some((f) => f.includes("付款单")) && payJie!.files.some((f) => f.includes("发票1")), "G2 FAIL: 组内文件齐");

  assert.ok(groups.some((g) => g.group === "水电费回单.pdf" && g.files.length === 1), "G3 FAIL: 多页PDF 自成一组");
  assert.ok(groups.some((g) => g.group === "报销单.jpg" && g.files.length === 1), "G4 FAIL: 散图自成一组");

  // ── 过滤:不含 .DS_Store / .txt ──
  const allFiles = groups.flatMap((g) => g.files);
  assert.ok(!allFiles.some((f) => f.includes(".DS_Store")), "G5 FAIL: 应过滤 .DS_Store");
  assert.ok(!allFiles.some((f) => f.endsWith(".txt")), "G5 FAIL: 应过滤非单据类型");

  // ── 嵌套目录归到一级 ──
  const nested = groupSlipFiles(["A/子/x.jpg", "A/y.pdf"]);
  assert.equal(nested.length, 1, "G6 FAIL: 一级目录 A 下所有(含嵌套)归一组");
  assert.equal(nested[0].group, "A", "G6 FAIL: 组名=一级目录");
  assert.equal(nested[0].files.length, 2, "G6 FAIL: 含嵌套文件");

  // ── 空 / 全过滤 → [] ──
  assert.equal(groupSlipFiles([]).length, 0, "G7 FAIL: 空输入");
  assert.equal(groupSlipFiles([".DS_Store", "a.txt"]).length, 0, "G7 FAIL: 全非单据");

  console.log("slip-grouping: 子文件夹/多页PDF/散图分组 · 过滤 · 嵌套归一级 · 空兜底 ✓");
})();
