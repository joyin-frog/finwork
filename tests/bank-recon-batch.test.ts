/**
 * bank-recon-batch 测试（spec-bank-recon-batch §3 步骤 4）
 *
 * 覆盖：
 * - 模板属性与关键约束字样（"逐笔列出"、"缺账面"、direction 口径句）
 * - 角色白名单不含批跑工具（所有角色）
 * - 工具 description 含分流指引（"单账户"）与额度提示（"派发额度"）
 * - 五条失败校验路径（空列表、超限、period 非法、文件不存在、book_file 冲突）
 * - fan-out：2 文件 + book_file → 2 个 task，各属性断言；1 文件无 book_file → files 只含流水
 * - 聚合：双成功文本含账户名；一成一败不置 isError；双败置 isError
 * - 注册链：TOOL_REGISTRY 存在且 safe；各角色 resolveRoleAllowedTools 不含
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/bank-recon-batch.test.ts
 */

import assert from "node:assert/strict";
import { TASK_TEMPLATES } from "../lib/agent/roles/task-templates.ts";
import { resolveRoleAllowedTools } from "../lib/agent/roles/registry.ts";

export const bankReconBatchTestPromise = (async () => {

  // ─── 模板属性与关键约束字样 ──────────────────────────────────────────────────────
  {
    const tmpl = TASK_TEMPLATES.find((t) => t.id === "bank-recon");
    assert.ok(tmpl, "T-tmpl FAIL: bank-recon 模板不存在");
    assert.equal(tmpl!.roleId, "treasury-officer", "T-tmpl FAIL: bank-recon 应归属 treasury-officer");
    assert.equal(tmpl!.mode, "subagent", "T-tmpl FAIL: bank-recon mode 应为 subagent");
    assert.ok(tmpl!.objectLabel, "T-tmpl FAIL: bank-recon 应有 objectLabel");
    assert.ok(tmpl!.needsFiles, "T-tmpl FAIL: bank-recon 应设 needsFiles=true");
    assert.ok(
      tmpl!.promptTemplate?.includes("{{period}}"),
      "T-tmpl FAIL: bank-recon promptTemplate 应含 {{period}}"
    );

    // 关键约束字样：对不上逐笔列出
    assert.ok(
      tmpl!.promptTemplate?.includes("逐笔列出"),
      "T-tmpl FAIL: bank-recon promptTemplate 应含「逐笔列出」边界句"
    );

    // 关键约束字样：缺账面降级路径
    assert.ok(
      tmpl!.promptTemplate?.includes("缺账面"),
      "T-tmpl FAIL: bank-recon promptTemplate 应含「缺账面」降级路径描述"
    );

    // direction 口径句：模板须写明 "in" 和 "out" 作为枚举值
    assert.ok(
      tmpl!.promptTemplate?.includes('"in"') && tmpl!.promptTemplate?.includes('"out"'),
      "T-tmpl FAIL: bank-recon promptTemplate 应包含 direction 枚举口径句（\"in\" 和 \"out\"）"
    );

    // 一切只读
    assert.ok(
      tmpl!.promptTemplate?.includes("只读"),
      "T-tmpl FAIL: bank-recon promptTemplate 应含「只读」边界声明"
    );

    console.log("bank-recon-batch: 模板属性与关键约束字样 ✓");
  }

  // ─── 角色白名单不含批跑工具 ────────────────────────────────────────────────────
  {
    const toolFullName = "mcp__finance_worker__run_bank_recon_batch";
    const allRoleIds = ["tax-officer", "bookkeeper", "payroll-officer", "treasury-officer", "receivables-officer", "analyst"];
    for (const roleId of allRoleIds) {
      const tools = resolveRoleAllowedTools(roleId);
      assert.ok(
        !tools.includes(toolFullName),
        `T-whitelist FAIL: ${roleId} 的白名单不应含 ${toolFullName}`
      );
    }
    console.log("bank-recon-batch: 角色白名单不含批跑工具 ✓");
  }

  // ─── 工具路径测试（注入 deps 隔离 LLM） ──────────────────────────────────────
  {
    type ToolResult = {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

    const captured: { handler?: Handler; description?: string } = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSdk: any = {
      tool: (_name: string, desc: string, _schema: unknown, h: unknown) => {
        captured.description = desc;
        captured.handler = h as Handler;
        return {};
      },
    };

    type CallRecord = { tasks: Array<Record<string, unknown>>; opts: Record<string, unknown> };
    let calls: CallRecord[] = [];

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

    // fake fileExists：控制哪些路径"存在"
    function makeFileExists(existPaths: string[]) {
      return (p: string) => existPaths.includes(p);
    }

    const { createRunBankReconBatchTool } = await import(
      "../lib/agent/mcp-tools/bank-recon-batch.ts"
    );

    // ── description 内容断言（先构造一次捕获） ─────────────────────────────────
    {
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        fileExists: makeFileExists([]),
      });
      assert.ok(
        captured.description?.includes("单账户"),
        `T-desc FAIL: description 应含「单账户」分流指引，实际: ${captured.description}`
      );
      assert.ok(
        captured.description?.includes("派发额度"),
        `T-desc FAIL: description 应含「派发额度」字样，实际: ${captured.description}`
      );
      console.log("bank-recon-batch T-desc: description 分流指引 ✓");
    }

    // ── T1: statement_files 为空 → isError，不派发 ──────────────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        fileExists: makeFileExists([]),
      });
      const r = await captured.handler!({ statement_files: [] });
      assert.ok(r.isError, "T1 FAIL: 空 statement_files 应返回 isError");
      assert.equal(calls.length, 0, "T1 FAIL: 空列表不应调用 run");
      console.log("bank-recon-batch T1: 空列表校验 ✓");
    }

    // ── T2: statement_files 超过 8 个 → isError，不派发 ────────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        fileExists: makeFileExists([]),
      });
      const nineFiles = Array.from({ length: 9 }, (_, i) => `/files/acct${i}.xlsx`);
      const r = await captured.handler!({ statement_files: nineFiles });
      assert.ok(r.isError, "T2 FAIL: 9 个文件应返回 isError");
      assert.equal(calls.length, 0, "T2 FAIL: 超限不应调用 run");
      console.log("bank-recon-batch T2: 超限校验 ✓");
    }

    // ── T3: period 非法 → isError，不派发 ────────────────────────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        fileExists: makeFileExists(["/files/acct1.xlsx"]),
      });
      const r = await captured.handler!({ statement_files: ["/files/acct1.xlsx"], period: "2026/06" });
      assert.ok(r.isError, "T3 FAIL: 非法 period 应返回 isError");
      assert.ok(
        r.content[0]?.text.includes("YYYY-MM") || r.content[0]?.text.includes("格式"),
        `T3 FAIL: 错误文本应含格式说明，实际: ${r.content[0]?.text}`
      );
      assert.equal(calls.length, 0, "T3 FAIL: 非法 period 不应调用 run");
      console.log("bank-recon-batch T3: period 格式校验 ✓");
    }

    // ── T4: 文件不存在 → isError，列出缺失路径，整批不派发 ──────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        fileExists: makeFileExists(["/files/acct1.xlsx"]), // acct2.xlsx 不存在
      });
      const r = await captured.handler!({
        statement_files: ["/files/acct1.xlsx", "/files/acct2.xlsx"],
        period: "2026-07",
      });
      assert.ok(r.isError, "T4 FAIL: 文件不存在应返回 isError");
      assert.ok(
        r.content[0]?.text.includes("/files/acct2.xlsx"),
        `T4 FAIL: 错误文本应列出缺失路径，实际: ${r.content[0]?.text}`
      );
      assert.equal(calls.length, 0, "T4 FAIL: 文件不存在不应调用 run");
      console.log("bank-recon-batch T4: 文件不存在校验 ✓");
    }

    // ── T5: book_file 与 statement_files 冲突 → isError，不派发 ────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([]) as never,
        fileExists: makeFileExists(["/files/acct1.xlsx"]),
      });
      const r = await captured.handler!({
        statement_files: ["/files/acct1.xlsx"],
        book_file: "/files/acct1.xlsx",
        period: "2026-07",
      });
      assert.ok(r.isError, "T5 FAIL: book_file 冲突应返回 isError");
      assert.equal(calls.length, 0, "T5 FAIL: book_file 冲突不应调用 run");
      console.log("bank-recon-batch T5: book_file 冲突校验 ✓");
    }

    // ── T6: fan-out 2 文件 + book_file → 2 个 task，属性断言 ────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "acct1 对账完成", durationMs: 800 },
          { success: true, content: "acct2 对账完成", durationMs: 900 },
        ]) as never,
        fileExists: makeFileExists(["/files/acct1.xlsx", "/files/acct2.xlsx", "/files/book.xlsx"]),
      });
      const r = await captured.handler!({
        statement_files: ["/files/acct1.xlsx", "/files/acct2.xlsx"],
        book_file: "/files/book.xlsx",
        period: "2026-07",
      });
      assert.ok(!r.isError, `T6 FAIL: 双成功不应 isError，实际: ${JSON.stringify(r.content[0])}`);
      assert.equal(calls.length, 1, "T6 FAIL: 应调用一次 run");
      const tasks = calls[0].tasks;
      assert.equal(tasks.length, 2, "T6 FAIL: 应有 2 个子任务");

      // task 0
      assert.equal(tasks[0]?.["roleId"], "treasury-officer", "T6 FAIL: task[0] roleId");
      assert.equal(tasks[0]?.["taskTemplateId"], "bank-recon", "T6 FAIL: task[0] taskTemplateId");
      assert.equal(tasks[0]?.["businessObject"], "acct1", "T6 FAIL: task[0] businessObject");
      assert.equal(tasks[0]?.["period"], "2026-07", "T6 FAIL: task[0] period");
      assert.deepEqual(
        tasks[0]?.["files"],
        ["/files/acct1.xlsx", "/files/book.xlsx"],
        "T6 FAIL: task[0] files 应含流水+账面"
      );
      assert.ok(
        (tasks[0]?.["instructions"] as string)?.includes("本卡只负责账户流水文件：/files/acct1.xlsx"),
        "T6 FAIL: task[0] instructions 应含文件路径 extra"
      );
      assert.ok(
        (tasks[0]?.["instructions"] as string)?.includes("/files/book.xlsx"),
        "T6 FAIL: task[0] instructions 应含账面文件路径"
      );

      // task 1
      assert.equal(tasks[1]?.["roleId"], "treasury-officer", "T6 FAIL: task[1] roleId");
      assert.equal(tasks[1]?.["taskTemplateId"], "bank-recon", "T6 FAIL: task[1] taskTemplateId");
      assert.equal(tasks[1]?.["businessObject"], "acct2", "T6 FAIL: task[1] businessObject");
      assert.equal(tasks[1]?.["period"], "2026-07", "T6 FAIL: task[1] period");
      assert.deepEqual(
        tasks[1]?.["files"],
        ["/files/acct2.xlsx", "/files/book.xlsx"],
        "T6 FAIL: task[1] files 应含流水+账面"
      );
      assert.ok(
        (tasks[1]?.["instructions"] as string)?.includes("本卡只负责账户流水文件：/files/acct2.xlsx"),
        "T6 FAIL: task[1] instructions 应含文件路径 extra"
      );

      // label（spec：银行对账·<businessObject>）
      assert.equal(tasks[0]?.["label"], "银行对账·acct1", "T6 FAIL: task[0] label");
      assert.equal(tasks[1]?.["label"], "银行对账·acct2", "T6 FAIL: task[1] label");

      // 聚合末尾提示看板与锁定
      assert.ok(
        r.content[0]?.text.includes("看板") && r.content[0]?.text.includes("锁定"),
        "T6 FAIL: 聚合文本末尾应含看板与锁定提示"
      );

      // 双成功文本含账户名
      assert.ok(
        r.content[0]?.text.includes("acct1"),
        `T6 FAIL: 结果文本应含账户名 acct1，实际: ${r.content[0]?.text.slice(0, 100)}`
      );
      assert.ok(
        r.content[0]?.text.includes("acct2"),
        `T6 FAIL: 结果文本应含账户名 acct2，实际: ${r.content[0]?.text.slice(0, 100)}`
      );

      console.log("bank-recon-batch T6: fan-out 2 文件 + book_file ✓");
    }

    // ── T7: 1 文件无 book_file → files 只含流水、extra 含「未提供账面」 ────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "对账完成", durationMs: 600 },
        ]) as never,
        fileExists: makeFileExists(["/files/solo.xlsx"]),
      });
      await captured.handler!({
        statement_files: ["/files/solo.xlsx"],
        period: "2026-07",
      });
      assert.equal(calls.length, 1, "T7 FAIL: 应调用一次 run");
      const tasks = calls[0].tasks;
      assert.equal(tasks.length, 1, "T7 FAIL: 应有 1 个子任务");
      assert.deepEqual(
        tasks[0]?.["files"],
        ["/files/solo.xlsx"],
        "T7 FAIL: 无 book_file 时 files 应只含流水文件"
      );
      assert.ok(
        (tasks[0]?.["instructions"] as string)?.includes("未提供账面"),
        "T7 FAIL: 无 book_file 时 extra 应含「未提供账面」"
      );
      console.log("bank-recon-batch T7: 1 文件无 book_file ✓");
    }

    // ── T8: 一成一败 → 不置 isError ───────────────────────────────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: true, content: "acct1 done", durationMs: 500 },
          { success: false, content: "acct2 error detail", durationMs: 200 },
        ]) as never,
        fileExists: makeFileExists(["/files/acct1.xlsx", "/files/acct2.xlsx"]),
      });
      const r = await captured.handler!({
        statement_files: ["/files/acct1.xlsx", "/files/acct2.xlsx"],
        period: "2026-07",
      });
      assert.ok(!r.isError, `T8 FAIL: 一成一败不应置 isError，实际 isError=${r.isError}`);
      assert.ok(
        r.content[0]?.text.includes("acct2 error detail") || r.content[0]?.text.includes("失败"),
        `T8 FAIL: 结果文本应含失败信息，实际: ${r.content[0]?.text.slice(0, 100)}`
      );
      console.log("bank-recon-batch T8: 一成一败不置 isError ✓");
    }

    // ── T9: 双败 → 置 isError ─────────────────────────────────────────────────────
    {
      calls = [];
      createRunBankReconBatchTool(mockSdk, "/tmp/test", undefined, undefined, undefined, {
        run: makeFakeRun([
          { success: false, content: "acct1 error", durationMs: 200 },
          { success: false, content: "acct2 error", durationMs: 200 },
        ]) as never,
        fileExists: makeFileExists(["/files/acct1.xlsx", "/files/acct2.xlsx"]),
      });
      const r = await captured.handler!({
        statement_files: ["/files/acct1.xlsx", "/files/acct2.xlsx"],
        period: "2026-07",
      });
      assert.ok(r.isError, `T9 FAIL: 双败应置 isError，实际 isError=${r.isError}`);
      console.log("bank-recon-batch T9: 双败置 isError ✓");
    }

    console.log("bank-recon-batch: 工具路径全部通过 ✓");
  }

  // ─── TOOL_REGISTRY 登记存在且 riskLevel=safe ──────────────────────────────────
  {
    const { TOOL_REGISTRY, getToolRiskLevel } = await import("../lib/agent/tools/registry.ts");
    const toolName = "mcp__finance_worker__run_bank_recon_batch";
    assert.ok(
      TOOL_REGISTRY.some((t) => t.name === toolName),
      `T-registry FAIL: ${toolName} 不在 TOOL_REGISTRY`
    );
    assert.equal(
      getToolRiskLevel(toolName),
      "safe",
      `T-registry FAIL: ${toolName} riskLevel 应为 safe`
    );
    console.log("bank-recon-batch: TOOL_REGISTRY 登记 ✓");
  }

  console.log("bank-recon-batch: all tests ✓");
})();
