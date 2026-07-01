import assert from "node:assert/strict";
import { getDb } from "../lib/db/sqlite.ts";
import { saveChartOfAccounts } from "../lib/db/finance-store.ts";
import { createKingdeeTools } from "../lib/agent/mcp-tools/kingdee-tools.ts";

// 单据→凭证工具层:金额勾稽(元→分/大写降级)、科目映射(对照表+验证)、汇总。薄封装纯函数,此处测工具层衔接。
export const voucherToolsTestPromise = (async () => {
  getDb().prepare("DELETE FROM app_settings WHERE key = 'kingdee_chart_of_accounts'").run();

  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = { tool: (name: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => { handlers.set(name, h); return { name }; } };
  createKingdeeTools(mockSdk);

  const checkAmount = handlers.get("check_voucher_amount")!;
  const mapAccount = handlers.get("map_voucher_account")!;
  const summarize = handlers.get("summarize_vouchers")!;

  // ── V1: 金额勾稽三来源一致(元→分转换 + 大写解析在工具内)──
  const ok = (await checkAmount({
    lineItemsYuan: [1377, 2323], totalYuan: 3700, capitalText: "叁仟柒佰元整",
  })) as { structuredContent: { ok: boolean; confidence?: string; valueFen?: number } };
  assert.equal(ok.structuredContent.ok, true, "V1 FAIL: 1377+2323=3700=叁仟柒佰 应一致");
  assert.equal(ok.structuredContent.valueFen, 370000, "V1 FAIL: 勾稽值 370000 分");

  // ── V2: 大写无法解析 → 排除出勾稽 + note 提示(不崩,用明细+合计)──
  const degraded = (await checkAmount({
    lineItemsYuan: [1377, 2323], totalYuan: 3700, capitalText: "@@糊了@@",
  })) as { structuredContent: { ok: boolean }; content: Array<{ text: string }> };
  assert.equal(degraded.structuredContent.ok, true, "V2 FAIL: 大写糊了仍可用明细+合计勾稽");
  assert.ok(degraded.content[0].text.includes("大写"), "V2 FAIL: 应 note 提示大写未解析");

  // ── V3: 金额不平 → ok=false,指出对不上处 ──
  const bad = (await checkAmount({ lineItemsYuan: [1377], totalYuan: 3700, capitalText: "叁仟柒佰元整" })) as {
    structuredContent: { ok: boolean; reason?: string };
  };
  assert.equal(bad.structuredContent.ok, false, "V3 FAIL: 明细漏读应不平");

  // ── V4: 科目映射(对照表命中 + 科目表验证 + 维度带出)──
  saveChartOfAccounts([{ code: "6602.24", name: "管理费用-劳务费", type: "费用", dimension: "部门" }]);
  const mapped = (await mapAccount({
    text: "付杰强劳务费6月", mappings: [{ keyword: "杰强", code: "6602.24", dimensionValue: "综合部" }],
  })) as { structuredContent: { ok: boolean; code?: string; dimensionType?: string; dimensionValue?: string } };
  assert.equal(mapped.structuredContent.ok, true, "V4 FAIL: 命中且编码存在应通过");
  assert.equal(mapped.structuredContent.code, "6602.24", "V4 FAIL: 编码 6602.24");
  assert.equal(mapped.structuredContent.dimensionType, "部门", "V4 FAIL: 维度类型带出");
  assert.equal(mapped.structuredContent.dimensionValue, "综合部", "V4 FAIL: 维度值");

  // ── V5: 编码不在科目表 → 不通过,不编造 ──
  const stale = (await mapAccount({ text: "付杂费", mappings: [{ keyword: "杂费", code: "9999.99" }] })) as {
    structuredContent: { ok: boolean; reason?: string };
  };
  assert.equal(stale.structuredContent.ok, false, "V5 FAIL: 失效编码不通过");

  // ── V6: 汇总统计 ──
  const sum = (await summarize({
    results: [
      { file: "1.jpg", ocrOk: true, amountOk: true, accountOk: true },
      { file: "2.jpg", ocrOk: true, amountOk: false, amountIssue: "不平", accountOk: true },
      { file: "3.jpg", ocrOk: false },
    ],
  })) as { structuredContent: { total: number; autoPass: number; needConfirm: number; failed: number } };
  assert.equal(sum.structuredContent.total, 3, "V6 FAIL: total=3");
  assert.equal(sum.structuredContent.autoPass, 1, "V6 FAIL: auto=1");
  assert.equal(sum.structuredContent.needConfirm, 1, "V6 FAIL: needConfirm=1");
  assert.equal(sum.structuredContent.failed, 1, "V6 FAIL: failed=1");

  getDb().prepare("DELETE FROM app_settings WHERE key = 'kingdee_chart_of_accounts'").run();
  console.log("voucher-tools: 勾稽(元换算/大写降级/不平) / 映射(验证/维度/失效) / 汇总 ✓");
})();
