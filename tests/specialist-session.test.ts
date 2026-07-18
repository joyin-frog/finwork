/**
 * specialist-session.test.ts — 刀7 专员会话（E1-E6）
 *
 * 覆盖：
 * - SS-1 resolveRoleScopeTools：⊇ resolveRoleAllowedTools；含角色域内高风险工具；不含 spawn_subagent
 * - SS-2 role-scope hook：域外 MCP 工具 deny（含 spawn_subagent、他角色工具）；域内放行；内置工具穿透
 * - SS-3 域内高风险工具在专员会话可走确认门：有 resolver 确认→allow，无 resolver→deny（fail-closed）
 * - SS-4 buildSpecialistChatSystemPrompt：交互式 A 段（可提问）+ 角色 B 段 + 记忆段；无子代理"不能提问"纪律
 * - SS-5 会话角色维度落库：createChatConversation(roleId) → getChatConversation 回读；
 *        listConversationsForRole 并出直聊会话（isDirect）与派发会话
 * - SS-6 源码契约：/chat/new 支持 role 参数；claude-adapter 按 roleId 分支装配；routerStage 跳过专员会话
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/specialist-session.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveRoleAllowedTools, resolveRoleScopeTools } from "../lib/agent/roles/registry.ts";
import { createRoleScopeHook, createRiskConfirmHook } from "../lib/agent/hooks/built-in.ts";
import { runBeforeHooks } from "../lib/agent/hooks/chain.ts";
import { buildSpecialistChatSystemPrompt, buildSubagentSystemPrompt } from "../lib/agent/subagent-runner.ts";
import { getRoleDefinition } from "../lib/agent/roles/registry.ts";

export const specialistSessionTestPromise = (async () => {
  // ── SS-1: 角色域工具全集 ─────────────────────────────────────────────────
  const payrollScope = resolveRoleScopeTools("payroll-officer");
  const payrollAllowed = resolveRoleAllowedTools("payroll-officer");
  for (const t of payrollAllowed) {
    assert.ok(payrollScope.includes(t), `SS-1 FAIL: scope 应 ⊇ allowed，缺 ${t}`);
  }
  assert.ok(
    payrollScope.includes("mcp__finance_worker__calculate_payroll_batch"),
    "SS-1 FAIL: 薪税域 scope 应含高风险的 calculate_payroll_batch（专员会话经确认卡执行）"
  );
  assert.ok(
    !payrollAllowed.includes("mcp__finance_worker__calculate_payroll_batch"),
    "SS-1 FAIL: allowed（免确认名单）不应含高风险工具"
  );
  assert.ok(
    !payrollScope.includes("mcp__finance_worker__spawn_subagent"),
    "SS-1 FAIL: 角色 scope 不应含 spawn_subagent（不越级）"
  );

  // ── SS-2: role-scope hook 边界 ───────────────────────────────────────────
  const ctxFor = (toolName: string, resolveUserQuestion?: (q: { question: string }) => Promise<string>) =>
    ({ toolName, input: {}, outputDir: "/tmp", resolveUserQuestion });
  const scopeChain = [createRoleScopeHook("payroll-officer")];

  const denySpawn = await runBeforeHooks(scopeChain, ctxFor("mcp__finance_worker__spawn_subagent"));
  assert.equal(denySpawn.behavior, "deny", "SS-2 FAIL: spawn_subagent 必须 deny（专员不越级）");

  const denyForeign = await runBeforeHooks(scopeChain, ctxFor("mcp__kingdee_worker__export_kingdee_draft"));
  assert.equal(denyForeign.behavior, "deny", "SS-2 FAIL: 他角色域工具（导金蝶）应 deny");
  assert.match(denyForeign.message ?? "", /职责|边界/, "SS-2 FAIL: deny 文案应说明职责边界");

  const allowInScope = await runBeforeHooks(scopeChain, ctxFor("mcp__finance_worker__query_payroll_status"));
  assert.equal(allowInScope.behavior, "allow", "SS-2 FAIL: 域内工具应放行");

  const allowBuiltin = await runBeforeHooks(scopeChain, ctxFor("Read"));
  assert.equal(allowBuiltin.behavior, "allow", "SS-2 FAIL: 内置工具应穿透 role-scope（由既有闸管）");

  // 记忆沉淀（C2×E6）：本角色放行、写他角记忆必拦（roleId 是模型参数，不锁则破坏 C1 隔离）
  const memTool = "mcp__finance_worker__remember_role_convention";
  const allowOwnMemory = await runBeforeHooks(scopeChain, {
    toolName: memTool, input: { roleId: "payroll-officer", text: "口径", source: "测试" }, outputDir: "/tmp",
  });
  assert.equal(allowOwnMemory.behavior, "allow", "SS-2 FAIL: 专员写本角色记忆应放行（静默沉淀）");
  const denyForeignMemory = await runBeforeHooks(scopeChain, {
    toolName: memTool, input: { roleId: "tax-officer", text: "口径", source: "测试" }, outputDir: "/tmp",
  });
  assert.equal(denyForeignMemory.behavior, "deny", "SS-2 FAIL: 专员写他角色记忆必须 deny");

  // ── SS-3: 域内高风险工具走确认门（role-scope 在前、risk-confirm 在后，与 adapter 链序一致）──
  const fullChain = [createRoleScopeHook("payroll-officer"), createRiskConfirmHook()];
  const confirmed = await runBeforeHooks(fullChain, ctxFor("mcp__finance_worker__calculate_payroll_batch", async () => "确认"));
  assert.equal(confirmed.behavior, "allow", "SS-3 FAIL: 域内高风险工具经用户确认后应放行");
  const noResolver = await runBeforeHooks(fullChain, ctxFor("mcp__finance_worker__calculate_payroll_batch", undefined));
  assert.equal(noResolver.behavior, "deny", "SS-3 FAIL: 无确认通道必须 fail-closed");

  // ── SS-4: 专员会话系统提示 ───────────────────────────────────────────────
  const role = getRoleDefinition("payroll-officer")!;
  const chatPrompt = buildSpecialistChatSystemPrompt(role, ["实习生按劳务报酬算个税"], "/tmp/out");
  assert.ok(chatPrompt.includes("专员会话"), "SS-4 FAIL: 应标明专员会话身份");
  assert.ok(chatPrompt.includes(role.name), "SS-4 FAIL: 应含角色名");
  assert.ok(chatPrompt.includes(role.rolePrompt.slice(0, 20)), "SS-4 FAIL: 应含角色 B 段 rolePrompt");
  assert.ok(chatPrompt.includes("实习生按劳务报酬算个税"), "SS-4 FAIL: 应注入角色记忆");
  assert.ok(chatPrompt.includes("/tmp/out"), "SS-4 FAIL: 应含输出目录");
  assert.ok(!chatPrompt.includes("你没有与用户对话的通道"), "SS-4 FAIL: 不应含子代理'不能提问'纪律");
  assert.ok(chatPrompt.includes("提问"), "SS-4 FAIL: 应鼓励向用户提问（交互式）");
  assert.ok(chatPrompt.includes("remember_role_convention") && chatPrompt.includes(`"${role.id}"`), "SS-4 FAIL: 应含本角色记忆沉淀指引（roleId 固定为本角色）");
  // 财务纪律单一来源：两个 A 段都含同一段落
  const subPrompt = buildSubagentSystemPrompt(role, []);
  assert.ok(chatPrompt.includes("金额、税率、比率一律经工具计算") && subPrompt.includes("金额、税率、比率一律经工具计算"), "SS-4 FAIL: 财务纪律段应两处共用");

  // ── SS-5: 会话角色维度 + B5 并集 ─────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-specialist-"));
    const dbPath = path.join(dir, "test.db");
    const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const { createChatConversation, getChatConversation, listConversationsForRole, listRecentConversationSummaries, getDb } = await import("../lib/db/sqlite.ts");
      getDb(); // 触发初始化+迁移（v19 加 role_id 列）

      const directId = createChatConversation("薪税直聊", "payroll-officer");
      const orchestratorId = createChatConversation("主管会话");
      assert.equal(getChatConversation(directId)?.roleId, "payroll-officer", "SS-5 FAIL: 专员会话 roleId 应回读");
      assert.equal(getChatConversation(orchestratorId)?.roleId, null, "SS-5 FAIL: 主管会话 roleId 应为 null");

      // 派发会话：主管会话里派过薪税
      const { recordDispatchStart } = await import("../lib/db/dispatch-store.ts");
      recordDispatchStart({ roleId: "payroll-officer", label: "算薪任务", conversationId: String(orchestratorId) });

      const rows = listConversationsForRole("payroll-officer", 30);
      const direct = rows.find((r) => r.conversationId === directId);
      const dispatched = rows.find((r) => r.conversationId === orchestratorId);
      assert.ok(direct, "SS-5 FAIL: 直聊会话应出现在相关对话");
      assert.equal(direct!.isDirect, true, "SS-5 FAIL: 直聊会话应标 isDirect");
      assert.ok(direct!.roleIds.includes("payroll-officer"), "SS-5 FAIL: 直聊会话 roleIds 应含本角色");
      assert.ok(dispatched, "SS-5 FAIL: 派发会话应出现在相关对话");
      assert.ok(!dispatched!.isDirect, "SS-5 FAIL: 派发会话不应标 isDirect");
      assert.ok(!listConversationsForRole("tax-officer", 30).some((r) => r.conversationId === directId), "SS-5 FAIL: 直聊会话不应漏进其他角色");

      // 侧栏摘要带 roleId（角色小头像数据源）
      const summaries = listRecentConversationSummaries(10);
      assert.equal(summaries.find((s) => s.id === directId)?.roleId, "payroll-officer", "SS-5 FAIL: 会话摘要应带 roleId");
    } finally {
      if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── SS-6: 源码契约 ───────────────────────────────────────────────────────
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const newPage = read("app/chat/new/page.tsx");
  assert.ok(newPage.includes("role?: string") && newPage.includes("initialRole"), "SS-6 FAIL: /chat/new 应支持 role 参数并传 initialRole");
  const adapter = read("lib/agent/claude-adapter.ts");
  assert.ok(adapter.includes("resolveRoleAllowedTools(specialistRole.id)"), "SS-6 FAIL: adapter 应按角色收窄 allowedTools");
  assert.ok(adapter.includes("buildSpecialistChatSystemPrompt"), "SS-6 FAIL: adapter 应用专员系统提示");
  assert.ok(adapter.includes("createRoleScopeHook"), "SS-6 FAIL: adapter 应挂 role-scope hook");
  const stages = read("lib/agent/query-stages.ts");
  assert.ok(stages.includes("specialist session"), "SS-6 FAIL: routerStage 应跳过专员会话");
  const chatPage = read("app/chat/chat-page.tsx");
  assert.ok(chatPage.includes("工具与数据仅限本角色") && chatPage.includes("专员会话"), "SS-6 FAIL: 会话头部应有专员身份标识");

  console.log("specialist-session: SS-1..SS-6 all passed ✓");
})();
