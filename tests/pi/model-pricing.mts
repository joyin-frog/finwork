import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL_LIMITS,
  parseModelPricing,
  resolveModelMetadata,
} from "../../lib/agent/pi/model-catalog.ts";

// ── P-1 未声明费率：成本不可知，但上限仍要有可用默认值 ──
{
  const meta = resolveModelMetadata("some-gateway-model", undefined);
  assert.equal(meta.pricingKnown, false, "P-1 FAIL: 未声明应为 pricingKnown=false");
  assert.deepEqual(meta.limits, DEFAULT_MODEL_LIMITS, "P-1 FAIL: 应回落默认上限");
}

// ── P-2 声明完整费率：按用户声明生效，单位是 USD/百万 token（与 pi-ai 一致）──
{
  const meta = resolveModelMetadata("m1", {
    m1: { rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  });
  assert.equal(meta.pricingKnown, true, "P-2 FAIL: 完整声明应为已知");
  assert.deepEqual(
    meta.cost,
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "P-2 FAIL: 费率应原样传给 pi",
  );
}

// ── P-3 费率缺项必须整体判未知 ──
// 缺项若按 0 计，那一维就静默免费——正是本批要消灭的「未知伪装成零」。
{
  const meta = resolveModelMetadata("m2", { m2: { rates: { input: 3, output: 15 } } });
  assert.equal(meta.pricingKnown, false, "P-3 FAIL: 费率缺 cacheRead/cacheWrite 应判未知");
}

// ── P-4 上限可单独声明（不声明费率也能修 compaction 触发点）──
{
  const meta = resolveModelMetadata("m3", { m3: { limits: { contextWindow: 1_000_000 } } });
  assert.equal(meta.limits.contextWindow, 1_000_000, "P-4 FAIL: contextWindow 应可覆盖");
  assert.equal(meta.limits.maxTokens, DEFAULT_MODEL_LIMITS.maxTokens, "P-4 FAIL: 未声明项回落默认");
  assert.equal(meta.pricingKnown, false, "P-4 FAIL: 只声明上限不等于知道价格");
}

// ── P-5 非法声明一律忽略，不抛错（手写 settings.json 容易写错）──
{
  for (const bad of [null, 42, "x", [], { m: 1 }, { m: { rates: "free" } }]) {
    assert.doesNotThrow(() => parseModelPricing(bad), `P-5 FAIL: 非法输入不应抛错：${JSON.stringify(bad)}`);
  }
  assert.equal(parseModelPricing({ m: { rates: { input: -1 } } }), undefined, "P-5 FAIL: 负费率应丢弃");
  assert.equal(parseModelPricing({}), undefined, "P-5 FAIL: 空对象应为未声明");
}

// ── P-6 provider 真实注册：pricingKnown 要一路传出来 ──
{
  const { createFinworkModelRuntime } = await import("../../lib/agent/pi/provider.ts");
  const base = {
    apiUrl: "https://example.invalid",
    apiKey: "test-key",
  } as unknown as Parameters<typeof createFinworkModelRuntime>[0];

  const unknown = await createFinworkModelRuntime(base, "unpriced-model");
  assert.equal(unknown.pricingKnown, false, "P-6 FAIL: 未声明模型应报未知");
  assert.equal(unknown.model.contextWindow, DEFAULT_MODEL_LIMITS.contextWindow, "P-6 FAIL: 上限应生效");

  const priced = await createFinworkModelRuntime(
    {
      ...base,
      modelPricing: { "priced-model": { rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } },
    } as unknown as Parameters<typeof createFinworkModelRuntime>[0],
    "priced-model",
  );
  assert.equal(priced.pricingKnown, true, "P-6 FAIL: 已声明模型应报已知");
  assert.equal(priced.model.cost.input, 1, "P-6 FAIL: 费率应注册进 pi 的 Model");
}

// ── P-7 写设置不得吞掉手写的费率声明（白名单遗漏会静默丢数据）──
{
  const dir = mkdtempSync(path.join(tmpdir(), "finwork-pricing-settings-"));
  process.env.FINANCE_AGENT_APP_DATA_DIR = dir;
  process.env.FINANCE_AGENT_SETTINGS_PATH = path.join(dir, "settings.json");
  process.env.FINANCE_AGENT_SECRET_BACKEND = "file";

  const { writeAgentSettings, readAgentSettings } = await import("../../lib/settings/agent-settings.ts");
  await writeAgentSettings({
    modelPricing: { m9: { rates: { input: 5, output: 10, cacheRead: 1, cacheWrite: 2 } } },
  });
  // 再写一次别的字段：模拟用户在设置页改公司名
  await writeAgentSettings({ companyName: "测试公司" });

  const after = await readAgentSettings();
  assert.equal(after.companyName, "测试公司", "P-7 setup FAIL: 公司名应写入");
  assert.equal(
    after.modelPricing?.m9?.rates?.input,
    5,
    "P-7 FAIL: 二次写设置后费率声明被吞掉了",
  );
}

console.log("Pi model pricing ✓ 未知≠零、缺项判未知、上限可覆盖、写设置不吞声明");
