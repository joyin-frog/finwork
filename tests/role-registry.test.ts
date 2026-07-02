/**
 * 角色注册表静态守卫测试 —— spec-role-registry.md §8 验收标准 5
 *
 * 运行（必须先红）：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/role-registry.test.ts
 *
 * 实现落地后才会绿：lib/agent/roles/registry.ts + 对应 subagent.ts 改造
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const roleRegistryTestPromise = (async () => {
  // ── 动态导入（实现不存在时此处会抛 → 测试红） ─────────────────────────
  const {
    ROLE_REGISTRY,
    SHARED_TOOLS,
    getRoleDefinition,
    resolveRoleAllowedTools,
  } = await import("../lib/agent/roles/registry.ts");

  const { TOOL_REGISTRY, ALLOWED_TOOLS } = await import(
    "../lib/agent/tools/registry.ts"
  );

  // TOOL_REGISTRY 全名集合
  const toolFullNames = new Set<string>(TOOL_REGISTRY.map((t: { name: string }) => t.name));

  // ── G1: 每个 role.tools 的裸名都能在 TOOL_REGISTRY 中解析到全名 ──────
  // 裸名（如 "tax_calculator"）对应 TOOL_REGISTRY 里的全名（如 "mcp__finance_worker__tax_calculator"）
  // 裸名也可能直接是全名（builtin 工具）
  {
    for (const role of ROLE_REGISTRY) {
      for (const bare of role.tools) {
        // 先尝试直接命中（builtin 工具，如 "Read"）
        if (toolFullNames.has(bare)) continue;
        // 再尝试带 mcp 前缀解析
        const matchedByBare = TOOL_REGISTRY.some(
          (t: { name: string }) => t.name === `mcp__finance_worker__${bare}` || t.name === `mcp__kingdee_worker__${bare}`
        );
        assert.ok(
          matchedByBare,
          `G1 FAIL: role "${role.id}" 的工具裸名 "${bare}" 在 TOOL_REGISTRY 中找不到对应全名`
        );
      }
    }
  }

  // ── G2: confirm_payroll_period 不出现在任何角色的 tools ────────────────
  {
    for (const role of ROLE_REGISTRY) {
      const hasConfirm = role.tools.some(
        (t: string) => t === "confirm_payroll_period" || t.includes("confirm_payroll_period")
      );
      assert.ok(
        !hasConfirm,
        `G2 FAIL: role "${role.id}" 的 tools 包含了 confirm_payroll_period，违反红线 5`
      );
    }
  }

  // ── G3: 每个 role.skills 都存在对应的 SKILL.md 技能目录 ──────────────
  {
    const skillsBase = path.join(PROJECT_ROOT, "agent-skills", "skills");
    for (const role of ROLE_REGISTRY) {
      for (const skill of role.skills) {
        const skillMd = path.join(skillsBase, skill, "SKILL.md");
        assert.ok(
          existsSync(skillMd),
          `G3 FAIL: role "${role.id}" 的技能 "${skill}" 缺少 ${skillMd}`
        );
      }
    }
  }

  // ── G4a: resolveRoleAllowedTools("bookkeeper") 不含 payroll 相关工具名 ─
  {
    const bookkeeperTools = resolveRoleAllowedTools("bookkeeper");
    const payrollRelated = bookkeeperTools.filter(
      (t: string) => t.toLowerCase().includes("payroll") || t.toLowerCase().includes("calculate_payroll")
    );
    assert.deepEqual(
      payrollRelated,
      [],
      `G4a FAIL: bookkeeper allowedTools 含 payroll 相关工具: ${payrollRelated.join(", ")}`
    );
  }

  // ── G4b: resolveRoleAllowedTools("tax-officer") 含 query_payroll_status 全名 ──
  {
    const taxTools = resolveRoleAllowedTools("tax-officer");
    const hasPayrollStatus = taxTools.some(
      (t: string) => t === "mcp__finance_worker__query_payroll_status"
    );
    assert.ok(
      hasPayrollStatus,
      `G4b FAIL: tax-officer allowedTools 应含 mcp__finance_worker__query_payroll_status，实际: ${taxTools.join(", ")}`
    );
  }

  // ── G4c: bookkeeper 和 tax-officer 都含 SHARED_TOOLS 的全名 ─────────────
  {
    const bookkeeperTools = resolveRoleAllowedTools("bookkeeper");
    const taxTools = resolveRoleAllowedTools("tax-officer");

    for (const sharedBare of SHARED_TOOLS as string[]) {
      // SHARED_TOOLS 里的裸名，需要找到对应全名（MCP 工具）或直接是全名（builtin）
      const sharedFullName =
        toolFullNames.has(sharedBare)
          ? sharedBare
          : TOOL_REGISTRY.find(
              (t: { name: string }) =>
                t.name === `mcp__finance_worker__${sharedBare}` ||
                t.name === `mcp__kingdee_worker__${sharedBare}`
            )?.name ?? sharedBare;

      assert.ok(
        bookkeeperTools.includes(sharedFullName),
        `G4c FAIL: bookkeeper allowedTools 缺少 SHARED_TOOL "${sharedBare}" (全名: "${sharedFullName}")`
      );
      assert.ok(
        taxTools.includes(sharedFullName),
        `G4c FAIL: tax-officer allowedTools 缺少 SHARED_TOOL "${sharedBare}" (全名: "${sharedFullName}")`
      );
    }
  }

  // ── G4d: resolveRoleAllowedTools 返回结果 ⊆ ALLOWED_TOOLS ─────────────
  {
    const allowedSet = new Set<string>(ALLOWED_TOOLS);
    for (const role of ROLE_REGISTRY) {
      const tools = resolveRoleAllowedTools(role.id);
      for (const t of tools) {
        // SHARED_TOOLS 的裸名（如 run_python）会以全名（mcp__finance_worker__run_python）存在
        // builtin 工具（如 Read）直接在 ALLOWED_TOOLS 里
        const inAllowed =
          allowedSet.has(t) ||
          allowedSet.has(`mcp__finance_worker__${t}`) ||
          allowedSet.has(`mcp__kingdee_worker__${t}`);
        assert.ok(
          inAllowed,
          `G4d FAIL: role "${role.id}" allowedTools 含 "${t}"，不在 ALLOWED_TOOLS 中`
        );
      }
    }
  }

  // ── G5: available:true 的 id 集与 subagent.ts 源码中的 role 枚举一致 ──
  {
    const subagentSrc = readFileSync(
      path.join(PROJECT_ROOT, "lib", "agent", "mcp-tools", "subagent.ts"),
      "utf-8"
    );

    // 确认 "excel-finance" 不出现在 subagent.ts
    assert.ok(
      !subagentSrc.includes("excel-finance"),
      `G5 FAIL: subagent.ts 仍含字符串 "excel-finance"，应已删除`
    );

    // 裁决修订(2026-07-02):spec §4.1 要求枚举「从注册表生成，不再手写」，
    // 因此守卫目标不是"id 字面量存在于源码"，而是"强制生成机制、禁止硬编码重复"：
    // a) subagent.ts 必须 import ROLE_REGISTRY 并按 available 过滤生成枚举
    assert.ok(
      subagentSrc.includes(`from "@/lib/agent/roles/registry"`) &&
        subagentSrc.includes("ROLE_REGISTRY") &&
        subagentSrc.includes(".available"),
      "G5 FAIL: subagent.ts 应从 ROLE_REGISTRY 按 available 生成 role 枚举，而不是手写"
    );

    // b) 旧的五个 skill 枚举字面量不得再出现在 subagent.ts（防退回硬编码）
    for (const legacy of ["reimbursement-check", "payroll-calc", "finance-analysis", "kingdee-draft"]) {
      assert.ok(
        !subagentSrc.includes(`"${legacy}"`),
        `G5 FAIL: subagent.ts 仍含旧 skill 枚举字面量 "${legacy}"`
      );
    }

    // available:false 的角色不应出现在枚举中（如 receivables-officer）
    const unavailableIds = ROLE_REGISTRY
      .filter((r: { available: boolean }) => !r.available)
      .map((r: { id: string }) => r.id);

    for (const id of unavailableIds) {
      // 枚举中不含（但 ROLE_REGISTRY 导入里可以出现）——检测方式：
      // subagent.ts 里的 role 枚举值不含该 id
      // 用 z.enum([...]) 里的字符串来判定，简单起见检查它是否作为枚举值出现在 enum([ ]) 内
      // 由于没有 AST，用正则粗判：若出现在引号中紧跟逗号或 ] 的位置
      const inEnum = new RegExp(`"${id}"[,\\s\\]]`).test(subagentSrc);
      assert.ok(
        !inEnum,
        `G5 FAIL: unavailable 角色 "${id}" 不应出现在 subagent.ts 的 role 枚举里`
      );
    }
  }

  // ── G6: buildSubagentSystemPrompt 输出包含必要锚点字符串 ──────────────
  {
    const { buildSubagentSystemPrompt } = await import("../lib/agent/subagent-runner.ts");

    const taxRole = getRoleDefinition("tax-officer");
    assert.ok(
      taxRole !== undefined,
      `G6 FAIL: getRoleDefinition("tax-officer") 返回 undefined`
    );

    const prompt = buildSubagentSystemPrompt(taxRole!);

    // A 段基座必含
    assert.ok(
      prompt.includes("out_of_scope"),
      `G6 FAIL: system prompt 应含 "out_of_scope"（A 段基座纪律）`
    );
    assert.ok(
      prompt.includes("【结果摘要】"),
      `G6 FAIL: system prompt 应含 "【结果摘要】"（A 段交付契约）`
    );

    // B 段角色特征句（tax-officer rolePrompt 里的特征）
    assert.ok(
      prompt.includes("不提交任何申报"),
      `G6 FAIL: system prompt 应含 tax-officer rolePrompt 特征句 "不提交任何申报"`
    );
  }

  console.log("role-registry: all 6 guards passed ✓");
})();
