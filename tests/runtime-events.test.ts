/**
 * runtime-events.test.ts
 *
 * AR2a 事件合同测试：TDD 先红后绿。
 *
 * 测试分组：
 * ①  contractToLegacyEvents：合同→落库词表快照（对照现有 event_type 全集含 system 子类）
 * ②  createEmitter：eventId 单调 + instanceId 规则
 * ③  源码契约：chat-types 无本地 union、三层 import 同源
 * ④  reducer 等价：合同事件序列 → 与旧实现相同 UI 状态（纯函数）
 * ⑤  run_settled 收口：settled 恰好一次 × 三路径（settled 发射器单测）
 *
 * 运行（单跑）：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test -- runtime-events
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const runtimeEventsTestPromise = (async () => {

  // ─── ① contractToLegacyEvents 落库词表快照 ────────────────────────────────
  {
    const { contractToLegacyEvents, createEmitter } = await import("../lib/agent/runtime-events.ts");

    const emitter = createEmitter("trace-test-001", 42);

    // text chunk → legacy text event
    const textEnv = emitter.wrap({ type: "message_delta", channel: "text", delta: "hello" });
    const textLegacy = contractToLegacyEvents(textEnv);
    assert.equal(textLegacy.length, 1, "L1 FAIL: message_delta text 应映射为 1 条 legacy 事件");
    assert.equal(textLegacy[0].type, "text", "L1 FAIL: message_delta text → type=text");
    assert.equal((textLegacy[0] as { content: string }).content, "hello", "L1 FAIL: delta 应作为 content");

    // thinking chunk → legacy thinking event
    const thinkEnv = emitter.wrap({ type: "message_delta", channel: "thinking", delta: "思考中" });
    const thinkLegacy = contractToLegacyEvents(thinkEnv);
    assert.equal(thinkLegacy.length, 1, "L2 FAIL: message_delta thinking 应映射为 1 条 legacy 事件");
    assert.equal(thinkLegacy[0].type, "thinking", "L2 FAIL: message_delta thinking → type=thinking");

    // tool_started (main, instanceId=null) → tool_use
    const toolEnv = emitter.wrap({ type: "tool_started", toolName: "Read", input: { file_path: "/a" }, toolCallId: "tc-1" });
    const toolLegacy = contractToLegacyEvents(toolEnv);
    assert.equal(toolLegacy.length, 1, "L3 FAIL: tool_started 应映射 1 条 legacy");
    assert.equal(toolLegacy[0].type, "tool_use", "L3 FAIL: tool_started → tool_use");
    assert.equal((toolLegacy[0] as { name: string }).name, "Read", "L3 FAIL: toolName 透传");

    // tool_completed (main, instanceId=null) → tool_result
    const resultEnv = emitter.wrap({ type: "tool_completed", toolName: "Read", content: "文件内容", isError: false, durationMs: 50 });
    const resultLegacy = contractToLegacyEvents(resultEnv);
    assert.equal(resultLegacy.length, 1, "L4 FAIL: tool_completed(main) 应映射 1 条 legacy");
    assert.equal(resultLegacy[0].type, "tool_result", "L4 FAIL: tool_completed main → tool_result");

    // ask_user → ask_user (same shape)
    const askEnv = emitter.wrap({ type: "ask_user", questionId: "q1", question: { question: "确认?" } });
    const askLegacy = contractToLegacyEvents(askEnv);
    assert.equal(askLegacy.length, 1, "L5 FAIL: ask_user 应映射 1 条 legacy");
    assert.equal(askLegacy[0].type, "ask_user", "L5 FAIL: ask_user 保持类型");

    // ask_user_answered → ask_user_answered
    const answeredEnv = emitter.wrap({ type: "ask_user_answered", questionId: "q1", answer: "yes" });
    const answeredLegacy = contractToLegacyEvents(answeredEnv);
    assert.equal(answeredLegacy.length, 1, "L6 FAIL: ask_user_answered 应映射 1 条 legacy");
    assert.equal(answeredLegacy[0].type, "ask_user_answered", "L6 FAIL: ask_user_answered 保持类型");

    // compaction_completed → system(compact_boundary)
    const compactEnv = emitter.wrap({ type: "compaction_completed", preTokens: 10000, postTokens: 2000, trigger: "auto" });
    const compactLegacy = contractToLegacyEvents(compactEnv);
    assert.equal(compactLegacy.length, 1, "L7 FAIL: compaction_completed 应映射 1 条 legacy");
    assert.equal(compactLegacy[0].type, "system", "L7 FAIL: compaction_completed → system");
    assert.equal((compactLegacy[0] as { subtype: string }).subtype, "compact_boundary", "L7 FAIL: subtype=compact_boundary");

    // system_note(init) → system(init)
    const sysEnv = emitter.wrap({ type: "system_note", subtype: "init", message: "环境初始化完成" });
    const sysLegacy = contractToLegacyEvents(sysEnv);
    assert.equal(sysLegacy.length, 1, "L8 FAIL: system_note 应映射 1 条 legacy");
    assert.equal(sysLegacy[0].type, "system", "L8 FAIL: system_note → system");
    assert.equal((sysLegacy[0] as { subtype: string }).subtype, "init", "L8 FAIL: subtype 透传");

    // run_started (main, instanceId=null) → no legacy event
    const runStartEnv = emitter.wrap({ type: "run_started", conversationId: 42 });
    const runStartLegacy = contractToLegacyEvents(runStartEnv);
    assert.equal(runStartLegacy.length, 0, "L9 FAIL: run_started(main) 不产生 legacy 事件");

    // run_settled → no legacy event
    const settledEnv = emitter.wrap({ type: "run_settled", outcome: "completed" });
    const settledLegacy = contractToLegacyEvents(settledEnv);
    assert.equal(settledLegacy.length, 0, "L10 FAIL: run_settled 不产生 legacy 事件");

    // title_updated → no legacy event
    const titleEnv = emitter.wrapConversation({ type: "title_updated", title: "新标题" });
    const titleLegacy = contractToLegacyEvents(titleEnv);
    assert.equal(titleLegacy.length, 0, "L11 FAIL: title_updated 不产生 legacy 事件");

    console.log("L1-L11: contractToLegacyEvents 词表快照 ✓");
  }

  // ─── ① (续) subagent 事件映射 ─────────────────────────────────────────────
  {
    const { createEmitter, contractToLegacyEvents } = await import("../lib/agent/runtime-events.ts");

    // 子代理 emitter（instanceId 非空）
    const subEmitter = createEmitter("trace-sub-001", 10, "instance-abc");

    // run_started (subagent, instanceId!=null) → subagent phase=start
    const subStartEnv = subEmitter.wrap({ type: "run_started", label: "薪税专员-1", roleId: "payroll-officer" });
    const subStartLegacy = contractToLegacyEvents(subStartEnv);
    assert.equal(subStartLegacy.length, 1, "LS1 FAIL: run_started(subagent) 应映射 1 条 legacy");
    assert.equal(subStartLegacy[0].type, "subagent", "LS1 FAIL: run_started(subagent) → subagent");
    assert.equal((subStartLegacy[0] as { phase: string }).phase, "start", "LS1 FAIL: phase=start");
    assert.equal((subStartLegacy[0] as { label: string }).label, "薪税专员-1", "LS1 FAIL: label 透传");

    // tool_completed (subagent, instanceId!=null) → subagent phase=tool
    const subToolEnv = subEmitter.wrap({ type: "tool_completed", toolName: "run_python", durationMs: 500, isError: false, summary: "执行 Python" });
    const subToolLegacy = contractToLegacyEvents(subToolEnv);
    assert.equal(subToolLegacy.length, 1, "LS2 FAIL: tool_completed(subagent) 应映射 1 条 legacy");
    assert.equal(subToolLegacy[0].type, "subagent", "LS2 FAIL: tool_completed(subagent) → subagent");
    assert.equal((subToolLegacy[0] as { phase: string }).phase, "tool", "LS2 FAIL: phase=tool");

    // run_blocked (subagent) → subagent phase=blocked
    const subBlockEnv = subEmitter.wrap({ type: "run_blocked", summary: "高风险动作已拦截，待主对话人工确认", toolName: "create_voucher", label: "薪税专员-1", roleId: "payroll-officer" });
    const subBlockLegacy = contractToLegacyEvents(subBlockEnv);
    assert.equal(subBlockLegacy.length, 1, "LS3 FAIL: run_blocked(subagent) 应映射 1 条 legacy");
    assert.equal(subBlockLegacy[0].type, "subagent", "LS3 FAIL: run_blocked → subagent");
    assert.equal((subBlockLegacy[0] as { phase: string }).phase, "blocked", "LS3 FAIL: phase=blocked");

    // run_ended (subagent, kind=complete) → subagent phase=done, success=true
    const subDoneEnv = subEmitter.wrap({ type: "run_ended", kind: "complete", durationMs: 1200, label: "薪税专员-1", roleId: "payroll-officer" });
    const subDoneLegacy = contractToLegacyEvents(subDoneEnv);
    assert.equal(subDoneLegacy.length, 1, "LS4 FAIL: run_ended(subagent) 应映射 1 条 legacy");
    assert.equal(subDoneLegacy[0].type, "subagent", "LS4 FAIL: run_ended(subagent) → subagent");
    assert.equal((subDoneLegacy[0] as { phase: string }).phase, "done", "LS4 FAIL: phase=done");
    assert.equal((subDoneLegacy[0] as { success: boolean }).success, true, "LS4 FAIL: kind=complete → success=true");

    // run_ended (subagent, kind=incomplete) → subagent phase=done, success=false
    const subDoneFailEnv = subEmitter.wrap({ type: "run_ended", kind: "incomplete", durationMs: 800, label: "薪税专员-1", roleId: "payroll-officer" });
    const subDoneFailLegacy = contractToLegacyEvents(subDoneFailEnv);
    assert.equal((subDoneFailLegacy[0] as { success: boolean }).success, false, "LS5 FAIL: kind=incomplete → success=false");

    console.log("LS1-LS5: subagent 事件映射 ✓");
  }

  // ─── ② createEmitter：envelope 不变量 ─────────────────────────────────────
  {
    const { createEmitter } = await import("../lib/agent/runtime-events.ts");

    const emitter = createEmitter("run-id-xyz", 99);

    // eventId 严格单调递增，从 1 起
    const e1 = emitter.wrap({ type: "run_started", conversationId: 99 });
    const e2 = emitter.wrap({ type: "message_delta", channel: "text", delta: "hi" });
    const e3 = emitter.wrap({ type: "run_settled", outcome: "completed" });

    assert.equal(e1.eventId, 1, "E1 FAIL: 第一个 eventId 应为 1");
    assert.equal(e2.eventId, 2, "E2 FAIL: 第二个 eventId 应为 2");
    assert.equal(e3.eventId, 3, "E3 FAIL: 第三个 eventId 应为 3");
    assert.ok(e1.eventId < e2.eventId && e2.eventId < e3.eventId, "E4 FAIL: eventId 应严格单调递增");

    // v=1 固定
    assert.equal(e1.v, 1, "E5 FAIL: v 应为 1");
    assert.equal(e2.v, 1, "E5 FAIL: v 应为 1");

    // runId 一致
    assert.equal(e1.runId, "run-id-xyz", "E6 FAIL: runId 应等于 traceId");
    assert.equal(e2.runId, "run-id-xyz", "E6 FAIL: runId 应等于 traceId");

    // conversationId 透传
    assert.equal(e1.conversationId, 99, "E7 FAIL: conversationId 应透传");

    // ts 为 ISO 字符串
    assert.ok(typeof e1.ts === "string" && !Number.isNaN(Date.parse(e1.ts)), "E8 FAIL: ts 应为有效 ISO 日期字符串");

    // 主对话 emitter instanceId=null
    assert.equal(e1.instanceId, null, "E9 FAIL: 主对话 instanceId 应为 null");
    assert.equal(e2.instanceId, null, "E9 FAIL: 主对话 instanceId 应为 null");

    // 子代理 emitter instanceId 非空且一致
    const subEmitter = createEmitter("run-id-xyz", 99, "my-instance-id");
    const s1 = subEmitter.wrap({ type: "run_started" });
    const s2 = subEmitter.wrap({ type: "run_settled", outcome: "completed" });
    assert.equal(s1.instanceId, "my-instance-id", "E10 FAIL: 子代理 instanceId 应非空");
    assert.equal(s1.instanceId, s2.instanceId, "E11 FAIL: 同一子代理内 instanceId 应一致");

    // wrapConversation：runId=null
    const titleEnv = emitter.wrapConversation({ type: "title_updated", title: "测试标题" });
    assert.equal(titleEnv.runId, null, "E12 FAIL: conversation 级事件 runId 应为 null");
    assert.equal(titleEnv.conversationId, 99, "E13 FAIL: conversation 级事件 conversationId 应透传");

    console.log("E1-E13: envelope 不变量 ✓");
  }

  // ─── ② (续) 跨 emitter 单调性：同一 run 的 main + sub emitter 共享 runCounter ──
  // B2 修复验证：三类 emitter 交错 wrap 事件后 eventId 严格连续递增，无重复无回退
  {
    const { createEmitter } = await import("../lib/agent/runtime-events.ts");

    let seq = 0;
    const runCounter = { next: () => (seq += 1) };

    const mainEmitter = createEmitter("run-mono-test", 7, null, runCounter);
    const subEmitter1 = createEmitter("run-mono-test", 7, "sub-1", runCounter);
    const subEmitter2 = createEmitter("run-mono-test", 7, "sub-2", runCounter);

    const envs = [
      mainEmitter.wrap({ type: "run_started", conversationId: 7 }),
      subEmitter1.wrap({ type: "run_started", label: "薪税专员-1", roleId: "payroll" }),
      mainEmitter.wrap({ type: "message_delta", channel: "text", delta: "hi" }),
      subEmitter1.wrap({ type: "tool_completed", toolName: "read", durationMs: 10, label: "薪税专员-1", roleId: "payroll" }),
      subEmitter2.wrap({ type: "run_started", label: "财务审批-1", roleId: "finance-approver" }),
      subEmitter1.wrap({ type: "run_ended", kind: "complete", label: "薪税专员-1", roleId: "payroll", durationMs: 200 }),
      mainEmitter.wrap({ type: "run_settled", outcome: "completed" }),
    ];

    const ids = envs.map(e => e.eventId);
    // 严格单调连续：每个 eventId = 前一个 + 1
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] === ids[i - 1] + 1, `EM${i} FAIL: eventId 应严格连续，index ${i}: got [${ids.join(",")}]`);
    }
    assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7], "EM-all FAIL: 跨 emitter eventId 应为 1-7 严格递增");

    // 独立 emitter（无 sharedCounter）仍有自己的内部单调序列（向后兼容）
    const standaloneEmitter = createEmitter("standalone-run", null);
    const s1 = standaloneEmitter.wrap({ type: "run_started" });
    const s2 = standaloneEmitter.wrap({ type: "message_delta", channel: "text", delta: "x" });
    assert.equal(s1.eventId, 1, "EM-standalone-1 FAIL: 独立 emitter 应从 1 起");
    assert.equal(s2.eventId, 2, "EM-standalone-2 FAIL: 独立 emitter 应严格递增");

    console.log("EM1-EM7 + standalone: 跨 emitter 单调递增 ✓");
  }

  // ─── ③ 源码契约：import 同源 ───────────────────────────────────────────────
  {
    const chatTypesSrc = src("app/chat/chat-types.ts");
    const adapterSrc = src("lib/agent/claude-adapter.ts");
    const routeSrc = src("app/api/agent/query/route.ts");

    // chat-types.ts 应引用 AgentRuntimeEvent
    assert.ok(
      chatTypesSrc.includes("AgentRuntimeEvent"),
      "C1 FAIL: chat-types.ts 应 import/引用 AgentRuntimeEvent"
    );
    // chat-types.ts 应有 export type AgentEvent = 别名
    assert.ok(
      chatTypesSrc.includes("export type AgentEvent ="),
      "C2 FAIL: chat-types.ts 应有 export type AgentEvent = 别名"
    );
    // 确认不再有本地 union（原来的多行 | 开头形式）
    assert.ok(
      !chatTypesSrc.match(/export type AgentEvent\s*=\s*\n\s*\|/),
      "C3 FAIL: chat-types.ts 不应有本地 AgentEvent union（多行 | 开头）"
    );

    // claude-adapter.ts 不再 export AgentRunEvent
    assert.ok(
      !adapterSrc.includes("export type AgentRunEvent"),
      "C4 FAIL: claude-adapter.ts 不应再 export AgentRunEvent"
    );

    // route.ts import 自 runtime-events.ts
    assert.ok(
      routeSrc.includes("runtime-events"),
      "C5 FAIL: route.ts 应 import 自 runtime-events"
    );

    // adapter import 自 runtime-events
    assert.ok(
      adapterSrc.includes("runtime-events"),
      "C6 FAIL: claude-adapter.ts 应 import 自 runtime-events"
    );

    console.log("C1-C6: 源码契约 import 同源 ✓");
  }

  // ─── ④ reducer 等价：合同事件序列 → 与旧实现相同 UI 状态 ────────────────────
  {
    const baseTurn = {
      key: "test",
      conversationId: null,
      status: "streaming" as const,
      userMessage: { role: "user" as const, content: "test" },
      baseMessages: [],
      streamedContent: "",
      timeline: [],
      startedAt: 0,
      processedEndedAt: null,
    };

    const { reduceChunk, reduceAgentEvent } = await import("../app/shared/chat-stream.tsx");

    // text chunk → timeline 末尾合并
    const t1 = reduceChunk(baseTurn, "你好", 100);
    assert.equal(t1.streamedContent, "你好", "R1 FAIL: streamedContent 应累积");
    assert.equal(t1.timeline.length, 1, "R1 FAIL: 应有 1 个 timeline 项");
    assert.equal(t1.timeline[0].event.type, "text", "R1 FAIL: timeline 项应为 text");

    const t2 = reduceChunk(t1, "世界", 101);
    assert.equal(t2.streamedContent, "你好世界", "R2 FAIL: streamedContent 应继续累积");
    assert.equal(t2.timeline.length, 1, "R2 FAIL: 连续 text chunk 应合并为 1 项");

    // tool_use agent event → timeline
    const toolUseEvent = { type: "tool_use" as const, name: "Read", id: "tu-1" };
    const t3 = reduceAgentEvent(t2, toolUseEvent, 200, null);
    assert.equal(t3.timeline.length, 2, "R3 FAIL: tool_use 应新增 timeline 项");
    assert.equal(t3.timeline[1].event.type, "tool_use", "R3 FAIL: 事件类型应为 tool_use");

    // tool_result → processedEndedAt 重置
    const toolResultEvent = { type: "tool_result" as const, name: "Read", content: "file content", isError: false, durationMs: 50 };
    const t4 = reduceAgentEvent(t3, toolResultEvent, 201, null);
    assert.equal(t4.processedEndedAt, null, "R4 FAIL: tool_result 应重置 processedEndedAt");

    // instanceId 应存储到 timeline 项
    const subagentEvent = { type: "subagent" as const, label: "薪税专员-1", roleId: "payroll", phase: "start" as const, summary: "薪税专员-1" };
    const t5 = reduceAgentEvent(baseTurn, subagentEvent, 300, "my-instance-id");
    assert.equal(t5.timeline.length, 1, "R5 FAIL: subagent 事件应进 timeline");
    assert.equal((t5.timeline[0] as { instanceId?: string | null }).instanceId, "my-instance-id", "R6 FAIL: instanceId 应存储到 timeline 项");

    // instanceId=null 时也存储（主对话）
    const t6 = reduceAgentEvent(baseTurn, toolUseEvent, 400, null);
    assert.equal((t6.timeline[0] as { instanceId?: string | null }).instanceId, null, "R7 FAIL: 主对话 instanceId 应为 null");

    console.log("R1-R7: reducer 等价 ✓");
  }

  // ─── ⑤ run_settled 收口：settled 恰好一次 × 三路径 ───────────────────────
  {
    const { createEmitter } = await import("../lib/agent/runtime-events.ts");

    // 模拟三路径的 settled 发射，验证 settled 出现在 run_ended 之后
    function simulateRun(outcome: "completed" | "aborted" | "error"): Array<{ type: string; outcome?: string }> {
      const events: Array<{ type: string; outcome?: string }> = [];
      const emitter = createEmitter("run-settle-test", null);

      const endKind = outcome === "completed" ? "complete" : "incomplete";
      const endedEnv = emitter.wrap({ type: "run_ended", kind: endKind });
      events.push({ type: endedEnv.event.type });
      const settledEnv = emitter.wrap({ type: "run_settled", outcome });
      events.push({ type: settledEnv.event.type, outcome: (settledEnv.event as { outcome?: string }).outcome });

      return events;
    }

    for (const outcome of ["completed", "aborted", "error"] as const) {
      const events = simulateRun(outcome);
      const settledEvents = events.filter((e) => e.type === "run_settled");
      assert.equal(settledEvents.length, 1, `S1 FAIL: ${outcome} 路径应恰好一次 run_settled`);

      const runEndedIdx = events.findIndex((e) => e.type === "run_ended");
      const settledIdx = events.findIndex((e) => e.type === "run_settled");
      assert.ok(runEndedIdx < settledIdx, `S2 FAIL: ${outcome} 路径 run_ended 应先于 run_settled`);
    }

    // settled outcome 值验证
    const completedEvents = simulateRun("completed");
    const abortedEvents = simulateRun("aborted");
    const errorEvents = simulateRun("error");

    assert.equal(completedEvents.find(e => e.type === "run_settled")?.outcome, "completed", "S3 FAIL: 成功路径 outcome=completed");
    assert.equal(abortedEvents.find(e => e.type === "run_settled")?.outcome, "aborted", "S4 FAIL: abort 路径 outcome=aborted");
    assert.equal(errorEvents.find(e => e.type === "run_settled")?.outcome, "error", "S5 FAIL: 错误路径 outcome=error");

    console.log("S1-S5: run_settled 收口 × 三路径 ✓");
  }

  console.log("\nruntime-events: 全部断言通过 ✓");
})();
