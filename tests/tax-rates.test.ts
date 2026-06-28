import assert from "node:assert/strict";
import { getDb, setAppSetting } from "../lib/db/sqlite.ts";
import { loadTaxRates } from "../lib/db/finance-store.ts";
import { DEFAULT_TAX_RATES } from "../lib/domain/tax-config.ts";
import { createFinanceTools } from "../lib/agent/mcp-tools/finance-tools.ts";

// #3 增值税/企业所得税法定税率集配置化:从工具枚举写死改为 tax-config 默认 + app_settings 覆盖。
export const taxRatesTestPromise = (async () => {
  getDb().prepare("DELETE FROM app_settings WHERE key = 'tax_rates'").run();

  // ── T1: 默认税率集 ──
  const def = loadTaxRates();
  assert.deepEqual(def.vat, DEFAULT_TAX_RATES.vat, "T1 FAIL: 默认 VAT 集");
  assert.deepEqual(def.cit, DEFAULT_TAX_RATES.cit, "T1 FAIL: 默认 CIT 集");

  // ── T2: app_settings 覆盖生效(政策变更不改代码)──
  setAppSetting("tax_rates", JSON.stringify({ vat: ["0.13", "0.05"], cit: ["0.25"] }));
  const ov = loadTaxRates();
  assert.deepEqual(ov.vat, ["0.13", "0.05"], "T2 FAIL: VAT 覆盖");
  assert.deepEqual(ov.cit, ["0.25"], "T2 FAIL: CIT 覆盖");

  // ── T3: 坏值/缺字段按字段回落默认 ──
  setAppSetting("tax_rates", JSON.stringify({ vat: "坏值" }));
  const fb = loadTaxRates();
  assert.deepEqual(fb.vat, DEFAULT_TAX_RATES.vat, "T3 FAIL: 坏 vat 回落默认");
  assert.deepEqual(fb.cit, DEFAULT_TAX_RATES.cit, "T3 FAIL: 缺 cit 回落默认");

  // ── T4/T5: 工具按配置集校验税率 ──
  getDb().prepare("DELETE FROM app_settings WHERE key = 'tax_rates'").run();
  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (name: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => {
      handlers.set(name, h);
      return { name };
    },
  };
  createFinanceTools(mockSdk, "/tmp");
  const tax = handlers.get("tax_calculator")!;

  // T4: 不在集合的税率 → isError(校验拦在调脚本前)
  const bad = (await tax({ type: "vat", amount: 1000, vatParams: { direction: "from_tax_exclusive", rate: "0.99" } })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(bad.isError, true, "T4 FAIL: 非法税率应 isError");
  assert.ok(bad.content[0].text.includes("不在合法税率集"), "T4 FAIL: 错误应说明非法");

  // T5: 合法税率 → 走脚本算出税额
  const ok = (await tax({ type: "vat", amount: 1000, vatParams: { direction: "from_tax_exclusive", rate: "0.13" } })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.ok(!ok.isError, "T5 FAIL: 合法税率不应 isError");
  assert.ok(ok.content[0].text.includes("130.00"), "T5 FAIL: 1000×13% 应=130.00");

  console.log("tax-rates: 税率集配置化(默认 / 覆盖 / 回落 / 工具按集校验)✓");
})();
