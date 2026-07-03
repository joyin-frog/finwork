import assert from "node:assert/strict";
import { accumulateModelUsage } from "../lib/agent/usage-accumulate.ts";

export const usageAccumulateTestPromise = (async () => {
  // ── U1: 空累计器 + 一条 assistant usage → 建键并映射 snake_case → camelCase ──
  {
    const acc = {};
    accumulateModelUsage(acc, "gpt-5.5", {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 400,
    });
    const u = (acc as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>)["gpt-5.5"];
    assert.ok(u, "U1 FAIL: 应建立模型键");
    assert.equal(u.inputTokens, 100, "U1 FAIL: inputTokens");
    assert.equal(u.outputTokens, 20, "U1 FAIL: outputTokens");
    assert.equal(u.cacheCreationInputTokens, 30, "U1 FAIL: cacheCreationInputTokens");
    assert.equal(u.cacheReadInputTokens, 400, "U1 FAIL: cacheReadInputTokens");
  }

  // ── U2: 同模型多条消息 → 各字段累加 ──
  {
    const acc = {};
    accumulateModelUsage(acc, "m", { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 });
    accumulateModelUsage(acc, "m", { input_tokens: 7, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 0 });
    const u = (acc as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>)["m"];
    assert.equal(u.inputTokens, 17, "U2 FAIL: input 累加");
    assert.equal(u.outputTokens, 3, "U2 FAIL: output 累加");
    assert.equal(u.cacheCreationInputTokens, 3, "U2 FAIL: cache_write 累加");
    assert.equal(u.cacheReadInputTokens, 5, "U2 FAIL: cache_read 累加");
  }

  // ── U3: 不同模型分键(主循环 + 子代理模型并存)──
  {
    const acc = {};
    accumulateModelUsage(acc, "main-model", { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    accumulateModelUsage(acc, "sub-model", { input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    assert.deepEqual(Object.keys(acc).sort(), ["main-model", "sub-model"], "U3 FAIL: 应分模型建键");
  }

  // ── U4: null/undefined 字段兜 0(网关可能缺字段);model/usage 缺失时 no-op ──
  {
    const acc = {};
    accumulateModelUsage(acc, "m", { input_tokens: null, output_tokens: undefined } as unknown as { input_tokens?: number });
    const u = (acc as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>)["m"];
    assert.equal(u.inputTokens, 0, "U4 FAIL: null 兜 0");
    assert.equal(u.outputTokens, 0, "U4 FAIL: undefined 兜 0");

    accumulateModelUsage(acc, undefined, { input_tokens: 99 });
    accumulateModelUsage(acc, "no-usage", undefined);
    assert.equal(Object.keys(acc).length, 1, "U4 FAIL: 缺 model 或 usage 应 no-op");
  }

  // ── U5: 中断路径接线(源码契约):adapter 把累计值挂上错误、route 收尾传给 trace ──
  {
    const fs = await import("node:fs/promises");
    const adapterSrc = await fs.readFile(new URL("../lib/agent/claude-adapter.ts", import.meta.url), "utf8");
    assert.ok(adapterSrc.includes("accumulateModelUsage"), "U5 FAIL: adapter 应逐条 assistant 消息累计 usage");
    assert.ok(adapterSrc.includes("__modelUsage"), "U5 FAIL: adapter 应把累计 usage 挂到抛出的错误上");
    const routeSrc = await fs.readFile(new URL("../app/api/agent/query/route.ts", import.meta.url), "utf8");
    assert.ok(routeSrc.includes("__modelUsage"), "U5 FAIL: route 出错收尾应从错误上取累计 usage 写 trace");
  }

  console.log("usage-accumulate: all 5 checks passed ✓");
})();
