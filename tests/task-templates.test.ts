/**
 * task-templates 测试（spec-task-templates §4）
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/task-templates.test.ts
 *
 * 覆盖：
 * - T1 expandTaskTemplate：成功路径（含 extra）、未知 id 抛错、非法 period 抛错
 * - T2 subagent 模板均含 {{period}} 占位符
 * - T3 spawn 工具 task_template 三路径：匹配并注入执行器、不匹配、缺 period
 */

import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const taskTemplatesTestPromise = (async () => {
  // ─── T1: expandTaskTemplate 三路径 ──────────────────────────────────────────
  {
    const { expandTaskTemplate, TASK_TEMPLATES } = await import("../lib/agent/roles/task-templates.ts");

    // T1a：成功路径（subagent 模板，有 extra）
    const result = expandTaskTemplate("month-close-precheck", "2026-06", "请重点看应收账款");
    assert.ok(result.includes("2026-06"), "T1a FAIL: period 应被替换到输出中");
    assert.ok(!result.includes("{{period}}"), "T1a FAIL: {{period}} 占位符应被全部替换");
    assert.ok(result.includes("补充上下文：请重点看应收账款"), "T1a FAIL: extra 应被拼入");

    // T1a2：成功路径（无 extra）
    const result2 = expandTaskTemplate("bank-recon", "2026-07");
    assert.ok(result2.includes("2026-07"), "T1a2 FAIL: period 应被替换");
    assert.ok(!result2.includes("补充上下文"), "T1a2 FAIL: 无 extra 时不应有补充上下文段");

    // T1b：未知 id 抛错
    let threw1 = false;
    try {
      expandTaskTemplate("no-such-template", "2026-06");
    } catch (e) {
      threw1 = true;
      assert.ok(e instanceof Error && e.message.includes("未知模板"), `T1b FAIL: 错误消息应含"未知模板"，实际: ${e instanceof Error ? e.message : e}`);
    }
    assert.ok(threw1, "T1b FAIL: 未知模板 id 应抛错");

    // T1c：非法 period 格式抛错
    let threw2 = false;
    try {
      expandTaskTemplate("month-close-precheck", "2026/06");
    } catch (e) {
      threw2 = true;
      assert.ok(e instanceof Error && e.message.includes("period"), `T1c FAIL: 错误消息应含"period"，实际: ${e instanceof Error ? e.message : e}`);
    }
    assert.ok(threw2, "T1c FAIL: 非法 period 格式应抛错");

    // T1d：main-skill 型模板抛错（不可展开）
    const mainSkillTemplate = TASK_TEMPLATES.find((t) => t.mode === "main-skill");
    assert.ok(mainSkillTemplate, "T1d 前提 FAIL: 应有 main-skill 型模板");
    let threw3 = false;
    try {
      expandTaskTemplate(mainSkillTemplate!.id, "2026-06");
    } catch (e) {
      threw3 = true;
      assert.ok(e instanceof Error, `T1d FAIL: 应抛 Error，实际: ${e}`);
    }
    assert.ok(threw3, "T1d FAIL: main-skill 型模板调用 expandTaskTemplate 应抛错");

    console.log("task-templates T1: expandTaskTemplate 三路径 ✓");
  }

  // ─── T2: 每个 subagent 模板的 promptTemplate 含 {{period}} 占位符 ──────────
  {
    const { TASK_TEMPLATES } = await import("../lib/agent/roles/task-templates.ts");

    const subagentTemplates = TASK_TEMPLATES.filter((t) => t.mode === "subagent");
    assert.ok(subagentTemplates.length > 0, "T2 FAIL: 应至少有一个 subagent 型模板");

    for (const t of subagentTemplates) {
      assert.ok(
        t.promptTemplate && t.promptTemplate.includes("{{period}}"),
        `T2 FAIL: 模板 "${t.id}" 的 promptTemplate 应含 {{period}} 占位符`
      );
      assert.ok(t.executionTier === "fast" || t.executionTier === "reasoning", `T2 FAIL: 模板 "${t.id}" 必须声明执行档位`);
    }
    assert.equal(TASK_TEMPLATES.find((t) => t.id === "bank-recon")?.executionTier, "reasoning");
    assert.equal(TASK_TEMPLATES.find((t) => t.id === "payroll-review")?.executionTier, "fast");

    // 确保 main-skill 型模板无 promptTemplate
    const mainSkillTemplates = TASK_TEMPLATES.filter((t) => t.mode === "main-skill");
    for (const t of mainSkillTemplates) {
      assert.ok(!t.promptTemplate, `T2 FAIL: main-skill 型模板 "${t.id}" 不应有 promptTemplate`);
    }

    console.log(`task-templates T2: ${subagentTemplates.length} 个 subagent 模板均含 {{period}} ✓`);
  }

  // ─── T3: spawn 工具 task_template 三路径 ────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-task-templates-t3-"));
    const dbPath = path.join(dir, "t3.db");
    const settingsPath = path.join(dir, "settings.json");
    const secretFilePath = path.join(dir, "secret"); // 不存在 → 空 key

    const savedEnv = {
      DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
      SETTINGS_PATH: process.env.FINANCE_AGENT_SETTINGS_PATH,
      SECRET_BACKEND: process.env.FINANCE_AGENT_SECRET_BACKEND,
      SECRET_FILE: process.env.FINANCE_AGENT_SECRET_FILE,
    };

    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    process.env.FINANCE_AGENT_SETTINGS_PATH = settingsPath;
    process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
    process.env.FINANCE_AGENT_SECRET_FILE = secretFilePath;

    try {
      const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
      _resetSecretCache();

      // 初始化 DB
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 构造 mock SDK（捕获 handler），模式同 scan-slip-folder.test.ts
      type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
      const captured: { handler?: (args: Record<string, unknown>) => Promise<ToolResult> } = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockSdk: any = {
        tool: (_name: string, _desc: string, _schema: unknown, h: unknown) => {
          captured.handler = h as (args: Record<string, unknown>) => Promise<ToolResult>;
          return {};
        },
      };

      const { createSpawnSubagentTool } = await import("../lib/agent/mcp-tools/subagent.ts");
      let executedInstructions = "";
      let executedTier = "";
      createSpawnSubagentTool(
        mockSdk,
        dir,
        undefined,
        undefined,
        undefined,
        async (task) => {
          executedInstructions = task.instructions;
          executedTier = task.executionTier ?? "";
          return {
            label: task.label,
            content: "stub subagent completed",
            success: true,
            durationMs: 1,
          };
        },
      );

      const handler = captured.handler;
      if (!handler) throw new Error("T3 FAIL: spawn 工具 handler 未被捕获");

      // ── T3a：缺 period → 返回 isError 文本 ─────────────────────────────────
      const r3a = await handler({
        role: "bookkeeper",
        instructions: "测试",
        label: "t3a",
        task_template: "month-close-precheck",
        // period 缺省
      });
      assert.ok(r3a.isError, "T3a FAIL: 缺 period 时应返回 isError");
      assert.ok(
        r3a.content[0]?.text.includes("period"),
        `T3a FAIL: 错误文本应含"period"，实际: ${r3a.content[0]?.text}`
      );

      // ── T3b：模板与角色不匹配 → 返回 isError 文本 ──────────────────────────
      const r3b = await handler({
        role: "payroll-officer",         // 错误角色（month-close-precheck 属于 bookkeeper）
        instructions: "测试",
        label: "t3b",
        task_template: "month-close-precheck",
        period: "2026-06",
      });
      assert.ok(r3b.isError, "T3b FAIL: 模板不匹配时应返回 isError");
      assert.ok(
        r3b.content[0]?.text.includes("不属于角色"),
        `T3b FAIL: 错误文本应含"不属于角色"，实际: ${r3b.content[0]?.text}`
      );

      // ── T3c：匹配 → 展开模板并进入注入的中立执行器 ─────────────────────
      const r3c = await handler({
        role: "bookkeeper",
        instructions: "额外说明",
        label: "t3c",
        task_template: "month-close-precheck",
        period: "2026-06",
      });
      assert.ok(
        r3c.content[0]?.text.includes("stub subagent completed"),
        `T3c FAIL: 匹配后应调用注入执行器，实际文本: ${r3c.content[0]?.text}`
      );
      assert.ok(executedInstructions.includes("2026-06"), "T3c FAIL: 执行器应收到展开后的 period");
      assert.ok(executedInstructions.includes("额外说明"), "T3c FAIL: 执行器应收到补充上下文");
      assert.equal(executedTier, "reasoning", "T3c FAIL: 结账模板应使用推理档");
      // 不应是"不属于角色"错误
      assert.ok(
        !r3c.content[0]?.text.includes("不属于角色"),
        `T3c FAIL: 文本不应含"不属于角色"（说明验证未通过），实际: ${r3c.content[0]?.text}`
      );
      // 不应是"period"校验错误
      assert.ok(
        !r3c.content[0]?.text.startsWith("task_template 指定时 period"),
        `T3c FAIL: 文本不应是 period 校验错误，实际: ${r3c.content[0]?.text}`
      );

      await handler({
        role: "analyst",
        instructions: "跨文件恢复公式并生成交付物",
        label: "t3d",
        complexity: "complex",
      });
      assert.equal(executedTier, "reasoning", "T3d FAIL: 自由复杂任务应使用推理档");

      console.log("task-templates T3: spawn 工具 task_template 三路径（匹配/不匹配/缺period） ✓");
    } finally {
      const restoreEnv = (val: string | undefined, key: string) => {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      };
      restoreEnv(savedEnv.DB_PATH, "FINANCE_AGENT_DB_PATH");
      restoreEnv(savedEnv.SETTINGS_PATH, "FINANCE_AGENT_SETTINGS_PATH");
      restoreEnv(savedEnv.SECRET_BACKEND, "FINANCE_AGENT_SECRET_BACKEND");
      restoreEnv(savedEnv.SECRET_FILE, "FINANCE_AGENT_SECRET_FILE");
      try {
        const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
        _resetSecretCache();
      } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log("task-templates: all T1–T3 ✓");
})();
