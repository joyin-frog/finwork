import { NextResponse } from "next/server";
import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { listRoleDispatchSummary } from "@/lib/db/dispatch-store";
import { getInvoiceLedgerStats } from "@/lib/db/finance-store";
import { listSkills } from "@/lib/agent/skills-store";
import { skillLabel } from "@/lib/agent/tools/renderers";
import { getAppSetting } from "@/lib/db/sqlite";

export async function GET() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // 技能列表（从 skills-store 取名称与描述）
    const allSkills = await listSkills();
    const skillMap = new Map(allSkills.map((s) => [s.name, s]));

    // 调度汇总（count + lastAt per role）
    const dispatchSummaries = listRoleDispatchSummary();
    const dispatchMap = new Map(dispatchSummaries.map((s) => [s.roleId, s]));

    // 读 agent_disabled_roles（app_settings key）
    let disabledRoles: string[] = [];
    try {
      const raw = getAppSetting("agent_disabled_roles");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          disabledRoles = parsed.filter((x): x is string => typeof x === "string");
        }
      }
    } catch {
      disabledRoles = [];
    }
    const disabledSet = new Set(disabledRoles);

    // bookkeeper 发票台账计数
    const bookeeperInvoiceStats = getInvoiceLedgerStats(year, month);

    const roster = ROLE_REGISTRY.map((role) => {
      const dispatch = dispatchMap.get(role.id);
      const userDisabled = disabledSet.has(role.id);

      // 技能列表：中文名走 skillLabel(SKILL.md 的 name 是机器 id,不能直出给财务用户),
      // 描述关联 skills-store,取不到用 id 兜底
      const skills = role.skills.map((skillId) => {
        const skill = skillMap.get(skillId);
        return {
          name: skillLabel(skillId),
          description: skill?.description ?? skillId,
        };
      });

      const entry: Record<string, unknown> = {
        roleId: role.id,
        name: role.name,
        domain: role.domain,
        charter: role.charter,
        dataScope: role.dataScope,
        skills,
        available: role.available,
        userDisabled,
        dispatchCount: dispatch?.count ?? 0,
        lastAt: dispatch?.lastAt ?? null,
      };

      // bookkeeper 专项：附发票台账计数
      if (role.id === "bookkeeper") {
        entry.invoiceStats = bookeeperInvoiceStats;
      }

      return entry;
    });

    return NextResponse.json({ ok: true, data: { roster } });
  } catch (error) {
    console.error("[api/agents] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
