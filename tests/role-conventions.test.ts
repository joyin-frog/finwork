/**
 * role-conventions.test.ts — 刀6 记忆自动沉淀（remember_role_convention）
 *
 * 覆盖：
 * - RC-1 工具静默写入 role_memory（roleId/text/source 落库正确）
 * - RC-2 角色隔离：写 payroll-officer 不出现在 tax-officer 记忆里
 * - RC-3 未知 roleId → isError，不写库
 * - RC-4 去重：同角色同内容二次调用不重复写入
 * - RC-5 成员契约：两个记忆工具都在 ALLOWED_TOOLS（静默自动放行）、不在 ALWAYS_CONFIRM_TOOLS
 * - RC-6 对话流轻提示：getToolSummary 渲染「记住口径 + 角色名」
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/role-conventions.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const roleConventionsTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fa-role-conv-"));
  const dbPath = path.join(dir, "test.db");
  const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  try {
    // getDb() 按 FINANCE_AGENT_DB_PATH 切换单例（参照 tests/chat-feedback.test.ts）
    const { listRoleMemory } = await import("../lib/db/role-memory-store.ts");

    // mock SDK（与 business-metrics-source.test.ts 保持一致）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captured: Record<string, any> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSdk: any = {
      tool: (name: string, _desc: string | string[], _schema: unknown, handler: unknown) => {
        captured[name] = handler;
        return { name };
      },
    };
    const { createRememberRoleConventionTool } = await import("../lib/agent/mcp-tools/role-conventions.ts");
    createRememberRoleConventionTool(mockSdk);
    const handler = captured["remember_role_convention"];
    assert.ok(typeof handler === "function", "RC-1 FAIL: remember_role_convention handler 应注册");

    // ── RC-1: 静默写入 role_memory ─────────────────────────────────────────
    const r1 = await handler({ roleId: "payroll-officer", text: "实习生按劳务报酬算个税", source: "6月算薪复核" });
    assert.ok(!r1.isError, `RC-1 FAIL: 合法写入不应报错: ${JSON.stringify(r1.content)}`);
    assert.match(r1.content[0].text, /已记住这条口径/, "RC-1 FAIL: 返回文案应含轻提示「已记住这条口径」");
    const payrollMems = listRoleMemory("payroll-officer");
    assert.equal(payrollMems.length, 1, "RC-1 FAIL: payroll-officer 应有 1 条记忆");
    assert.equal(payrollMems[0].content, "实习生按劳务报酬算个税", "RC-1 FAIL: content 落库不符");
    assert.equal(payrollMems[0].source, "6月算薪复核", "RC-1 FAIL: source 落库不符");

    // ── RC-2: 角色隔离 ────────────────────────────────────────────────────
    assert.equal(listRoleMemory("tax-officer").length, 0, "RC-2 FAIL: tax-officer 不应看到 payroll-officer 的记忆");

    // ── RC-3: 未知 roleId → isError 且不写库 ──────────────────────────────
    const r3 = await handler({ roleId: "no-such-role", text: "某口径", source: "测试" });
    assert.ok(r3.isError, "RC-3 FAIL: 未知角色应报错");
    assert.equal(listRoleMemory("payroll-officer").length, 1, "RC-3 FAIL: 报错不应产生写入");

    // ── RC-4: 同角色同内容去重 ────────────────────────────────────────────
    const r4 = await handler({ roleId: "payroll-officer", text: "实习生按劳务报酬算个税", source: "7月又确认了一次" });
    assert.ok(!r4.isError, "RC-4 FAIL: 重复写入不应报错");
    assert.match(r4.content[0].text, /已有这条口径/, "RC-4 FAIL: 重复内容应提示已存在");
    assert.equal(listRoleMemory("payroll-officer").length, 1, "RC-4 FAIL: 相同内容不应重复落库");

    // ── RC-5: 成员契约（记忆写入静默 = 自动放行，不挂确认门）──────────────
    const { ALLOWED_TOOLS } = await import("../lib/agent/tools/registry.ts");
    const { ALWAYS_CONFIRM_TOOLS } = await import("../lib/agent/hooks/built-in.ts");
    for (const name of ["mcp__finance_worker__remember_convention", "mcp__finance_worker__remember_role_convention"]) {
      assert.ok(ALLOWED_TOOLS.includes(name), `RC-5 FAIL: ${name} 应在 ALLOWED_TOOLS（静默自动放行）`);
      assert.ok(!ALWAYS_CONFIRM_TOOLS.has(name), `RC-5 FAIL: ${name} 不应在 ALWAYS_CONFIRM_TOOLS`);
    }

    // ── RC-6: 对话流轻提示渲染 ────────────────────────────────────────────
    const { getToolSummary } = await import("../lib/agent/tools/renderers.ts");
    const summary = getToolSummary("mcp__finance_worker__remember_role_convention", {
      roleId: "payroll-officer",
      text: "实习生按劳务报酬算个税",
      source: "6月算薪复核",
    });
    assert.match(summary, /记住口径/, "RC-6 FAIL: 摘要应含「记住口径」");
    assert.match(summary, /薪税/, "RC-6 FAIL: 摘要应含角色名（薪税）");

    console.log("role-conventions: RC-1..RC-6 all passed ✓");
  } finally {
    if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
})();
