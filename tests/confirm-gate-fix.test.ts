/**
 * 确认门修复验证（confirm-gate-fix）
 *
 * 守卫：所有内置工具 + 高风险财务工具 + always-confirm 工具不在
 * ALLOWED_TOOLS 中，使 SDK 无法自动放行，确保安全 hook 真正触发。
 *
 * 对应 spec: docs/spec/spec-confirm-gate-fix.md §1 成功标准
 */
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, BUILTIN_TOOLS, TOOL_REGISTRY } from "../lib/agent/tools/registry.ts";
import { ALWAYS_CONFIRM_TOOLS } from "../lib/agent/hooks/built-in.ts";
import { resolveRoleAllowedTools } from "../lib/agent/roles/registry.ts";

const allowedSet = new Set(ALLOWED_TOOLS);

export const confirmGateFixTestPromise = (async () => {
  // ── CGF-1: 红线工具 / always-confirm 工具不在 ALLOWED_TOOLS 中 ─────────
  const mustExclude = [
    "mcp__finance_worker__calculate_payroll_batch",
    "mcp__finance_worker__confirm_payroll_period",
    "mcp__kingdee_worker__export_kingdee_draft",
    "mcp__finance_worker__remember_convention",
    "mcp__finance_worker__update_company_profile",
  ];
  for (const name of mustExclude) {
    assert.ok(
      !allowedSet.has(name),
      `CGF-1 FAIL: "${name}" 不应在 ALLOWED_TOOLS 中（高风险/always-confirm 工具必须经确认门）`
    );
  }

  for (const name of BUILTIN_TOOLS) {
    assert.ok(
      !allowedSet.has(name),
      `CGF-1b FAIL: 内置工具 "${name}" 不应在 ALLOWED_TOOLS 中（必须经过原生 PreToolUse 机制闸）`
    );
  }

  // ── CGF-2: 非确认工具仍在 ALLOWED_TOOLS 中（保证正常功能不退化）────────
  const mustInclude = [
    "mcp__finance_worker__query_payroll_status",
    "mcp__finance_worker__diff_payroll_period",
    // 角色口径（刀6）静默写入；全局约定仍挂确认门（见 mustExclude / ALWAYS_CONFIRM）
    "mcp__finance_worker__remember_role_convention",
  ];
  for (const name of mustInclude) {
    assert.ok(
      allowedSet.has(name),
      `CGF-2 FAIL: "${name}" 应在 ALLOWED_TOOLS 中（非确认工具不应被误排除）`
    );
  }
  assert.ok(
    !allowedSet.has("mcp__finance_worker__remember_convention"),
    "CGF-2c FAIL: remember_convention 应挂确认门，不应在 ALLOWED_TOOLS 中"
  );

  // run_python 由 risk-confirm 默认放行，但仍须走 PreToolUse（stuck-guard 等），故不进 ALLOWED_TOOLS。
  assert.ok(
    !allowedSet.has("mcp__finance_worker__run_python"),
    "CGF-2b FAIL: run_python 不应在 ALLOWED_TOOLS 中（须经 hook 链，即使确认门已默认放行）"
  );

  // ── CGF-3: 无漂移守卫（交叉一致性校验）──────────────────────────────────
  // 3a: TOOL_REGISTRY 中所有 high-finance 工具均不在 ALLOWED_TOOLS
  const highFinanceTools = TOOL_REGISTRY.filter(
    (t) => t.riskLevel === "high" && t.category === "finance"
  );
  for (const t of highFinanceTools) {
    assert.ok(
      !allowedSet.has(t.name),
      `CGF-3a FAIL: TOOL_REGISTRY 中高风险财务工具 "${t.name}" 仍在 ALLOWED_TOOLS。` +
      `新增高风险财务工具时必须同时确认不会漏进 allowedTools。`
    );
  }
  // 3b: built-in.ALWAYS_CONFIRM_TOOLS 中每个成员均不在 ALLOWED_TOOLS
  // 这是对 registry 内联名单（CONFIRM_REQUIRED_TOOL_NAMES）与 built-in 真源的交叉一致性校验。
  // 若两者漂移（built-in 新增了 always-confirm 工具而 registry 内联名单未同步），此处会红。
  for (const name of ALWAYS_CONFIRM_TOOLS) {
    assert.ok(
      !allowedSet.has(name),
      `CGF-3b FAIL: built-in.ALWAYS_CONFIRM_TOOLS 中的 "${name}" 仍在 ALLOWED_TOOLS。` +
      `registry.ts 的 CONFIRM_REQUIRED_TOOL_NAMES 与 built-in.ALWAYS_CONFIRM_TOOLS 已漂移，请同步。`
    );
  }

  // ── CGF-4: 子代理路径 —— payroll-officer resolved tools 不含 calculate_payroll_batch ──
  // 修复后 ALLOWED_TOOLS 不再含 calculate_payroll_batch，resolveRoleAllowedTools 结果
  // 同步落出（G4d 守卫：resolved tools ⊆ ALLOWED_TOOLS）。
  const payrollOfficerTools = resolveRoleAllowedTools("payroll-officer");
  assert.ok(
    !payrollOfficerTools.includes("mcp__finance_worker__calculate_payroll_batch"),
    `CGF-4 FAIL: payroll-officer resolved tools 仍含 calculate_payroll_batch，子代理确认门路径未生效`
  );

  console.log(
    "confirm-gate-fix: builtin + high-risk tools excluded / safe finance tools intact / " +
    `${highFinanceTools.length} high-finance drift guard / ` +
    `${ALWAYS_CONFIRM_TOOLS.size} always-confirm drift guard / subagent path ✓`
  );
})();
