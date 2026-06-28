import assert from "node:assert/strict";
import { sanitizeTurnEvents, MAX_EVENTS_PER_TURN, DROP_SYSTEM_SUBTYPES } from "../lib/agent/persist-hygiene";

// 纯函数 sanitizeTurnEvents 的单测;不调用网络/LLM/DB。
export const persistHygieneTestPromise = (async () => {
  const { ok, equal, deepEqual } = assert;

  // T1: thinking_tokens system 事件被丢弃
  const thinkingEvent = { type: "system", subtype: "thinking_tokens", message: "lots of tokens" };
  const r1 = sanitizeTurnEvents([thinkingEvent]);
  equal(r1.length, 0, "T1 FAIL: thinking_tokens 应被丢弃");

  // T2: status system 事件被丢弃
  const statusEvent = { type: "system", subtype: "status", message: "processing" };
  const r2 = sanitizeTurnEvents([statusEvent]);
  equal(r2.length, 0, "T2 FAIL: status 应被丢弃");

  // T3: init system 事件保留
  const initEvent = { type: "system", subtype: "init", message: "start" };
  const r3 = sanitizeTurnEvents([initEvent]);
  equal(r3.length, 1, "T3 FAIL: init 应保留");
  deepEqual(r3[0], initEvent, "T3 FAIL: init 事件内容应不变");

  // T4: turn_duration system 事件保留(前端"已处理 X 时长"依赖它)
  const turnDurationEvent = { type: "system", subtype: "turn_duration", message: "1234" };
  const r4 = sanitizeTurnEvents([turnDurationEvent]);
  equal(r4.length, 1, "T4 FAIL: turn_duration 应保留");

  // T5: compact_boundary system 事件保留
  const compactEvent = { type: "system", subtype: "compact_boundary" };
  const r5 = sanitizeTurnEvents([compactEvent]);
  equal(r5.length, 1, "T5 FAIL: compact_boundary 应保留");

  // T6: tool_use 事件保留
  const toolUseEvent = { type: "tool_use", id: "tu_1", name: "read_file", input: {} };
  const r6 = sanitizeTurnEvents([toolUseEvent]);
  equal(r6.length, 1, "T6 FAIL: tool_use 应保留");

  // T7: tool_result 事件保留
  const toolResultEvent = { type: "tool_result", tool_use_id: "tu_1", content: "ok" };
  const r7 = sanitizeTurnEvents([toolResultEvent]);
  equal(r7.length, 1, "T7 FAIL: tool_result 应保留");

  // T8: text 事件保留
  const textEvent = { type: "text", text: "这是回复内容" };
  const r8 = sanitizeTurnEvents([textEvent]);
  equal(r8.length, 1, "T8 FAIL: text 应保留");

  // T9: ask_user 事件保留
  const askUserEvent = { type: "ask_user", questionId: "q1", question: "请确认" };
  const r9 = sanitizeTurnEvents([askUserEvent]);
  equal(r9.length, 1, "T9 FAIL: ask_user 应保留");

  // T10: 混合事件——噪声被过滤,内容事件保留
  const mixed = [
    { type: "system", subtype: "thinking_tokens", message: "noise" },
    { type: "tool_use", id: "tu_2", name: "search", input: {} },
    { type: "system", subtype: "status", message: "progress" },
    { type: "tool_result", tool_use_id: "tu_2", content: "result" },
    { type: "system", subtype: "turn_duration", message: "567" },
    { type: "text", text: "完成" },
  ];
  const r10 = sanitizeTurnEvents(mixed);
  equal(r10.length, 4, "T10 FAIL: 6 个事件中 2 个噪声应被丢弃,保留 4");
  ok(r10.every((e) => e.type !== "system" || (e.subtype !== "thinking_tokens" && e.subtype !== "status")),
    "T10 FAIL: 过滤后不应有 thinking_tokens/status");

  // T11: 超过 MAX_EVENTS_PER_TURN 时截断到上限
  const flood = Array.from({ length: MAX_EVENTS_PER_TURN + 100 }, (_, i) => ({
    type: "tool_use", id: `tu_${i}`, name: "noop", input: {},
  }));
  const r11 = sanitizeTurnEvents(flood);
  equal(r11.length, MAX_EVENTS_PER_TURN, `T11 FAIL: 超上限应截断到 ${MAX_EVENTS_PER_TURN}`);

  // T12: 正好 MAX_EVENTS_PER_TURN 条时不截断
  const exactly = Array.from({ length: MAX_EVENTS_PER_TURN }, (_, i) => ({
    type: "text", text: `chunk_${i}`,
  }));
  const r12 = sanitizeTurnEvents(exactly);
  equal(r12.length, MAX_EVENTS_PER_TURN, "T12 FAIL: 正好上限时不应截断");

  // T13: 空数组正常返回空数组
  const r13 = sanitizeTurnEvents([]);
  equal(r13.length, 0, "T13 FAIL: 空数组应返回空数组");

  // T14: DROP_SYSTEM_SUBTYPES 包含预期的两个子类型
  ok(DROP_SYSTEM_SUBTYPES.has("thinking_tokens"), "T14 FAIL: DROP_SYSTEM_SUBTYPES 应含 thinking_tokens");
  ok(DROP_SYSTEM_SUBTYPES.has("status"), "T14 FAIL: DROP_SYSTEM_SUBTYPES 应含 status");
  ok(!DROP_SYSTEM_SUBTYPES.has("turn_duration"), "T14 FAIL: DROP_SYSTEM_SUBTYPES 不应含 turn_duration");
  ok(!DROP_SYSTEM_SUBTYPES.has("init"), "T14 FAIL: DROP_SYSTEM_SUBTYPES 不应含 init");

  console.log("persist-hygiene tests passed");
})();
