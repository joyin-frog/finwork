import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMockAgentEnabled, runMockAgent } from "../lib/agent/mock-agent.ts";
import type { AgentRuntimeEvent } from "../lib/agent/runtime-events.ts";
import type { MockAgentRunOptions } from "../lib/agent/mock-agent.ts";

export const mockAgentTestPromise = (async () => {
  const prevFlag = process.env.FINANCE_AGENT_MOCK_AGENT;
  const prevFilesDir = process.env.FINANCE_AGENT_FILES_DIR;
  process.env.FINANCE_AGENT_MOCK_AGENT = "1";
  process.env.FINANCE_AGENT_MOCK_AGENT_DELAY = "0"; // 测试不延时
  try {
    assert.equal(isMockAgentEnabled(), true, "FAIL: 置位后应启用");

    async function run(text: string, opts: Partial<MockAgentRunOptions> = {}) {
      const chunks: string[] = [];
      const events: AgentRuntimeEvent[] = [];
      const res = await runMockAgent([{ role: "user", content: text }], {
        ...opts,
        emit: (e) => {
          if (e.type === "message_delta" && e.channel === "text") {
            chunks.push(e.delta);
          } else {
            events.push(e);
          }
        },
      });
      return { res, chunks, events, full: chunks.join("") };
    }

    // ── M1: 生成文件 → 写真产物 + analyze_tabular 工具事件,content 与流式一致 ──
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mock-gen-"));
    const outputDir = path.join(tmp, "file-workspace", "runs", "mock-test-run", "work");
    const conversationFilesDir = path.join(tmp, "conversation-files", "42");
    process.env.FINANCE_AGENT_FILES_DIR = conversationFilesDir;
    const gen = await run("帮我生成一个报表", {
      outputDir,
      requestId: "mock-test-run",
      conversationId: 42,
    });
    assert.ok(existsSync(path.join(outputDir, "示例报表.xlsx")), "M1 FAIL: 应写出 run working 产物");
    assert.ok(
      existsSync(path.join(conversationFilesDir, "delivered", "mock-test-run", "示例报表.xlsx")),
      "M1 FAIL: 正式 delivered 副本必须落在会话文件目录，才能被附件扫描发现"
    );
    assert.ok(
      gen.events.some((e) => e.type === "tool_started" && e.toolName === "analyze_tabular"),
      "M1 FAIL: 应有 analyze_tabular tool_started"
    );
    assert.ok(gen.events.some((e) => e.type === "tool_completed"), "M1 FAIL: 应有 tool_completed");
    assert.equal(gen.res.content, gen.full, "M1 FAIL: content 应与流式文本一致");
    assert.ok(gen.res.content.includes("示例报表.xlsx"), "M1 FAIL: 应提到文件名");

    // ── M2: 工具卡(报销)→ tool_started + tool_completed,不写文件 ──
    const tool = await run("帮我核对这批报销");
    assert.ok(
      tool.events.some((e) => e.type === "tool_started" && e.toolName === "validate_reimbursement"),
      "M2 FAIL: 应有报销校验 tool_started"
    );
    assert.ok(tool.events.some((e) => e.type === "tool_completed"), "M2 FAIL: 应有 tool_completed");

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
    assert.equal(
      chat.events.filter((e) => e.type === "tool_started" || e.type === "tool_completed").length,
      0,
      "M4 FAIL: 普通问答不应有工具事件"
    );
    assert.ok(chat.res.content.length > 0, "M4 FAIL: 应有文本");

    console.log("mock-agent M1-M4: file/tool/ask_user/chat scripts ✓");
    console.log("\n✅ mock-agent: all checks passed!");
  } finally {
    if (prevFlag === undefined) delete process.env.FINANCE_AGENT_MOCK_AGENT;
    else process.env.FINANCE_AGENT_MOCK_AGENT = prevFlag;
    if (prevFilesDir === undefined) delete process.env.FINANCE_AGENT_FILES_DIR;
    else process.env.FINANCE_AGENT_FILES_DIR = prevFilesDir;
    delete process.env.FINANCE_AGENT_MOCK_AGENT_DELAY;
  }
})();
