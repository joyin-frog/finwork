import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFinanceMcpServer } from "../lib/agent/mcp-tools/index.ts";
import { TOOL_REGISTRY, getToolRiskLevel } from "../lib/agent/tools/registry.ts";
import { hasToolSummary } from "../lib/agent/tools/renderers.ts";

export const toolRegistryTestPromise = (async () => {
  // ── T1: 新工具已登记进 TOOL_REGISTRY,风险等级符合 plan ────────────────
  const expectedRisk: Record<string, string> = {
    mcp__finance_worker__calculate_payroll_batch: "high",
    mcp__finance_worker__confirm_payroll_period: "high",
    mcp__finance_worker__check_reimbursement_batch: "safe",
    mcp__finance_worker__record_reimbursement_invoices: "medium",
    mcp__finance_worker__read_expense_policy: "safe",
    mcp__finance_worker__tax_calculator: "safe"
  };
  for (const [name, risk] of Object.entries(expectedRisk)) {
    assert.ok(TOOL_REGISTRY.some((t) => t.name === name), `T1 FAIL: ${name} 不在 TOOL_REGISTRY`);
    assert.equal(getToolRiskLevel(name), risk, `T1 FAIL: ${name} 风险等级应为 ${risk}`);
  }

  // ── T2: 工具真实注册进 finance_worker MCP server(不再是死代码)────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (cfg: { tools: Array<{ name: string }> }) => cfg
  };
  const server = (await createFinanceMcpServer(mockSdk, "/tmp")) as unknown as { tools: Array<{ name: string }> };
  const serverToolNames = server.tools.map((t) => t.name);
  for (const shortName of [
    "calculate_payroll_batch",
    "confirm_payroll_period",
    "check_reimbursement_batch",
    "record_reimbursement_invoices",
    "read_expense_policy",
    "tax_calculator",
    "search_knowledge",
    "query_knowledge",
    "read_file"
  ]) {
    assert.ok(serverToolNames.includes(shortName), `T2 FAIL: ${shortName} 未注册进 finance_worker MCP server`);
  }
  // grep_docs 已被 query_knowledge 取代,不应再存在
  assert.ok(!serverToolNames.includes("grep_docs"), "T2 FAIL: grep_docs 应已裁撤");
  for (const t of TOOL_REGISTRY) {
    assert.notEqual(t.name, "mcp__finance_worker__grep_docs", "T2 FAIL: TOOL_REGISTRY 仍含 grep_docs");
  }

  // ── T3: 5 个业务 skill 已迁移为 agent-skills 下的 SKILL.md(SDK 原生加载,旧 config.json 已退役)──
  for (const skillId of ["payroll-calc", "reimbursement-check", "finance-analysis", "kingdee-draft"]) {
    const md = await readFile(`agent-skills/skills/${skillId}/SKILL.md`, "utf-8");
    assert.match(md, new RegExp(`\\nname:\\s*${skillId}\\b`), `T3 FAIL: agent-skills/skills/${skillId}/SKILL.md 缺 name: ${skillId} frontmatter`);
  }

  // ── T4: tax_calculator 不再提供个税(月度旧税率表必须清除)────────────
  const financeToolsSource = await readFile("lib/agent/mcp-tools/finance-tools.ts", "utf-8");
  assert.ok(!financeToolsSource.includes('"iit"'), "T4 FAIL: tax_calculator 仍含 iit 税种");
  for (const legacyQuickDeduction of ["210", "1410", "2660", "4410", "7160", "15160"]) {
    assert.ok(
      !new RegExp(`deduction: ${legacyQuickDeduction}\\b`).test(financeToolsSource),
      `T4 FAIL: 旧月度速算扣除数 ${legacyQuickDeduction} 残留`
    );
  }
  assert.ok(financeToolsSource.includes("calculate_payroll_batch"), "T4 FAIL: 描述应指引使用累计预扣工具");

  // ── T5: 引擎文件零政策数字(全部在 tax-config.ts)─────────────────────
  const engineSource = await readFile("lib/domain/tax-cumulative.ts", "utf-8");
  for (const policyNumber of ["36000", "144000", "300000", "5000", "2520", "16920"]) {
    assert.ok(!engineSource.includes(policyNumber), `T5 FAIL: 引擎文件含政策数字 ${policyNumber}`);
  }

  // ── T6: registry ↔ renderer 一致性守卫 ─────────────────────────────────
  // 所有 finance 工具必须有中文摘要,防止新工具漏接渲染器
  const bare = (n: string) => n.replace(/^mcp__\w+__/, "");
  for (const t of TOOL_REGISTRY.filter((d) => d.category === "finance")) {
    assert.ok(hasToolSummary(bare(t.name)), `T6 FAIL: finance tool ${t.name} 缺少 renderer summary`);
  }

  // 已实现卡片的工具必须是已登记的 finance 工具
  // (tool-cards.tsx 因 JSX/hugeicons 无法直接 import 进 Node 测试,故此处镜像 TOOLS_WITH_RESULT_CARD)
  const TOOLS_WITH_RESULT_CARD = [
    "calculate_payroll_batch",
    "check_reimbursement_batch",
    "export_kingdee_draft",
    "validate_kingdee_voucher",
  ] as const;
  for (const name of TOOLS_WITH_RESULT_CARD) {
    assert.ok(
      TOOL_REGISTRY.some((d) => bare(d.name) === name && d.category === "finance"),
      `T6 FAIL: card tool ${name} must be a registered finance tool`
    );
  }

  // Known gap (documented): reconcile_bank_statement 已登记、有摘要、输出 structuredContent,
  // 但尚未在 TOOLS_WITH_RESULT_CARD 中——卡片实现作为后续任务跟进。

  console.log("tool-registry: all 6 checks passed ✓");
})();
