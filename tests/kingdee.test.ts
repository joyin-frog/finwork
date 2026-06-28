import assert from "node:assert/strict";
import { getDb } from "../lib/db/sqlite.ts";
import { loadChartOfAccounts, saveChartOfAccounts, EXAMPLE_CHART_OF_ACCOUNTS } from "../lib/db/finance-store.ts";
import { createKingdeeTools } from "../lib/agent/mcp-tools/kingdee-tools.ts";

// #1 金蝶科目表数据驱动:不再写死 MOCK,改读公司导入的真表(未导入回落示例并提示)。
export const kingdeeTestPromise = (async () => {
  getDb().prepare("DELETE FROM app_settings WHERE key = 'kingdee_chart_of_accounts'").run();

  // ── T1: 未导入 → 回落示例表 + isExample ──
  const def = loadChartOfAccounts();
  assert.equal(def.isExample, true, "T1 FAIL: 未导入应回落示例表");
  assert.equal(def.accounts.length, EXAMPLE_CHART_OF_ACCOUNTS.length, "T1 FAIL: 默认=示例表");

  // ── T2: 导入 + 清洗(去空 code、去重)──
  const n = saveChartOfAccounts([
    { code: "1001001", name: "现金-人民币", type: "资产" },
    { code: "660201", name: "差旅费-市内", type: "费用", balance: 1234 },
    { code: "  ", name: "空码应丢", type: "x" },
    { code: "1001001", name: "重复码应丢", type: "资产" },
  ]);
  assert.equal(n, 2, "T2 FAIL: 清洗后应入库 2 条(去空码 + 去重)");
  const loaded = loadChartOfAccounts();
  assert.equal(loaded.isExample, false, "T2 FAIL: 导入后非示例");
  assert.deepEqual(loaded.accounts.map((a) => a.code).sort(), ["1001001", "660201"], "T2 FAIL: 内容不对");

  // ── T3: 校验对照导入的真表——真科目码通过(原本会被拒),未知码仍拒 ──
  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (name: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => {
      handlers.set(name, h);
      return { name };
    },
  };
  createKingdeeTools(mockSdk);
  const validate = handlers.get("validate_kingdee_voucher")!;
  const mk = (debit: string) => ({
    voucherJson: JSON.stringify({
      entries: [{ debitAccount: debit, debitAmount: 100, creditAccount: "660201", creditAmount: 100 }],
      totalDebit: 100, totalCredit: 100, company: "测试",
    }),
  });
  const ok = (await validate(mk("1001001"))) as { structuredContent: { valid: boolean } };
  assert.equal(ok.structuredContent.valid, true, "T3 FAIL: 导入的真科目码应通过校验");
  const bad = (await validate(mk("9999"))) as { structuredContent: { valid: boolean; errors: string[] } };
  assert.equal(bad.structuredContent.valid, false, "T3 FAIL: 未知科目码仍应拒");
  assert.ok(bad.structuredContent.errors.some((e) => e.includes("9999")), "T3 FAIL: 错误应指出 9999");

  // ── T4: import_kingdee_accounts 工具落库并覆盖 ──
  const importH = handlers.get("import_kingdee_accounts")!;
  const imp = (await importH({ accounts: [{ code: "2001", name: "短期借款", type: "负债" }] })) as {
    structuredContent: { imported: number };
  };
  assert.equal(imp.structuredContent.imported, 1, "T4 FAIL: import 工具应入库 1 条");
  const after = loadChartOfAccounts();
  assert.equal(after.accounts.length, 1, "T4 FAIL: import 应覆盖为新表");
  assert.equal(after.accounts[0].code, "2001", "T4 FAIL: 新表内容不对");

  // 清理:别把自定义科目表泄漏给后续测试(smoke 依赖默认示例表)
  getDb().prepare("DELETE FROM app_settings WHERE key = 'kingdee_chart_of_accounts'").run();

  console.log("kingdee: 科目表数据驱动(示例兜底 / 导入清洗 / 校验对照真表 / import 工具)✓");
})();
