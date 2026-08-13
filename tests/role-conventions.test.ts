/**
 * role-conventions.test.ts — 角色口径治理候选（remember_role_convention）
 *
 * 覆盖：
 * - RC-1 工具只写 governed candidate，不写 legacy role_memory
 * - RC-2 角色隔离：payroll-officer 候选不进入 tax-officer 检索
 * - RC-3 未知 roleId → isError，不写库
 * - RC-4 去重：同角色同内容二次调用复用候选
 * - RC-5 成员契约：remember_role_convention 静默（ALLOWED、非 ALWAYS_CONFIRM）；
 *   remember_convention 仍挂确认门（非 ALLOWED、在 ALWAYS_CONFIRM）
 * - RC-6 对话流轻提示：getToolSummary 如实渲染「提交口径候选 + 角色名」
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
    const { getDb } = await import("../lib/db/sqlite.ts");
    const { GovernedMemoryStore } = await import("../lib/memory-v2/index.ts");

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

    // ── RC-1: 只提交候选，不污染 legacy role_memory ───────────────────────
    const r1 = await handler({ roleId: "payroll-officer", text: "实习生按劳务报酬算个税", source: "6月算薪复核" });
    assert.ok(!r1.isError, `RC-1 FAIL: 合法写入不应报错: ${JSON.stringify(r1.content)}`);
    assert.match(r1.content[0].text, /提交口径候选/, "RC-1 FAIL: 返回文案必须说明只是候选");
    assert.match(r1.content[0].text, /审核.*通过前不会进入/, "RC-1 FAIL: 不得暗示候选已经生效");
    assert.equal(listRoleMemory("payroll-officer").length, 0, "RC-1 FAIL: 不得继续写 legacy role_memory");
    const store = new GovernedMemoryStore(getDb());
    const candidateId = r1.structuredContent?.candidateId as string;
    const candidate = store.get(candidateId);
    assert.equal(candidate?.approvalStatus, "candidate", "RC-1 FAIL: 新口径必须停在 candidate");
    assert.equal(candidate?.scope.roleId, "payroll-officer", "RC-1 FAIL: role scope 落库不符");
    assert.deepEqual(candidate?.content, {
      summary: "实习生按劳务报酬算个税",
      source: "6月算薪复核",
      requestedOperation: "add",
    }, "RC-1 FAIL: 候选内容不符");
    assert.deepEqual(store.retrieve({
      principal: { id: "local-user", type: "user", tenantId: "local" },
      tenantId: "local",
      roleId: "payroll-officer",
      entityRefs: [],
      kinds: [],
      maximumSensitivity: "confidential",
      minimumConfidence: 0,
      limit: 20,
      now: new Date().toISOString(),
    }), [], "RC-1 FAIL: 未审批候选不得进入提示词检索");

    // ── RC-2: 角色隔离 ────────────────────────────────────────────────────
    assert.equal(store.findExactSummary({
      summary: "实习生按劳务报酬算个税",
      tenantId: "local",
      roleId: "tax-officer",
    }).length, 0, "RC-2 FAIL: tax-officer 不应看到 payroll-officer 的候选");

    // ── RC-3: 未知 roleId → isError 且不写库 ──────────────────────────────
    const r3 = await handler({ roleId: "no-such-role", text: "某口径", source: "测试" });
    assert.ok(r3.isError, "RC-3 FAIL: 未知角色应报错");
    assert.equal(store.findExactSummary({ summary: "某口径", tenantId: "local", roleId: "no-such-role" }).length, 0,
      "RC-3 FAIL: 报错不应产生候选");

    // ── RC-4: 同角色同内容去重 ────────────────────────────────────────────
    const r4 = await handler({ roleId: "payroll-officer", text: "实习生按劳务报酬算个税", source: "7月又确认了一次" });
    assert.ok(!r4.isError, "RC-4 FAIL: 重复写入不应报错");
    assert.match(r4.content[0].text, /已有相同口径候选/, "RC-4 FAIL: 重复内容应提示已存在");
    assert.equal(r4.structuredContent?.candidateId, candidateId, "RC-4 FAIL: 重复调用应复用确定性候选 ID");
    assert.equal(store.findExactSummary({
      summary: "实习生按劳务报酬算个税",
      tenantId: "local",
      roleId: "payroll-officer",
    }).length, 1, "RC-4 FAIL: 相同内容不应重复落库");

    // ── RC-5: 成员契约（角色口径静默；全局约定仍确认）────────────────────
    const { ALLOWED_TOOLS } = await import("../lib/agent/tools/registry.ts");
    const { ALWAYS_CONFIRM_TOOLS } = await import("../lib/agent/hooks/built-in.ts");
    assert.ok(
      ALLOWED_TOOLS.includes("remember_role_convention"),
      "RC-5 FAIL: remember_role_convention 应在 ALLOWED_TOOLS（静默自动放行）"
    );
    assert.ok(
      !ALWAYS_CONFIRM_TOOLS.has("remember_role_convention"),
      "RC-5 FAIL: remember_role_convention 不应在 ALWAYS_CONFIRM_TOOLS"
    );
    assert.ok(
      !ALLOWED_TOOLS.includes("remember_convention"),
      "RC-5 FAIL: remember_convention 不应在 ALLOWED_TOOLS（须经确认门）"
    );
    assert.ok(
      ALWAYS_CONFIRM_TOOLS.has("remember_convention"),
      "RC-5 FAIL: remember_convention 应在 ALWAYS_CONFIRM_TOOLS"
    );

    // ── RC-6: 对话流轻提示渲染 ────────────────────────────────────────────
    const { getToolSummary } = await import("../lib/agent/tools/renderers.ts");
    const summary = getToolSummary("remember_role_convention", {
      roleId: "payroll-officer",
      text: "实习生按劳务报酬算个税",
      source: "6月算薪复核",
    });
    assert.match(summary, /提交口径候选/, "RC-6 FAIL: 摘要应含「提交口径候选」");
    assert.match(summary, /薪税/, "RC-6 FAIL: 摘要应含角色名（薪税）");

    console.log("role-conventions: RC-1..RC-6 all passed ✓");
  } finally {
    if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
})();
