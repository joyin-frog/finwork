import assert from "node:assert/strict";
import {
  reduceChunk,
  reduceAgentEvent,
  mergeFinalMessages,
  overlayMessages,
  activeAssistantContent,
  type StreamTurn
} from "../app/shared/chat-stream.tsx";
import { humanizeAgentError } from "../lib/agent/agent-error.ts";
import type { Message } from "../app/chat/chat-types.ts";

function baseTurn(overrides: Partial<StreamTurn> = {}): StreamTurn {
  return {
    key: "c:1",
    conversationId: 1,
    status: "streaming",
    userMessage: { role: "user", content: "问一下" },
    baseMessages: [{ role: "assistant", content: "历史回答" }],
    streamedContent: "",
    timeline: [],
    startedAt: 1000,
    processedEndedAt: null,
    ...overrides
  };
}

export const chatStreamStoreTestPromise = (async () => {
  // ── 跨页流式 store 的纯 reducer:与原 chat-page 内联回调行为一致 ──

  // reduceChunk:首个 chunk 记 processedEndedAt;文本事件合并而非堆叠;正文累加
  let turn = baseTurn();
  turn = reduceChunk(turn, "你好", 2000);
  assert.equal(turn.processedEndedAt, 2000, "AC1 FAIL: 首个 chunk 应记录 processedEndedAt");
  assert.equal(turn.streamedContent, "你好", "AC1 FAIL: 正文应累加");
  assert.equal(turn.timeline.length, 1, "AC1 FAIL: 应新增一个 text 事件");

  turn = reduceChunk(turn, "世界", 2500);
  assert.equal(turn.processedEndedAt, 2000, "AC1 FAIL: 后续 chunk 不应改写 processedEndedAt");
  assert.equal(turn.streamedContent, "你好世界", "AC1 FAIL: 正文继续累加");
  assert.equal(turn.timeline.length, 1, "AC1 FAIL: 连续文本应合并进同一 text 事件");
  assert.equal(
    (turn.timeline[0].event as { type: "text"; content: string }).content,
    "你好世界",
    "AC1 FAIL: 合并后的文本内容应拼接"
  );

  // reduceAgentEvent:tool_result 重置计时;隐藏事件(系统噪声)被丢弃
  turn = reduceAgentEvent(turn, { type: "tool_use", name: "run_python" }, 3000);
  assert.equal(turn.timeline.length, 2, "AC2 FAIL: tool_use 应入时间线");
  assert.equal(turn.processedEndedAt, 2000, "AC2 FAIL: tool_use 不重置计时");

  turn = reduceAgentEvent(turn, { type: "tool_result", name: "run_python", content: "ok" }, 3500);
  assert.equal(turn.processedEndedAt, null, "AC2 FAIL: tool_result 应重置 processedEndedAt");
  assert.equal(turn.timeline.length, 3, "AC2 FAIL: tool_result 应入时间线");

  const beforeHidden = turn.timeline.length;
  turn = reduceAgentEvent(turn, { type: "system", subtype: "thinking_tokens", message: "noise" }, 3600);
  assert.equal(turn.timeline.length, beforeHidden, "AC2 FAIL: thinking_tokens 等系统噪声不应入时间线");

  // mergeFinalMessages:优先服务端权威消息,但末条助手保留本地已流式正文
  const finalConversation = {
    id: 1,
    title: "T",
    messages: [
      { role: "user", content: "问一下" } as Message,
      { role: "assistant", content: "服务端落库正文(可能与流式略不同)" } as Message
    ]
  };
  const doneTurn = baseTurn({ status: "done", streamedContent: "你好世界(流式)", finalConversation });
  const merged = mergeFinalMessages(doneTurn);
  assert.equal(merged.length, 2, "AC4 FAIL: 应采用服务端消息列表");
  assert.equal(merged[1].content, "你好世界(流式)", "AC4 FAIL: 末条助手应保留本地流式正文");

  // 无服务端消息时回退:base + user + assistant(流式或占位)
  const fallback = mergeFinalMessages(baseTurn({ status: "done", streamedContent: "", finalConversation: null }));
  assert.equal(fallback.length, 3, "AC4 FAIL: 回退应为 base + user + assistant");
  assert.equal(fallback[2].content, "（无内容）", "AC4 FAIL: 空流式应回退占位文案");

  // activeAssistantContent / overlayMessages:流式 / 终止 / 失败 三态
  assert.equal(activeAssistantContent(baseTurn({ streamedContent: "" })), "...", "AC5 FAIL: 空流式显示占位");
  assert.equal(activeAssistantContent(baseTurn({ streamedContent: "进行中" })), "进行中", "AC5 FAIL: 流式显示已到正文");
  assert.equal(
    activeAssistantContent(baseTurn({ status: "stopped", streamedContent: "半句" })),
    "半句\n\n已停止",
    "AC5 FAIL: 终止应保留已流式内容并标注"
  );
  // errorMessage 已在 store catch 里经 humanizeAgentError 人话化,这里直接原样展示(不再加"Agent 调用失败"前缀)。
  assert.equal(
    activeAssistantContent(baseTurn({ status: "error", errorMessage: "API Key 鉴权没通过。请到 设置 → 模型 检查 API Key 是否填对、有没有过期。" })),
    "API Key 鉴权没通过。请到 设置 → 模型 检查 API Key 是否填对、有没有过期。",
    "AC5 FAIL: 失败应直接展示已人话化的错误说明"
  );
  const overlay = overlayMessages(baseTurn({ status: "stopped", streamedContent: "半句" }));
  assert.equal(overlay.length, 3, "AC5 FAIL: overlay = base + user + assistant");
  assert.equal(overlay[2].content, "半句\n\n已停止", "AC5 FAIL: overlay 末条为定格后的助手正文");

  // ── AC6: humanizeAgentError 把 raw 错误映射成人话 + 恢复动作 ──
  assert.equal(humanizeAgentError("Error: 401 Unauthorized").action, "config", "AC6 FAIL: 401 应归为配置类");
  assert.equal(humanizeAgentError("invalid api key").action, "config", "AC6 FAIL: 无效 key 应归为配置类");
  assert.equal(humanizeAgentError("model not found: gpt-x").action, "config", "AC6 FAIL: 模型问题应归为配置类");
  assert.equal(humanizeAgentError("fetch failed: ECONNREFUSED").action, "retry", "AC6 FAIL: 网络问题应归为重试类");
  assert.equal(humanizeAgentError("request timed out").action, "retry", "AC6 FAIL: 超时应归为重试类");
  assert.equal(humanizeAgentError("429 rate limit").action, "retry", "AC6 FAIL: 限流应归为重试类");
  assert.equal(humanizeAgentError("某种没见过的错误").action, "retry", "AC6 FAIL: 未知错误兜底为重试类");
  assert.ok(!humanizeAgentError("401").message.toLowerCase().includes("401"), "AC6 FAIL: 人话化文案不应暴露 raw 状态码");
  assert.equal(humanizeAgentError("Claude Code returned an error result: Reached maximum number of turns (30)").action, "continue", "AC6 FAIL: 步数超限应归为继续类");
  assert.equal(humanizeAgentError("Claude Code returned an error result: API Error: unexpected EOF").action, "retry", "AC6 FAIL: EOF/连接断开应归为重试类");
  assert.ok(humanizeAgentError("API Error: unexpected EOF").message.includes("连接"), "AC6 FAIL: EOF 应命中「连接中断」具体文案,而非通用兜底");

  console.log("chat-stream-store: all 32 checks passed ✓");
})();
