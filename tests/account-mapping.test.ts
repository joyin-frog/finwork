import assert from "node:assert/strict";
import { resolveAccount } from "../lib/domain/account-mapping.ts";
import type { KingdeeAccount } from "../lib/db/finance-store.ts";
import type { MappingEntry } from "../lib/domain/account-mapping.ts";

// 科目映射:对照表命中 → 编码经科目表验证 → 维度类型带出。
// 对照表从零沉淀,编码必须在科目表存在才输出(不存在→清除+⚠️+最近匹配建议),不 LLM 硬猜三级明细。
export const accountMappingTestPromise = (async () => {
  const chart: KingdeeAccount[] = [
    { code: "6602", name: "管理费用", type: "费用" },
    { code: "6602.24", name: "管理费用-劳务费", type: "费用", dimension: "部门" },
    { code: "6602.09", name: "管理费用-租赁费", type: "费用", dimension: "部门" },
    { code: "1002.01", name: "银行存款-工行", type: "资产", dimension: "银行账号" },
  ];
  const mappings: MappingEntry[] = [
    { keyword: "杰强", code: "6602.24", dimensionValue: "综合部" },
    { keyword: "房租", code: "6602.09", dimensionValue: "行政部" },
    { keyword: "杂费", code: "6602.99" }, // 编码不在科目表(测清除+建议)
  ];

  // ── M1: 对照表命中 + 编码存在 → 高置信度,维度类型从科目表带出,维度值从对照表 ──
  const hit = resolveAccount("付杰强劳务费6月", mappings, chart);
  assert.equal(hit.ok, true, "M1 FAIL: 命中且编码存在应通过");
  assert.equal(hit.ok && hit.confidence, "high", "M1 FAIL: 应高置信度");
  assert.equal(hit.ok && hit.code, "6602.24", "M1 FAIL: 编码应为 6602.24");
  assert.equal(hit.ok && hit.name, "管理费用-劳务费", "M1 FAIL: 名称从科目表带出");
  assert.equal(hit.ok && hit.dimensionType, "部门", "M1 FAIL: 维度类型从科目表带出=部门");
  assert.equal(hit.ok && hit.dimensionValue, "综合部", "M1 FAIL: 维度值从对照表=综合部");

  // ── M2: 命中对照表但编码不在科目表 → 清除编码 + ⚠️ + 最近匹配建议 ──
  const stale = resolveAccount("报销杂费一笔", mappings, chart);
  assert.equal(stale.ok, false, "M2 FAIL: 编码不存在不应通过");
  assert.equal(!stale.ok && stale.reason, "code_not_in_chart", "M2 FAIL: reason=code_not_in_chart");
  assert.equal(!stale.ok && stale.reason === "code_not_in_chart" && stale.suggestedCode, "6602", "M2 FAIL: 最近匹配应建议父级 6602");

  // ── M3: 对照表未命中 → no_match(交 LLM 推断/人工,不硬编造) ──
  const miss = resolveAccount("完全没见过的付款", mappings, chart);
  assert.equal(miss.ok, false, "M3 FAIL: 未命中不通过");
  assert.equal(!miss.ok && miss.reason, "no_match", "M3 FAIL: reason=no_match");

  // ── M4: 银行存款类维度=银行账号(验证不同科目带出不同维度) ──
  const bankMap: MappingEntry[] = [{ keyword: "工行", code: "1002.01", dimensionValue: "工行基本户" }];
  const bank = resolveAccount("付款经工行", bankMap, chart);
  assert.equal(bank.ok && bank.dimensionType, "银行账号", "M4 FAIL: 1002.01 维度应为银行账号");

  console.log("account-mapping: 对照表命中/编码验证/维度带出/未命中拦截/失效码建议 ✓");
})();
