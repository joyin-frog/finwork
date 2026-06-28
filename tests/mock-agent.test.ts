import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMockAgentEnabled, runMockAgent } from "../lib/agent/mock-agent.ts";
import type { AgentRunEvent, ClaudeAgentRunOptions } from "../lib/agent/claude-adapter.ts";

export const mockAgentTestPromise = (async () => {
  const prevFlag = process.env.FINANCE_AGENT_MOCK_AGENT;
  process.env.FINANCE_AGENT_MOCK_AGENT = "1";
  process.env.FINANCE_AGENT_MOCK_AGENT_DELAY = "0"; // 测试不延时
  try {
    assert.equal(isMockAgentEnabled(), true, "FAIL: 置位后应启用");

    async function run(text: string, opts: Partial<ClaudeAgentRunOptions> = {}) {
      const chunks: string[] = [];
      const events: AgentRunEvent[] = [];
      const res = await runMockAgent([{ role: "user", content: text }], {
        ...opts,
        onChunk: (t) => chunks.push(t),
        onAgentEvent: (e) => events.push(e),
      });
      return { res, chunks, events, full: chunks.join("") };
    }

    // ── M1: 生成文件 → 写真产物 + run_python 工具事件,content 与流式一致 ──
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mock-gen-"));
    const gen = await run("帮我生成一个报表", { outputDir: tmp });
    assert.ok(existsSync(path.join(tmp, "示例报表.xlsx")), "M1 FAIL: 应写出产物文件");
    assert.ok(
      gen.events.some((e) => e.type === "tool_use" && e.name === "run_python"),
      "M1 FAIL: 应有 run_python tool_use"
    );
    assert.ok(gen.events.some((e) => e.type === "tool_result"), "M1 FAIL: 应有 tool_result");
    assert.equal(gen.res.content, gen.full, "M1 FAIL: content 应与流式文本一致");
    assert.ok(gen.res.content.includes("示例报表.xlsx"), "M1 FAIL: 应提到文件名");

    // ── M2: 工具卡(报销)→ tool_use + tool_result,不写文件 ──
    const tool = await run("帮我核对这批报销");
    assert.ok(
      tool.events.some((e) => e.type === "tool_use" && e.name === "validate_reimbursement"),
      "M2 FAIL: 应有报销校验 tool_use"
    );
    assert.ok(tool.events.some((e) => e.type === "tool_result"), "M2 FAIL: 应有 tool_result");

    // ── M3: ask_user → 调 resolveUserQuestion 并用其答案 ──
    let asked: { question?: string } | null = null;
    const ask = await run("这两个方案选哪个", {
      resolveUserQuestion: async (q) => {
        asked = q;
        return "含税";
      },
    });
    assert.ok(asked !== null && typeof asked.question === "string", "M3 FAIL: 应触发 resolveUserQuestion");
    assert.ok(ask.res.content.includes("含税"), "M3 FAIL: 应使用用户答案");

    // ── M4: 普通问答 → 纯文本,无工具事件 ──
    const chat = await run("你好");
    assert.equal(chat.events.length, 0, "M4 FAIL: 普通问答不应有工具事件");
    assert.ok(chat.res.content.length > 0, "M4 FAIL: 应有文本");

    console.log("mock-agent M1-M4: file/tool/ask_user/chat scripts ✓");
    console.log("\n✅ mock-agent: all checks passed!");
  } finally {
    if (prevFlag === undefined) delete process.env.FINANCE_AGENT_MOCK_AGENT;
    else process.env.FINANCE_AGENT_MOCK_AGENT = prevFlag;
    delete process.env.FINANCE_AGENT_MOCK_AGENT_DELAY;
  }
})();
