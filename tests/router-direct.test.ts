import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildMessagesUrl,
  buildRouterMessages,
  matchTrivialMessage,
  parseRouterResponse,
  pickAgentModel
} from "../lib/agent/router.ts";

function makeTextPayload(text: string) {
  return { content: [{ type: "text", text }] };
}

function main() {
  // ── AC1: parseRouterResponse (JSON 文本形态) ──

  // 合法 JSON,纯净输出
  const plainJson = makeTextPayload(JSON.stringify({
    intent: "tool_task",
    needs_rag: false,
    rag_queries: ["q1"],
    main_model_tier: "subagent",
    reasoning: "工资计算任务",
  }));
  const valid = parseRouterResponse(plainJson);
  assert.ok(valid, "AC1 FAIL: 合法 JSON 文本应解析成功");
  assert.equal(valid!.intent, "tool_task");
  assert.equal(valid!.mainModelTier, "subagent");
  assert.equal(valid!.reasoning, "工资计算任务");

  // 带 ```json 围栏
  const fencedJson = makeTextPayload(
    "```json\n" + JSON.stringify({
      intent: "greeting",
      direct_answer: "你好!",
      skills_to_enable: [],
      needs_rag: false,
      main_model_tier: "main",
      reasoning: "问候",
    }) + "\n```"
  );
  const fenced = parseRouterResponse(fencedJson);
  assert.ok(fenced, "AC1 FAIL: 带 ```json 围栏应解析成功");
  assert.equal(fenced!.intent, "greeting");
  assert.equal(fenced!.directAnswer, "你好!");

  // 带普通 ``` 围栏(无 json 标记)
  const plainFenced = makeTextPayload(
    "```\n" + JSON.stringify({
      intent: "trivial_qa",
      direct_answer: "今天是周五",
      skills_to_enable: [],
      needs_rag: false,
      main_model_tier: "subagent",
      reasoning: "简单问答",
    }) + "\n```"
  );
  const pf = parseRouterResponse(plainFenced);
  assert.ok(pf, "AC1 FAIL: 带普通 ``` 围栏应解析成功");
  assert.equal(pf!.intent, "trivial_qa");

  // 前后夹了叙述文字
  const surroundedJson = makeTextPayload(
    "好的,路由决策如下:\n" + JSON.stringify({
      intent: "rag_qa",
      skills_to_enable: [],
      needs_rag: true,
      rag_queries: ["增值税专票报销规定"],
      main_model_tier: "main",
      reasoning: "需查知识库",
    }) + "\n以上是我的分析。"
  );
  const surrounded = parseRouterResponse(surroundedJson);
  assert.ok(surrounded, "AC1 FAIL: 前后夹了叙述文字应能容错抽取 JSON");
  assert.equal(surrounded!.intent, "rag_qa");
  assert.equal(surrounded!.needsRag, true);

  // 非法/截断 JSON → null
  assert.equal(parseRouterResponse(makeTextPayload('{"intent": "tool_task", "ski')), null, "AC1 FAIL: 截断 JSON 应返回 null");
  assert.equal(parseRouterResponse(makeTextPayload("这里没有 JSON")), null, "AC1 FAIL: 无 JSON 应返回 null");
  assert.equal(
    parseRouterResponse(makeTextPayload(JSON.stringify({ intent: "bogus", skills_to_enable: [], needs_rag: false, main_model_tier: "main", reasoning: "" }))),
    null,
    "AC1 FAIL: 非法 intent 应返回 null"
  );
  // 无 text 块
  assert.equal(parseRouterResponse({ content: [{ type: "image", source: {} }] }), null, "AC1 FAIL: 无 text 块应返回 null");
  assert.equal(parseRouterResponse(null), null);
  assert.equal(parseRouterResponse("text"), null);
  assert.equal(parseRouterResponse({ content: [] }), null, "AC1 FAIL: 空 content 应返回 null");

  // ── AC2: buildRouterMessages ──
  const history = [
    { role: "assistant" as const, content: "我是小财" },
    { role: "user" as const, content: "帮我算 5 月工资" },
    { role: "assistant" as const, content: "已算好,实发合计 ¥4.7 万" },
  ];
  const msgs = buildRouterMessages(history, "那 3 月的呢?");
  assert.equal(msgs[0].role, "user", "AC2 FAIL: 首条必须是 user");
  assert.equal(msgs[msgs.length - 1].role, "user");
  assert.ok(msgs[msgs.length - 1].content.includes("那 3 月的呢?"), "AC2 FAIL: 当前消息必须在末尾");
  assert.ok(msgs.some((m) => m.content.includes("算 5 月工资")), "AC2 FAIL: 历史上下文必须带上");
  for (let i = 1; i < msgs.length; i++) {
    assert.notEqual(msgs[i].role, msgs[i - 1].role, "AC2 FAIL: 角色必须严格交替(连续同角色应合并)");
  }
  const merged = buildRouterMessages(
    [{ role: "user", content: "第一句" }, { role: "user", content: "第二句" }],
    "当前"
  );
  assert.equal(merged.length, 1, "AC2 FAIL: 连续 user(含当前)应合并为一条");
  assert.ok(merged[0].content.includes("第一句") && merged[0].content.includes("第二句") && merged[0].content.includes("当前"));
  const long = buildRouterMessages(
    [{ role: "user", content: "问题" }, { role: "assistant", content: "长".repeat(600) }],
    "短"
  );
  assert.equal(long.length, 3);
  assert.ok(long[1].content.length <= 501 && long[1].content.endsWith("…"), "AC2 FAIL: 超长历史应截断");
  assert.equal(buildRouterMessages([], "只有当前").length, 1);
  // 末尾的 current 本体去重,但更早的同文本追问保留
  const dedup = buildRouterMessages(
    [
      { role: "user", content: "再算一遍" },
      { role: "assistant", content: "好的,结果同上" },
      { role: "user", content: "再算一遍" },
    ],
    "再算一遍"
  );
  assert.equal(dedup.filter((m) => m.content.includes("再算一遍")).length, 2, "AC2 FAIL: 仅去掉末尾的 current 本体,历史同文本追问应保留");
  assert.equal(dedup[dedup.length - 1].role, "user");

  // buildMessagesUrl: 网关可能带或不带 /v1
  assert.equal(buildMessagesUrl("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(buildMessagesUrl("https://gw.example.com/v1/"), "https://gw.example.com/v1/messages");

  // ── AC3: pickAgentModel(按 intent 难度选模型:复杂任务 → 推理模型,普通任务 → 主模型) ──
  assert.equal(pickAgentModel({ intent: "complex_workflow" }, { subagentModel: "deepseek-v4-pro" }), "deepseek-v4-pro", "AC3 FAIL: 复杂任务应升到推理模型");
  assert.equal(pickAgentModel({ intent: "tool_task" }, { subagentModel: "deepseek-v4-pro" }), undefined, "AC3 FAIL: 普通工具任务不应 override(用默认主模型)");
  assert.equal(pickAgentModel({ intent: "rag_qa" }, { subagentModel: "deepseek-v4-pro" }), undefined, "AC3 FAIL: RAG 问答不应 override");
  assert.equal(pickAgentModel({ intent: "complex_workflow" }, {}), undefined, "AC3 FAIL: 未配推理模型不应 override");
  assert.equal(pickAgentModel({ intent: "complex_workflow" }, { subagentModel: "  " }), undefined);

  // ── AC5: matchTrivialMessage ──

  // 必须命中的寒暄
  const hitCases: Array<[string, string]> = [
    ["你好", "greeting"],
    ["你好!", "greeting"],
    ["您好啊", "greeting"],
    ["在吗?", "greeting"],
    ["hi", "greeting"],
    ["Hello~", "greeting"],
    ["谢谢", "thanks"],
    ["谢谢啦", "thanks"],
    ["thanks", "thanks"],
    ["再见", "farewell"],
    ["bye", "farewell"],
  ];
  for (const [msg, expectedCategory] of hitCases) {
    const r = matchTrivialMessage(msg);
    assert.ok(r !== null, `AC5 FAIL: "${msg}" 应命中,返回了 null`);
    assert.equal(r!.intent, "greeting", `AC5 FAIL: "${msg}" intent 应为 greeting`);
    assert.ok(r!.directAnswer && r!.directAnswer.length > 0, `AC5 FAIL: "${msg}" directAnswer 应非空`);
    assert.equal(r!.needsRag, false, `AC5 FAIL: "${msg}" needsRag 应为 false`);
    assert.ok(r!.reasoning.includes(expectedCategory), `AC5 FAIL: "${msg}" reasoning 应包含 ${expectedCategory}`);
  }

  // 话术对应类别
  const g = matchTrivialMessage("你好")!;
  assert.equal(g.directAnswer, "你好,有什么财务上的事都可以交给我。", "AC5 FAIL: greeting 话术不对");
  const t = matchTrivialMessage("谢谢")!;
  assert.equal(t.directAnswer, "不客气,还有需要随时说。", "AC5 FAIL: thanks 话术不对");
  const f = matchTrivialMessage("再见")!;
  assert.equal(f.directAnswer, "好的,有需要再找我。", "AC5 FAIL: farewell 话术不对");

  // 必须返回 null 的情况
  const missCases: string[] = [
    // 确认类
    "确认", "好的", "可以", "嗯", "收到", "ok",
    // 带寒暄前缀的真任务
    "你好,帮我算一下这个月的工资",
    "你好 我想核对一批报销单",
    // 普通任务
    "帮我核对报销",
    "怎么报销",
    // 边界
    "",
    "2",
    "这是一条超过十二个字的很长的消息",
  ];
  for (const msg of missCases) {
    const r = matchTrivialMessage(msg);
    assert.equal(r, null, `AC5 FAIL: "${msg}" 应返回 null,但得到了非 null`);
  }

  // ── AC4: router 使用 JSON 文本输出,不再使用 tool_choice ──
  const routerSource = fs.readFileSync(path.join(import.meta.dirname, "../lib/agent/router.ts"), "utf-8");
  assert.ok(!routerSource.includes("你好|谢谢"), "AC4 FAIL: 文本 greeting 正则兜底应已删除");
  assert.ok(!routerSource.includes("sdk.query"), "AC4 FAIL: router 不应再走 Agent SDK 进程");
  assert.ok(!routerSource.includes("tool_choice"), "AC4 FAIL: router 不应再使用 tool_choice");
  assert.ok(!routerSource.includes("ROUTE_TOOL"), "AC4 FAIL: ROUTE_TOOL 常量应已删除");
  assert.ok(routerSource.includes("JSON.parse"), "AC4 FAIL: 应解析 JSON 文本输出");

  // ── AC6: 长期约定/偏好必须归 tool_task(走 main),不被 trivial_qa 直答短路 ──
  // 路由分类由 LLM 完成,不可确定性单测;此处守住分类提示词里这条规则不被悄悄移除——
  // 缺它则「以后报表都要带环比」这类会被判 trivial_qa→cheap 直答,主 Agent 不跑、
  // remember_convention 永不触发,记忆永远写不进(参见 route.ts 的 cheap 短路)。
  assert.ok(
    routerSource.includes("tool_task") && routerSource.includes("长期遵守的规矩"),
    "AC6 FAIL: 路由提示词应要求把「长期遵守的规矩/偏好」归 tool_task"
  );
  assert.ok(
    routerSource.includes("记不进记忆"),
    "AC6 FAIL: 路由提示词应说明误判 trivial_qa 会导致记不进记忆"
  );

  console.log("router-direct: all 6 checks passed ✓");
}

main();
