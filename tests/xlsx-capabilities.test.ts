/**
 * 单测:2026-08-05 补齐的四项 xlsx 能力(G1 新建 sheet 在 patch-workbook.test.ts)。
 *
 * 三个纯领域函数,守的都是同一条:确定性判定,判不了就说判不了,不猜。
 */
import assert from "node:assert/strict";
import { detectDataIssues } from "../lib/domain/data-quality.ts";
import { checkWorkbookTies, balanceSheetTie } from "../lib/domain/workbook-ties.ts";
import { mergeLabeledTables } from "../lib/domain/table-merge.ts";

const { equal, deepEqual, ok } = assert;

export const xlsxCapabilitiesTestPromise = (async () => {
  // ── G4 异常 / 重复 / 缺失 ──────────────────────────────────────────────
  {
    const rows = [
      { 凭证号: "记-1", 科目: "管理费用", 金额: 100 },
      { 凭证号: "记-1", 科目: "管理费用", 金额: 100 }, // 重复键
      { 凭证号: "记-2", 科目: "", 金额: 120 }, // 科目缺失
      { 凭证号: "记-3", 科目: "差旅费", 金额: 98 },
      { 凭证号: "记-4", 科目: "差旅费", 金额: 105 },
      { 凭证号: "记-5", 科目: "差旅费", 金额: 110 },
      { 凭证号: "记-6", 科目: "差旅费", 金额: 95 },
      { 凭证号: "记-7", 科目: "差旅费", 金额: 102 },
      { 凭证号: "记-8", 科目: "差旅费", 金额: 99 },
      { 凭证号: "记-9", 科目: "差旅费", 金额: 50000 }, // 离群
      { 凭证号: "记-10", 科目: "差旅费", 金额: -30 }, // 负数
    ];
    const issues = detectDataIssues(rows, {
      keyFields: ["凭证号"],
      requiredFields: ["科目"],
      numericFields: ["金额"],
      nonNegativeFields: ["金额"],
    });
    const kinds = issues.map((issue) => issue.kind);
    ok(kinds.includes("duplicate"), `应查出重复键 —— ${JSON.stringify(issues)}`);
    ok(kinds.includes("missing"), "应查出科目缺失");
    ok(kinds.includes("outlier"), "50000 应被判为离群值");
    ok(kinds.includes("negative"), "-30 应被判为负数异常");
    equal(issues.find((i) => i.kind === "duplicate")!.rows.length, 2, "重复应列出两行");
    ok(
      issues.find((i) => i.kind === "outlier")!.rows.includes(9),
      "离群应指向 50000 那一行",
    );

    // 未声明的检查一律不做——不猜。
    equal(detectDataIssues(rows).length, 0, "什么都没声明时不得凭空产出问题");
    // 样本太少时不硬判离群。
    equal(
      detectDataIssues([{ x: 1 }, { x: 999 }], { numericFields: ["x"] }).length,
      0,
      "样本不足 8 条时不得给出离群判定",
    );
  }

  // ── G2 跨表勾稽 ───────────────────────────────────────────────────────
  {
    const values = {
      "资产负债表!C59": 133213633.47,
      "资产负债表!C40": 130986541.44,
      "资产负债表!C58": 2227092.03,
      "利润表!B5": 500,
      "现金流量表!B60": null,
    };
    const results = checkWorkbookTies(values, [
      balanceSheetTie("资产负债表!C59", "资产负债表!C40", "资产负债表!C58"),
      { label: "跨表：期末现金", left: ["现金流量表!B60"], right: ["利润表!B5"] },
      { label: "故意不平", left: ["利润表!B5"], right: ["资产负债表!C58"] },
    ]);
    equal(results[0]!.status, "passed", `资产负债表恒等式应通过 —— ${results[0]!.detail}`);
    equal(results[1]!.status, "unverifiable", "读不到值必须判未验证，不得判失败");
    equal(results[2]!.status, "failed", "真不平必须判失败");
    ok(results[2]!.detail.includes("差"), "失败时要给出差额");

    // 容差:分位舍入不该被判成不平。
    const rounded = checkWorkbookTies(
      { A: 100.004, B: 100 },
      [{ label: "舍入", left: ["A"], right: ["B"] }],
    );
    equal(rounded[0]!.status, "passed", "默认 0.01 容差内应通过");
  }

  // ── G3 多表合并汇总 ───────────────────────────────────────────────────
  {
    const merged = mergeLabeledTables([
      { name: "母公司", rows: [{ label: "营业收入", value: 1000 }, { label: "营业成本", value: 600 }] },
      { name: "子公司", rows: [{ label: "营业收入", value: 400 }, { label: "研发费用", value: 90 }] },
    ]);
    deepEqual(merged.columns, ["科目", "母公司", "子公司", "合计"]);
    equal(merged.rows[0]!.label, "营业收入");
    equal(merged.rows[0]!.total, 1400, "两家都有的科目应相加");
    equal(merged.rows[1]!.label, "营业成本");
    deepEqual(merged.rows[1]!.values, [600, null], "子公司没有该科目应为 null，不是 0");
    equal(merged.rows[1]!.total, 600);
    deepEqual(
      merged.partialLabels.sort(),
      ["研发费用", "营业成本"],
      "只在部分来源出现的科目要单独列出，提示口径不一致",
    );
    deepEqual(merged.totalsRow, [1600, 490], "各来源列合计");

    // 同一来源内同名科目相加(明细账常见)。
    const repeated = mergeLabeledTables([
      { name: "A", rows: [{ label: "差旅费", value: 10 }, { label: "差旅费", value: 5 }] },
    ]);
    equal(repeated.rows[0]!.total, 15, "同来源同名科目应合并相加");
  }

  console.log("xlsx-capabilities: all 3 checks passed ✓");
})();
