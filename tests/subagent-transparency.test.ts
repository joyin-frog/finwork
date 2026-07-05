/**
 * subagent-transparency.test.ts
 *
 * ①  纯函数：buildTurnSegments 对 subagent 事件按 label 分组
 * ②  源码契约：
 *     - subagent-runner.ts 含四个 phase emit 点（start/tool/blocked/done）
 *     - emit 摘要来自 getToolSummary；emit 字面量不含 input:/content: 原值（脱敏）
 *     - 透传链：index.ts / subagent.ts 含 onSubagentEvent；subagent-runner.ts:buildFinanceMcpServers 调用不传 emitter
 *     - 两份事件类型都含 type: "subagent"
 *     - 渲染文件含 subagent 分支
 *     - shouldHideAgentEvent 不隐藏 subagent 事件
 *
 * 运行（单跑）：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/subagent-transparency.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const subagentTransparencyTestPromise = (async () => {

  // ─── §1：纯函数——buildTurnSegments 分组 ────────────────────────────────────
  {
    const { buildTurnSegments } = await import("../app/chat/turn-segments.ts");

    // 构造含两个不同 label 的 subagent 事件 + 普通 tool_use/tool_result 事件的 timeline
    const timeline = [
      { id: "t1", event: { type: "tool_use", name: "run_python", input: {} }, createdAt: 1 },
      { id: "t2", event: { type: "tool_result", name: "run_python", content: "ok" }, createdAt: 2 },
      { id: "s1", event: { type: "subagent", label: "薪税专员-1", roleId: "payroll", phase: "start", summary: "薪税专员-1" }, createdAt: 3 },
      { id: "s2", event: { type: "subagent", label: "薪税专员-1", roleId: "payroll", phase: "tool", toolName: "run_python", summary: "执行 Python", durationMs: 500, isError: false }, createdAt: 4 },
      { id: "s3", event: { type: "subagent", label: "薪税专员-1", roleId: "payroll", phase: "done", success: true, durationMs: 1200 }, createdAt: 5 },
      { id: "s4", event: { type: "subagent", label: "报销专员-2", roleId: "reimbursement", phase: "start", summary: "报销专员-2" }, createdAt: 6 },
      { id: "s5", event: { type: "subagent", label: "报销专员-2", roleId: "reimbursement", phase: "blocked", toolName: "create_voucher", summary: "高风险动作已拦截，待主对话人工确认" }, createdAt: 7 },
      { id: "s6", event: { type: "subagent", label: "报销专员-2", roleId: "reimbursement", phase: "done", success: false, durationMs: 800 }, createdAt: 8 },
    ];

    const result = buildTurnSegments(timeline as Parameters<typeof buildTurnSegments>[0]);

    // 应有工具段（普通 tool）
    const toolSegs = result.processSegments.filter((s) => s.kind === "tools");
    assert.ok(toolSegs.length >= 1, "P1 FAIL: 普通 tool_use/tool_result 应归入工具段，不丢失");

    // 应有两条 subagent 子轨道段（label 不同）
    const subagentSegs = result.processSegments.filter((s) => s.kind === "subagent");
    assert.equal(subagentSegs.length, 2, `P2 FAIL: 应分出两条 subagent 子轨道段，实际 ${subagentSegs.length}`);

    // 两个 label 分别对应正确的子轨道
    const labels = subagentSegs.map((s) => (s as { kind: "subagent"; label: string }).label);
    assert.ok(labels.includes("薪税专员-1"), "P3 FAIL: 应有 label=薪税专员-1 的子轨道");
    assert.ok(labels.includes("报销专员-2"), "P4 FAIL: 应有 label=报销专员-2 的子轨道");

    // 第一条子轨道包含 3 个事件（start/tool/done）
    const track1 = subagentSegs.find((s) => (s as { kind: "subagent"; label: string }).label === "薪税专员-1") as { kind: "subagent"; label: string; items: unknown[] };
    assert.equal(track1.items.length, 3, "P5 FAIL: 薪税专员-1 子轨道应含 3 个事件(start/tool/done)");

    // 第二条子轨道包含 3 个事件（start/blocked/done）
    const track2 = subagentSegs.find((s) => (s as { kind: "subagent"; label: string }).label === "报销专员-2") as { kind: "subagent"; label: string; items: unknown[] };
    assert.equal(track2.items.length, 3, "P6 FAIL: 报销专员-2 子轨道应含 3 个事件(start/blocked/done)");

    console.log("P1-P6: buildTurnSegments subagent 分组 ✓");
  }

  // ─── §2a：源码契约——四个 emit 点 ─────────────────────────────────────────
  {
    const runnerSrc = src("lib/agent/subagent-runner.ts");

    // 四个 phase
    assert.ok(runnerSrc.includes('phase: "start"'), 'C1 FAIL: subagent-runner.ts 应含 phase: "start" emit');
    assert.ok(runnerSrc.includes('phase: "tool"'), 'C2 FAIL: subagent-runner.ts 应含 phase: "tool" emit');
    assert.ok(runnerSrc.includes('phase: "blocked"'), 'C3 FAIL: subagent-runner.ts 应含 phase: "blocked" emit');
    assert.ok(runnerSrc.includes('phase: "done"'), 'C4 FAIL: subagent-runner.ts 应含 phase: "done" emit');

    console.log("C1-C4: 四个 phase emit 点 ✓");
  }

  // ─── §2b：脱敏红线——emit 用 getToolSummary；字面量不含 input/content 原值 ──
  {
    const runnerSrc = src("lib/agent/subagent-runner.ts");

    // 摘要来自 getToolSummary
    assert.ok(runnerSrc.includes("getToolSummary"), "C5 FAIL: subagent-runner.ts 应使用 getToolSummary 生成摘要");

    // emit 对象字面量不含 input: 字段（原始工具 input 不得进入事件）
    // 检测 opts.onEvent 调用块里没有 "input:" 字段传入
    // 策略：取出所有 onEvent 调用行附近 200 字符，确保没有 input: 字段
    const onEventCallRegex = /opts\.onEvent\?\.\(([^)]*)\)/gs;
    let m: RegExpExecArray | null;
    while ((m = onEventCallRegex.exec(runnerSrc)) !== null) {
      const callBody = m[1];
      // input: 字段直接传原值会出现 "input:" 或 "input :" 后跟 pending 或 block.input 等
      // 允许 toolName 等字段；禁止直接含 "input:" key in the object literal
      assert.ok(
        !/\binput\s*:/.test(callBody),
        `C6 FAIL: 脱敏红线——onEvent 调用字面量不应含 input: 字段（原始 input 不得外漏）。调用体: ${callBody.slice(0, 200)}`
      );
    }

    // emit 字面量不含 content: 字段（原始工具 content 不得外漏）
    const onEventCallRegex2 = /opts\.onEvent\?\.\(([^)]*)\)/gs;
    while ((m = onEventCallRegex2.exec(runnerSrc)) !== null) {
      const callBody = m[1];
      assert.ok(
        !/\bcontent\s*:/.test(callBody),
        `C7 FAIL: 脱敏红线——onEvent 调用字面量不应含 content: 字段（原始 content 不得外漏）。调用体: ${callBody.slice(0, 200)}`
      );
    }

    console.log("C5-C7: 脱敏红线自查 ✓");
  }

  // ─── §2c：透传链完整性 ─────────────────────────────────────────────────────
  {
    const indexSrc = src("lib/agent/mcp-tools/index.ts");
    const subagentToolSrc = src("lib/agent/mcp-tools/subagent.ts");
    const runnerSrc = src("lib/agent/subagent-runner.ts");

    // index.ts 含 onSubagentEvent
    assert.ok(indexSrc.includes("onSubagentEvent"), "C8 FAIL: mcp-tools/index.ts 应含 onSubagentEvent 参数");

    // subagent.ts 含 onSubagentEvent
    assert.ok(subagentToolSrc.includes("onSubagentEvent"), "C9 FAIL: mcp-tools/subagent.ts 应含 onSubagentEvent 参数");

    // subagent-runner.ts 中 buildFinanceMcpServers 的子代理调用不传 emitter（无递归）
    // 取出 buildFinanceMcpServers( 后紧跟的参数部分；子代理调用位置在 line ~167
    const buildFmcpCalls = runnerSrc.match(/buildFinanceMcpServers\([^)]*\)/gs) ?? [];
    assert.ok(buildFmcpCalls.length >= 1, "C10 FAIL: subagent-runner.ts 应含 buildFinanceMcpServers 调用");
    // 子代理那次调用参数短（sdk, outputDir），不含 onSubagentEvent / onEvent / runOptions
    const subagentCall = buildFmcpCalls[0]; // 子代理只有一次调用
    assert.ok(
      !subagentCall.includes("onSubagentEvent") && !subagentCall.includes("onEvent") && !subagentCall.includes("runOptions"),
      `C11 FAIL: subagent-runner.ts 的 buildFinanceMcpServers 调用不应传 emitter（防递归）。调用: ${subagentCall}`
    );

    console.log("C8-C11: 透传链完整性 ✓");
  }

  // ─── §2d：两份事件类型都含 subagent 变体 ──────────────────────────────────
  {
    const chatTypesSrc = src("app/chat/chat-types.ts");
    const adapterSrc = src("lib/agent/claude-adapter.ts");

    assert.ok(chatTypesSrc.includes('type: "subagent"'), 'C12 FAIL: chat-types.ts AgentEvent 应含 type: "subagent" 变体');
    assert.ok(adapterSrc.includes('type: "subagent"'), 'C13 FAIL: claude-adapter.ts AgentRunEvent 应含 type: "subagent" 变体');

    console.log("C12-C13: 两份事件类型含 subagent 变体 ✓");
  }

  // ─── §2e：渲染文件含 subagent 分支 ───────────────────────────────────────
  {
    const pageSrc = src("app/chat/chat-page.tsx");
    const trackSrc = src("app/chat/subagent-track.tsx");
    const segmentsSrc = src("app/chat/turn-segments.ts");

    // chat-page 引入 SubagentTrack 并渲染
    assert.ok(pageSrc.includes("SubagentTrack"), 'C14 FAIL: chat-page.tsx 应引入并渲染 SubagentTrack');
    assert.ok(pageSrc.includes("seg.kind === \"subagent\""), 'C15 FAIL: chat-page.tsx 应有 seg.kind === "subagent" 分支');

    // subagent-track.tsx 含 blocked/--tone-notice 样式
    assert.ok(trackSrc.includes("停在确认门"), "C16 FAIL: subagent-track.tsx 应包含「停在确认门」文案");
    assert.ok(trackSrc.includes("--tone-notice"), "C17 FAIL: subagent-track.tsx blocked 行应用 --tone-notice");

    // turn-segments.ts 有显式 subagent 分支（不被 else catch-all 吞）
    assert.ok(segmentsSrc.includes('type === "subagent"'), 'C18 FAIL: turn-segments.ts 应有显式 subagent 分支');
    assert.ok(segmentsSrc.includes('kind: "subagent"'), 'C19 FAIL: turn-segments.ts 应产出 kind: "subagent" 段');

    console.log("C14-C19: 渲染分支存在 ✓");
  }

  // ─── §2f：shouldHideAgentEvent 不隐藏 subagent 事件 ──────────────────────
  {
    const { shouldHideAgentEvent } = await import("../app/chat/chat-types.ts");

    const subagentEvent = { type: "subagent" as const, label: "test", roleId: "payroll", phase: "start" as const, summary: "test" };
    assert.equal(shouldHideAgentEvent(subagentEvent), false, "C20 FAIL: shouldHideAgentEvent 不应隐藏 subagent 事件");

    console.log("C20: shouldHideAgentEvent 不隐藏 subagent ✓");
  }

  // ─── §2g：MCP 工具结果也要收（P2 修复）──────────────────────────────────
  // 子代理主要调 MCP 工具，其结果块是 mcp_tool_result（只带 tool_use_id）。若只收 tool_result，
  // MCP 步骤既不进 F1 轨道也不跑 after-hook——回归锁。
  {
    const runnerSrc = src("lib/agent/subagent-runner.ts");
    assert.ok(runnerSrc.includes('"mcp_tool_result"'), 'C21 FAIL: subagent-runner.ts 应处理 mcp_tool_result 块（否则漏 MCP 工具步骤）');
    assert.ok(runnerSrc.includes('"tool_use"') && runnerSrc.includes("toolUseNamesById"),
      'C22 FAIL: subagent-runner.ts 应捕获 tool_use 块建 id→name 映射，供 mcp_tool_result 配对');
    console.log("C21-C22: MCP 工具结果被收（P2）✓");
  }

  console.log("\nsubagent-transparency: 全部断言通过 ✓");
})();
