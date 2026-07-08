/**
 * filing-precheck-batch 测试（spec-filing-precheck-batch §3 步骤 5）
 *
 * 覆盖：
 * - 模板存在性与属性（存在、归属、mode、objectLabel、{{period}}、口径声明）
 * - 角色白名单不含批跑工具（所有角色）
 * - 工具六条路径（非法period/默认period/显式period+参数校验/双成功/一成一败/双失败）
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/filing-precheck-batch.test.ts
 */

import assert from "node:assert/strict";
import { TASK_TEMPLATES } from "../lib/agent/roles/task-templates.ts";
import { resolveRoleAllowedTools } from "../lib/agent/roles/registry.ts";

export const filingPrecheckBatchTestPromise = (async () => {

  // ─── 模板存在性与属性 ──────────────────────────────────────────────────────────
  {
    const vatTemplate = TASK_TEMPLATES.find((t) => t.id === "vat-filing-precheck");
    const iitTemplate = TASK_TEMPLATES.find((t) => t.id === "iit-filing-precheck");

    assert.ok(vatTemplate, "T-tmpl FAIL: vat-filing-precheck 模板不存在");
    assert.ok(iitTemplate, "T-tmpl FAIL: iit-filing-precheck 模板不存在");

    // 归属角色
    assert.equal(vatTemplate!.roleId, "tax-officer", "T-tmpl FAIL: vat-filing-precheck 应归属 tax-officer");
    assert.equal(iitTemplate!.roleId, "tax-officer", "T-tmpl FAIL: iit-filing-precheck 应归属 tax-officer");

    // mode
    assert.equal(vatTemplate!.mode, "subagent", "T-tmpl FAIL: vat 模板 mode 应为 subagent");
    assert.equal(iitTemplate!.mode, "subagent", "T-tmpl FAIL: iit 模板 mode 应为 subagent");

    // objectLabel
    assert.ok(vatTemplate!.objectLabel, "T-tmpl FAIL: vat 模板应有 objectLabel");
    assert.ok(iitTemplate!.objectLabel, "T-tmpl FAIL: iit 模板应有 objectLabel");

    // {{period}} 占位符
    assert.ok(
      vatTemplate!.promptTemplate?.includes("{{period}}"),
      "T-tmpl FAIL: vat 模板 promptTemplate 应含 {{period}}"
    );
    assert.ok(
      iitTemplate!.promptTemplate?.includes("{{period}}"),
      "T-tmpl FAIL: iit 模板 promptTemplate 应含 {{period}}"
    );

    // VAT：全库累计口径声明
    assert.ok(
      vatTemplate!.promptTemplate?.includes("全库累计"),
      "T-tmpl FAIL: vat 模板应声明全库累计口径"
    );

    // IIT：阻塞项声明 + 禁止读草稿
    assert.ok(
      iitTemplate!.promptTemplate?.includes("阻塞"),
      "T-tmpl FAIL: iit 模板应包含阻塞项说明"
    );
    assert.ok(
      iitTemplate!.promptTemplate?.includes("不得") || iitTemplate!.promptTemplate?.includes("不读"),
      "T-tmpl FAIL: iit 模板应包含禁止读草稿明细说明"
    );

    // 排序：紧排在 filing-precheck 之后
    const filingIdx = TASK_TEMPLATES.findIndex((t) => t.id === "filing-precheck");
    const vatIdx    = TASK_TEMPLATES.findIndex((t) => t.id === "vat-filing-precheck");
    const iitIdx    = TASK_TEMPLATES.findIndex((t) => t.id === "iit-filing-precheck");
    assert.ok(filingIdx >= 0, "T-tmpl FAIL: filing-precheck 模板不存在（前置条件）");
    assert.equal(vatIdx, filingIdx + 1, "T-tmpl FAIL: vat-filing-precheck 应紧排在 filing-precheck 之后");
    assert.equal(iitIdx, filingIdx + 2, "T-tmpl FAIL: iit-filing-precheck 应紧排在 vat-filing-precheck 之后");

    console.log("filing-precheck-batch: 模板存在性与属性 ✓");
  }

  // ─── 角色白名单不含批跑工具 ────────────────────────────────────────────────────
  {
    const toolFullName = "mcp__finance_worker__run_filing_precheck_batch";
    const allRoleIds = ["tax-officer", "bookkeeper", "payroll-officer", "treasury-officer", "receivables-officer", "analyst"];
    for (const roleId of allRoleIds) {
      const tools = resolveRoleAllowedTools(roleId);
      assert.ok(
        !tools.includes(toolFullName),
        `T-whitelist FAIL: ${roleId} 的白名单不应含 ${toolFullName}`
      );
    }
    console.log("filing-precheck-batch: 角色白名单不含批跑工具 ✓");
  }

  // ─── 工具六条路径（注入 deps 隔离 LLM）───────────────────────────────────────────
  {
    // mock SDK：捕获 handler
    type ToolResult = {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
    const captured: { handler?: Handler } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSdk: any = {
      tool: (_name: string, _desc: string, _schema: unknown, h: unknown) => {
        captured.handler = h as Handler;
        return {};
      },
    };

    type CallRecord = { tasks: Array<Record<string, unknown>>; opts: Record<string, unknown> };
    let calls: CallRecord[] = [];

    // 构造 fake runner：记录调用、按脚本返回结果
    function makeFakeRun(
      results: Array<{ success: boolean; content: string; durationMs: number }>
    ) {
      return async (tasks: Array<Record<string, unknown>>, opts: Record<string, unknown>) => {
        calls.push({ tasks, opts });
        return results.map((r, i) => ({
          label: (tasks[i]?.["label"] as string) ?? `task-${i}`,
          success: r.success,
          content: r.content,
          durationMs: r.durationMs,
        }));
      };
    }

    const fakeProfileWith = async () => ({ taxpayerType: "一般纳税人" as const });
    const fakeProfileEmpty = async () => ({});

    const { createRunFilingPrecheckBatchTool } = await import(
      "../lib/agent/mcp-tools/filing-precheck-batch.ts"
    );

    // ── T1: 非法 period → isError，不调 run ─────────────────────────────────────
    {
      calls = [];
      createRunFilingPrecheckBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        readProfile: fakeProfileEmpty,
      });
      const r = await captured.handler!({ period: "2026/06" });
      assert.ok(r.isError, "T1 FAIL: 非法 period 应返回 isError");
      assert.ok(
        r.content[0]?.text.includes("YYYY-MM") || r.content[0]?.text.includes("格式"),
        `T1 FAIL: 错误文本应含格式说明，实际: ${r.content[0]?.text}`
      );
      assert.equal(calls.length, 0, "T1 FAIL: 非法 period 不应调用 run");
      console.log("filing-precheck-batch T1: 非法 period ✓");
    }

    // ── T2: 默认 period（空 args）→ 使用当前年月 ───────────────────────────────────
    {
      calls = [];
      createRunFilingPrecheckBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "增值税复核完成", durationMs: 1000 },
          { success: true, content: "个税复核完成", durationMs: 800 },
        ]) as never,
        readProfile: fakeProfileWith,
      });
      const r = await captured.handler!({});
      assert.ok(!r.isError, `T2 FAIL: 默认 period 应成功，实际: ${JSON.stringify(r.content[0])}`);
      assert.equal(calls.length, 1, "T2 FAIL: 应调用一次 run");
      const tasks = calls[0].tasks;
      assert.match(
        tasks[0]?.["period"] as string,
        /^\d{4}-\d{2}$/,
        "T2 FAIL: 默认期间格式应为 YYYY-MM"
      );
      console.log("filing-precheck-batch T2: 默认 period ✓");
    }

    // ── T3: 显式 period + 任务参数正确 ─────────────────────────────────────────────
    {
      calls = [];
      createRunFilingPrecheckBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "VAT done", durationMs: 500 },
          { success: true, content: "IIT done", durationMs: 500 },
        ]) as never,
        readProfile: fakeProfileWith,
      });
      const r = await captured.handler!({ period: "2026-07" });
      assert.ok(!r.isError, `T3 FAIL: 显式 period 应成功，实际: ${JSON.stringify(r.content[0])}`);
      assert.equal(calls.length, 1, "T3 FAIL: 应调用一次 run");
      const tasks = calls[0].tasks;
      assert.equal(tasks.length, 2, "T3 FAIL: 应有 2 个子任务");
      // 任务 0：vat-filing-precheck
      assert.equal(tasks[0]?.["roleId"], "tax-officer", "T3 FAIL: 任务 0 roleId");
      assert.equal(tasks[0]?.["taskTemplateId"], "vat-filing-precheck", "T3 FAIL: 任务 0 taskTemplateId");
      assert.equal(tasks[0]?.["businessObject"], "增值税及附加", "T3 FAIL: 任务 0 businessObject");
      assert.equal(tasks[0]?.["period"], "2026-07", "T3 FAIL: 任务 0 period");
      // 任务 1：iit-filing-precheck
      assert.equal(tasks[1]?.["roleId"], "tax-officer", "T3 FAIL: 任务 1 roleId");
      assert.equal(tasks[1]?.["taskTemplateId"], "iit-filing-precheck", "T3 FAIL: 任务 1 taskTemplateId");
      assert.equal(tasks[1]?.["businessObject"], "个税", "T3 FAIL: 任务 1 businessObject");
      assert.equal(tasks[1]?.["period"], "2026-07", "T3 FAIL: 任务 1 period");
      console.log("filing-precheck-batch T3: 显式 period + 任务参数正确 ✓");
    }

    // ── T4: 双成功 → 无 isError，包含看板提示 ──────────────────────────────────────
    {
      calls = [];
      createRunFilingPrecheckBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "VAT done", durationMs: 500 },
          { success: true, content: "IIT done", durationMs: 500 },
        ]) as never,
        readProfile: fakeProfileEmpty,
      });
      const r = await captured.handler!({ period: "2026-07" });
      assert.ok(!r.isError, `T4 FAIL: 双成功不应设 isError，实际 isError=${r.isError}`);
      assert.ok(
        r.content[0]?.text.includes("看板") || r.content[0]?.text.includes("锁定"),
        `T4 FAIL: 应有看板/锁定提示，实际: ${r.content[0]?.text.slice(0, 100)}`
      );
      console.log("filing-precheck-batch T4: 双成功无 isError ✓");
    }

    // ── T5: 一成一败 → 无 isError（部分成功要能转述已完成的一半）──────────────────
    {
      calls = [];
      createRunFilingPrecheckBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "VAT done", durationMs: 500 },
          { success: false, content: "IIT error detail", durationMs: 200 },
        ]) as never,
        readProfile: fakeProfileEmpty,
      });
      const r = await captured.handler!({ period: "2026-07" });
      assert.ok(!r.isError, `T5 FAIL: 一成一败不应设 isError（部分成功），实际 isError=${r.isError}`);
      assert.ok(
        r.content[0]?.text.includes("IIT error detail") || r.content[0]?.text.includes("失败"),
        `T5 FAIL: 结果文本应包含失败信息，实际: ${r.content[0]?.text.slice(0, 100)}`
      );
      console.log("filing-precheck-batch T5: 一成一败无 isError ✓");
    }

    // ── T6: 双失败 → isError ────────────────────────────────────────────────────────
    {
      calls = [];
      createRunFilingPrecheckBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: false, content: "VAT error", durationMs: 200 },
          { success: false, content: "IIT error", durationMs: 200 },
        ]) as never,
        readProfile: fakeProfileEmpty,
      });
      const r = await captured.handler!({ period: "2026-07" });
      assert.ok(r.isError, `T6 FAIL: 双失败应设 isError，实际 isError=${r.isError}`);
      console.log("filing-precheck-batch T6: 双失败设 isError ✓");
    }

    console.log("filing-precheck-batch: 工具六条路径全部通过 ✓");
  }

  // ─── TOOL_REGISTRY 登记存在且 riskLevel=safe ──────────────────────────────────
  {
    const { TOOL_REGISTRY, getToolRiskLevel } = await import("../lib/agent/tools/registry.ts");
    const toolName = "mcp__finance_worker__run_filing_precheck_batch";
    assert.ok(
      TOOL_REGISTRY.some((t) => t.name === toolName),
      `T-registry FAIL: ${toolName} 不在 TOOL_REGISTRY`
    );
    assert.equal(
      getToolRiskLevel(toolName),
      "safe",
      `T-registry FAIL: ${toolName} riskLevel 应为 safe`
    );
    console.log("filing-precheck-batch: TOOL_REGISTRY 登记 ✓");
  }

  console.log("filing-precheck-batch: all tests ✓");
})();
