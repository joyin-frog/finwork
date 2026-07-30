/**
 * subagent-transparency.test.ts
 *
 * ①  纯函数：buildTurnSegments 对 subagent 事件按 label 分组
 * ②  源码契约：
 *     - Pi subagent runner 含四个 phase emit 点（start/tool/blocked/done）
 *     - 透传链：index.ts / subagent.ts 含 onSubagentEvent
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

  // ─── §2a：源码契约——四个 emit 点（AR2a 后改为新合同事件类型）──────────────
  {
    const runnerSrc = src("lib/agent/pi/subagent-runner.ts");

    // AR2a：subagent-runner 改为 AgentRuntimeEvent 新类型，不再用 phase 字段
    // run_started（子代理开始）/ run_blocked（高风险拦截）/ tool_completed（工具完成）/ run_ended（结束）
    assert.ok(runnerSrc.includes('"run_started"'), 'C1 FAIL: Pi subagent runner 应含 run_started');
    assert.ok(runnerSrc.includes('"tool_completed"'), 'C2 FAIL: Pi subagent runner 应含 tool_completed');
    assert.ok(runnerSrc.includes('"run_blocked"'), 'C3 FAIL: Pi subagent runner 应含 run_blocked');
    assert.ok(runnerSrc.includes('"run_ended"'), 'C4 FAIL: Pi subagent runner 应含 run_ended');

    console.log("C1-C4: 四个 emit 点（新合同类型）✓");
  }

  // ─── §2c：透传链完整性 ─────────────────────────────────────────────────────
  {
    const indexSrc = src("lib/agent/mcp-tools/index.ts");
    const subagentToolSrc = src("lib/agent/mcp-tools/subagent.ts");

    // index.ts 含 onSubagentEvent
    assert.ok(indexSrc.includes("onSubagentEvent"), "C8 FAIL: mcp-tools/index.ts 应含 onSubagentEvent 参数");

    // subagent.ts 含 onSubagentEvent
    assert.ok(subagentToolSrc.includes("onSubagentEvent"), "C9 FAIL: mcp-tools/subagent.ts 应含 onSubagentEvent 参数");

    console.log("C8-C9: 透传链完整性 ✓");
  }

  // ─── §2d：AR2a 后 subagent 变体在统一合同中定义 ──────────────────────────
  // AR2a 后，subagent 变体从前后端各自的本地联合移入 lib/agent/runtime-events.ts 的
  // AgentRuntimeEvent 由 runtime-events 定义，Pi runner 经公共合同消费。
  {
    const runtimeEventsSrc = src("lib/agent/runtime-events.ts");
    const runnerSrc = src("lib/agent/pi/subagent-runner.ts");

    assert.ok(runtimeEventsSrc.includes('type: "subagent"'), 'C12 FAIL: runtime-events.ts 应含 type: "subagent" 变体（唯一定义处）');
    assert.ok(runnerSrc.includes("runtime-events"), 'C13 FAIL: Pi runner 应 import 自 runtime-events');

    console.log("C12-C13: AR2a subagent 变体在 runtime-events.ts 统一定义 ✓");
  }

  // ─── §2e：渲染文件含 subagent 分支 ───────────────────────────────────────
  {
    const pageSrc = [
      "app/chat/chat-page.tsx",
      "app/chat/components/assistant-turn.tsx",
      "app/chat/components/user-bubble.tsx",
      "app/chat/components/file-tray.tsx",
      "app/chat/components/mention-popup.tsx",
    ].map(src).join("\n"); // WP9a 拆解后哨兵读取范围扩为文件集(断言语义不变)
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

  console.log("\nsubagent-transparency: 全部断言通过 ✓");
})();
