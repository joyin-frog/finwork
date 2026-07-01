import assert from "node:assert/strict";
import { injectSkillHint } from "../lib/agent/skill-hint.ts";
import { resolveModelByTier, normalizeTier } from "../lib/agent/router.ts";

// agent/query 的纯逻辑单测:技能提示注入 + 模型档位解析。覆盖之前漏测的分支。
export const agentQueryHelpersTestPromise = (async () => {
  const msgs = [
    { role: "user" as const, content: "第一条" },
    { role: "assistant" as const, content: "回复" },
    { role: "user" as const, content: "最后一条" },
  ];

  // ── injectSkillHint ────────────────────────────────────────────────
  // 空技能:原样返回(同引用)
  assert.equal(injectSkillHint(msgs, []), msgs, "空技能应原样返回");

  // 注入:只改最后一条 user;含技能名;不动原数组;其他消息不变
  const out = injectSkillHint(msgs, ["pdf", "finance-analysis"]);
  assert.notEqual(out, msgs, "应返回新数组");
  assert.equal(msgs[2].content, "最后一条", "不应原地修改原消息");
  assert.equal(out[0].content, "第一条");
  assert.equal(out[1].content, "回复");
  assert.match(out[2].content, /最后一条/, "应保留原文");
  assert.match(out[2].content, /pdf/, "应含技能名 pdf");
  assert.match(out[2].content, /finance-analysis/, "应含技能名 finance-analysis");

  // 非法名过滤 + 限量到 8
  const many = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
  const out2 = injectSkillHint(msgs, ["../evil", "BadCaps", ...many]);
  assert.ok(!/evil|BadCaps/.test(out2[2].content), "非法名应被过滤");
  const injectedCount = (out2[2].content.match(/skill-\d+/g) ?? []).length;
  assert.equal(injectedCount, 8, "最多注入 8 个技能");

  // 无 user 消息:原样返回
  const onlyAssistant = [{ role: "assistant" as const, content: "x" }];
  assert.equal(injectSkillHint(onlyAssistant, ["pdf"]), onlyAssistant, "无 user 消息应原样返回");

  // ── resolveModelByTier ─────────────────────────────────────────────
  const settings = { routerModel: "haiku-x", subagentModel: "sonnet-x" };
  assert.equal(resolveModelByTier("fast", settings), "haiku-x");
  assert.equal(resolveModelByTier("reasoning", settings), "sonnet-x");
  assert.equal(resolveModelByTier("fast", { routerModel: "", subagentModel: "" }), undefined, "空槽返回 undefined");

  // ── normalizeTier:默认快速,只有显式 reasoning 才推理 ───────────────
  assert.equal(normalizeTier("reasoning"), "reasoning");
  assert.equal(normalizeTier("fast"), "fast");
  assert.equal(normalizeTier(undefined), "fast", "缺省应为 fast");
  assert.equal(normalizeTier("auto"), "fast", "去掉 auto:任何非 reasoning 都落 fast");
  assert.equal(normalizeTier("garbage"), "fast");

  console.log("agent-query-helpers: injectSkillHint + resolveModelByTier + normalizeTier ✓");
})();
