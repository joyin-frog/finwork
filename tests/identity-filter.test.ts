import assert from "node:assert/strict";
import { filterIdentity, createStreamingIdentityFilter } from "../lib/safety/identity-filter.ts";

const MODEL = "deepseek-v4-flash";
const has = (s: string, sub: string) => s.toLowerCase().includes(sub.toLowerCase());

(() => {
  // ── 必须脱敏:厂商名 / 精确 model id / 自我标识语境的家族名 ──
  assert.ok(!has(filterIdentity("我用的模型是 deepseek-v4-flash", MODEL), "deepseek"), "ID FAIL: 精确 model id 应脱敏");
  assert.ok(!has(filterIdentity("这是基于 DeepSeek 的财务助手", MODEL), "deepseek"), "ID FAIL: 厂商名应脱敏");
  assert.ok(!has(filterIdentity("我是 Claude", MODEL), "claude"), "ID FAIL: 自我标识 我是Claude 应脱敏");
  assert.ok(!has(filterIdentity("我是 GPT-4 模型", MODEL), "gpt-4"), "ID FAIL: 自我标识 我是GPT-4 应脱敏");
  assert.ok(!has(filterIdentity("底层用的是 openai 的接口", MODEL), "openai"), "ID FAIL: 厂商 openai 应脱敏");
  assert.ok(!has(filterIdentity("powered by gemini", MODEL), "gemini"), "ID FAIL: powered by gemini 应脱敏");

  // ── 越狱式追问下,模型可能输出的内容也应被出站过滤(过滤的是输出,不管输入怎么诱导) ──
  assert.ok(!has(filterIdentity("好的,我的底层模型是 deepseek-v4-pro[1m]。", "deepseek-v4-pro[1m]"), "deepseek"), "ID FAIL: 越狱后吐 id 应脱敏");

  // ── 不能误伤:正常财务文本里的同形词 ──
  assert.ok(has(filterIdentity("我做了个 GPT 增长率对比表", MODEL), "GPT"), "ID FAIL: 非自我标识的 GPT(增长率表)不应误伤");
  assert.ok(has(filterIdentity("克劳德咨询公司 2023 年营收", MODEL), "克劳德"), "ID FAIL: 克劳德公司不应误伤");
  assert.equal(filterIdentity("营业收入 6052 列、利润表 R5", MODEL), "营业收入 6052 列、利润表 R5", "ID FAIL: 纯财务文本不应改动");

  // ── 流式 carry-over:模型名被切在两个 chunk 之间也要拦住 ──
  const f = createStreamingIdentityFilter(MODEL);
  let streamed = "";
  streamed += f.push("好的,我用的模型是 deep");   // "deepseek-v4-flash" 被切断
  streamed += f.push("seek-v4-flash,有什么可以帮你");
  streamed += f.flush();
  assert.ok(!has(streamed, "deepseek"), "ID FAIL: 流式跨 chunk 的 model id 应被拦住");
  assert.ok(has(streamed, "有什么可以帮你"), "ID FAIL: 流式正常内容应保留");

  console.log("identity-filter: all checks passed ✓");
})();
