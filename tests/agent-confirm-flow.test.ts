import assert from "node:assert/strict";
import { runBeforeHooks } from "../lib/agent/hooks/chain.ts";
import { createRiskConfirmHook, createUnwiredToolHook } from "../lib/agent/hooks/built-in.ts";
import {
  answerPendingQuestion,
  cancelPendingQuestions,
  createPendingQuestion
} from "../lib/agent/pending-questions.ts";
import { dispatchSSEEvent } from "../app/chat/chat-request.ts";
import type { AgentEvent } from "../app/chat/chat-types.ts";

const CONFIRM_TOOL = "mcp__finance_worker__confirm_payroll_period";

function ctxFor(toolName: string, resolveUserQuestion?: (q: { question: string }) => Promise<string>) {
  return {
    toolName,
    input: { year: 2026, month: 6 },
    outputDir: "/tmp",
    resolveUserQuestion
  };
}

export const agentConfirmFlowTestPromise = (async () => {
  const chain = [createUnwiredToolHook(), createRiskConfirmHook()];

  // ── AC1: 有 resolver 时 confirm 等待回答;肯定→allow,取消/空→deny ──
  const allowed = await runBeforeHooks(chain, ctxFor(CONFIRM_TOOL, async () => "确认"));
  assert.equal(allowed.behavior, "allow", "AC1 FAIL: 用户确认后应放行");

  const cancelled = await runBeforeHooks(chain, ctxFor(CONFIRM_TOOL, async () => "取消"));
  assert.equal(cancelled.behavior, "deny", "AC1 FAIL: 用户取消应拒绝");

  const empty = await runBeforeHooks(chain, ctxFor(CONFIRM_TOOL, async () => ""));
  assert.equal(empty.behavior, "deny", "AC1 FAIL: 空回答(超时)必须按未确认拒绝");

  const noResolver = await runBeforeHooks(chain, ctxFor(CONFIRM_TOOL, undefined));
  assert.equal(noResolver.behavior, "deny", "AC1 FAIL: 无确认通道必须拒绝");

  // ── AC1b: 确认门改纯工具级 —— 高风险财务动作必确认,安全/豁免工具放行 ──
  // 高风险工具:无 resolver → deny(证明确实走了确认门,不靠 skill 配置)
  for (const tool of [
    "mcp__finance_worker__calculate_payroll_batch",
    "mcp__finance_worker__confirm_payroll_period",
    "mcp__kingdee_worker__export_kingdee_draft",
  ]) {
    const r = await runBeforeHooks(chain, ctxFor(tool, undefined));
    assert.equal(r.behavior, "deny", `AC1b FAIL: 高风险工具 ${tool} 无确认通道应拒绝(即需确认)`);
  }
  // remember_convention:ALWAYS_CONFIRM,无 resolver → deny
  assert.equal(
    (await runBeforeHooks(chain, ctxFor("mcp__finance_worker__remember_convention", undefined))).behavior,
    "deny",
    "AC1b FAIL: remember_convention 应始终需确认"
  );
  // 放行类:无 resolver 也 allow(证明不需确认)。run_python(medium)/Read(safe)/Skill(未登记→默认medium)
  for (const tool of ["mcp__finance_worker__run_python", "Read", "Skill", "mcp__finance_worker__search_knowledge"]) {
    const r = await runBeforeHooks(chain, ctxFor(tool, undefined));
    assert.equal(r.behavior, "allow", `AC1b FAIL: ${tool} 应直接放行,不需确认`);
  }
  // Bash 在真实链里由 createUnwiredToolHook 直接 deny(不再靠确认门豁免)
  assert.equal(
    (await runBeforeHooks(chain, ctxFor("Bash", undefined))).behavior, "deny",
    "AC1b FAIL: Bash 应被 unwired-tool hook 拒绝"
  );

  // ── AC1d: 确认 prompt 是人话(动作摘要 + 不可逆后果),不暴露 raw 工具名 ──
  let capturedPrompt = "";
  await runBeforeHooks(chain, ctxFor(CONFIRM_TOOL, async (q) => { capturedPrompt = q.question; return "确认"; }));
  assert.ok(capturedPrompt.includes("工资生效"), "AC1d FAIL: 确认 prompt 应含人话动作摘要(期间+动作)");
  assert.ok(capturedPrompt.includes("生效锁定"), "AC1d FAIL: 确认 prompt 应点明不可逆后果");
  assert.ok(capturedPrompt.includes("确认执行吗"), "AC1d FAIL: 确认 prompt 应有明确确认问句");
  assert.ok(!capturedPrompt.includes("mcp__"), "AC1d FAIL: 确认 prompt 不应暴露 raw 工具名");

  // ── AC1c: 确认门并发安全 —— 同时确认多个高风险动作互不串扰 ──
  const concurrent = await Promise.all(
    ["mcp__finance_worker__calculate_payroll_batch", "mcp__finance_worker__confirm_payroll_period", "mcp__kingdee_worker__export_kingdee_draft"]
      .map((tool) => runBeforeHooks(chain, ctxFor(tool, async () => "确认")))
  );
  assert.ok(concurrent.every((r) => r.behavior === "allow"), "AC1c FAIL: 并发确认(均确认)应全部放行,无串扰");

  // ── AC2: pending-questions 创建/应答/超时/未知 id ──
  const created = createPendingQuestion("trace-1", { question: "确认生效?" });
  assert.ok(created.id, "AC2 FAIL: 应返回 questionId");
  assert.equal(answerPendingQuestion(created.id, "确认"), true, "AC2 FAIL: 应答已挂起的问题应成功");
  assert.equal(await created.promise, "确认", "AC2 FAIL: promise 应 resolve 为用户答案");
  assert.equal(answerPendingQuestion(created.id, "再答一次"), false, "AC2 FAIL: 重复应答应返回 false");
  assert.equal(answerPendingQuestion("no-such-id", "x"), false, "AC2 FAIL: 未知 id 应返回 false 而非抛错");

  // 生产的超时 timer 是 unref 的(不阻塞进程退出),测试进程需 keepalive 撑过超时窗口
  const keepalive = setTimeout(() => {}, 2000);
  const timed = createPendingQuestion("trace-2", { question: "会超时" }, 20);
  assert.equal(await timed.promise, "", "AC2 FAIL: 超时应 resolve 空串(按未确认处理)");
  clearTimeout(keepalive);

  const c1 = createPendingQuestion("trace-3", { question: "q1" });
  const c2 = createPendingQuestion("trace-3", { question: "q2" });
  const other = createPendingQuestion("trace-4", { question: "q3" });
  cancelPendingQuestions("trace-3");
  assert.equal(await c1.promise, "", "AC2 FAIL: cancel 应结清同 trace 的挂起问题");
  assert.equal(await c2.promise, "");
  assert.equal(answerPendingQuestion(other.id, "ok"), true, "AC2 FAIL: cancel 不应误伤其他 trace");
  assert.equal(await other.promise, "ok");

  // ── AC3: POST /api/agent/answer 能 resolve 同进程挂起的问题 ──
  const { POST: answerRoute } = await import("../app/api/agent/answer/route.ts");
  const pendingForApi = createPendingQuestion("trace-api", { question: "经 API 应答" });
  const okRes = await answerRoute(
    new Request("http://local/api/agent/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: pendingForApi.id, answer: "确认" })
    })
  );
  assert.equal(okRes.status, 200, "AC3 FAIL: 合法应答应 200");
  assert.equal(await pendingForApi.promise, "确认", "AC3 FAIL: API 应答应 resolve 挂起 promise");

  const missRes = await answerRoute(
    new Request("http://local/api/agent/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "gone", answer: "x" })
    })
  );
  assert.equal(missRes.status, 404, "AC3 FAIL: 未知/已失效问题应 404");

  const badRes = await answerRoute(new Request("http://local/api/agent/answer", { method: "POST", body: "not json" }));
  assert.equal(badRes.status, 400, "AC3 FAIL: 非法请求体应 400");

  // ── AC4: SSE 分发包含 ask_user / ask_user_answered ──
  const received: AgentEvent[] = [];
  const callbacks = {
    onChunk: () => {},
    onAgentEvent: (event: AgentEvent) => { received.push(event); },
    onDone: async () => {}
  };
  assert.equal(
    await dispatchSSEEvent({ type: "ask_user", questionId: "q-1", question: { question: "继续吗?", header: "操作确认" } }, callbacks),
    true,
    "AC4 FAIL: ask_user 帧应被识别"
  );
  assert.equal(
    await dispatchSSEEvent({ type: "ask_user_answered", questionId: "q-1", answer: "确认" }, callbacks),
    true,
    "AC4 FAIL: ask_user_answered 帧应被识别"
  );
  assert.equal(await dispatchSSEEvent({ type: "unknown_frame" }, callbacks), false, "AC4 FAIL: 未知帧应返回 false");
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], { type: "ask_user", questionId: "q-1", question: { question: "继续吗?", header: "操作确认" } });
  assert.deepEqual(received[1], { type: "ask_user_answered", questionId: "q-1", answer: "确认" });
  await assert.rejects(
    () => dispatchSSEEvent({ type: "error", message: "boom" }, callbacks),
    /boom/,
    "AC4 FAIL: error 帧应抛错"
  );

  // ── AC5: title 帧(agent 提炼标题推送)被识别并回调 onTitle ──
  const titles: Array<{ id: number; title: string }> = [];
  const titleCallbacks = {
    onChunk: () => {},
    onAgentEvent: () => {},
    onTitle: (id: number, title: string) => { titles.push({ id, title }); },
    onDone: async () => {}
  };
  assert.equal(
    await dispatchSSEEvent({ type: "title", conversationId: 7, title: "差旅报销核对" }, titleCallbacks),
    true,
    "AC5 FAIL: title 帧应被识别"
  );
  assert.deepEqual(titles, [{ id: 7, title: "差旅报销核对" }], "AC5 FAIL: onTitle 应收到 conversationId + title");
  // 缺字段的 title 帧不应被当作有效 title(返回 false,不回调)
  assert.equal(
    await dispatchSSEEvent({ type: "title", conversationId: 7 }, titleCallbacks),
    false,
    "AC5 FAIL: 缺 title 字段的帧不应被识别为 title"
  );
  assert.equal(titles.length, 1, "AC5 FAIL: 非法 title 帧不应触发 onTitle");

  // ── AC6: incomplete 帧(回合未完成、已落库)被识别并回调 onIncomplete(不抛错,区别于 error 帧) ──
  const incompletes: Array<{ conversationId?: number; message?: string }> = [];
  const incompleteCallbacks = {
    onChunk: () => {},
    onAgentEvent: () => {},
    onDone: async () => {},
    onIncomplete: (p: { conversationId?: number; message?: string }) => { incompletes.push(p); }
  };
  assert.equal(
    await dispatchSSEEvent({ type: "incomplete", conversationId: 9, message: "Reached maximum number of turns (30)" }, incompleteCallbacks),
    true,
    "AC6 FAIL: incomplete 帧应被识别"
  );
  assert.equal(incompletes.length, 1, "AC6 FAIL: onIncomplete 应被回调");
  assert.equal(incompletes[0].conversationId, 9, "AC6 FAIL: onIncomplete 应收到 conversationId");

  console.log("agent-confirm-flow: all 6 checks passed ✓");
})();
