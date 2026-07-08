import { NextResponse } from "next/server";
import { ROLE_REGISTRY } from "@/lib/agent/roles/registry";
import { listRoleDispatchSummary, listRoleLatestStatus, listBlockedDispatches, listDispatchesForPeriod } from "@/lib/db/dispatch-store";
import { getInvoiceLedgerStats, getPayrollPeriodSummary, hasMetricsForMonth, listCashObligations } from "@/lib/db/finance-store";
import { listSkills } from "@/lib/agent/skills-store";
import { skillLabel } from "@/lib/agent/tools/renderers";
import { getAppSetting } from "@/lib/db/sqlite";
import { getCalendarContext } from "@/lib/domain/tax-calendar";
import { deriveAttentionItems, blockedDispatchToAttentionItem, sortAttentionItems } from "@/lib/domain/attention";
import { deriveTaskBoard } from "@/lib/domain/task-board";
import { currentYearMonth, TASK_TEMPLATES } from "@/lib/agent/roles/task-templates";

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

    // 角色最新状态（running/blocked）
    const latestStatuses = listRoleLatestStatus();
    const statusMap = new Map(latestStatuses.map((s) => [s.roleId, s]));

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
      const latestStatus = statusMap.get(role.id);
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
        lastSummary: dispatch?.lastSummary ?? null,
        // 动态状态字段（评审必改）：供客户端"在忙"分组使用
        status: latestStatus?.isRunning ? "running" : null,
        blockedReason: latestStatus?.blockedReason ?? null,
        conversationId: latestStatus?.conversationId ?? null,
      };

      // bookkeeper 专项：附发票台账计数
      if (role.id === "bookkeeper") {
        entry.invoiceStats = bookeeperInvoiceStats;
      }

      return entry;
    });

    // ─── 等你拍板：server 端同源，复用 cockpit 的同一套 domain 函数 ──────────
    const calendar = getCalendarContext(now);
    const payroll = getPayrollPeriodSummary(year, month);

    const obligations = listCashObligations();

    // 传完整 obligations(不按月过滤)——与 cockpit 同源:逾期的往月义务也算紧急,
    // 按月过滤会把上月未付、已逾期的合同从「等你拍板」里漏掉(cockpit 里却还在)。
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const metricsForLastMonth = hasMetricsForMonth(prevYear, prevMonth);

    // allSkills 已在 line 28 await；直接过滤取 starter，读取失败传 undefined（R6 降级无预填跳转）
    let filingPrecheckStarter: string | undefined;
    try {
      const precheckSkill = allSkills.find((s) => s.name === "filing-precheck");
      filingPrecheckStarter = precheckSkill?.starter || undefined;
    } catch {
      filingPrecheckStarter = undefined;
    }

    // bookeeperInvoiceStats 已在 line 55 查询，直接复用（reviewer N5）
    const ruleItems = deriveAttentionItems(calendar, payroll, obligations, bookeeperInvoiceStats, metricsForLastMonth, filingPrecheckStarter);
    const blockedDispatches = listBlockedDispatches(7);
    const gateItems = blockedDispatches.map((row) => {
      const reg = ROLE_REGISTRY.find((r) => r.id === row.roleId);
      const roleName = reg?.name ?? row.roleId;
      return blockedDispatchToAttentionItem(row, roleName);
    });
    const attention = [...ruleItems, ...gateItems];
    sortAttentionItems(attention);

    const period = currentYearMonth(now);
    const board = deriveTaskBoard(TASK_TEMPLATES, listDispatchesForPeriod(period), period);

    return NextResponse.json({ ok: true, data: { roster, attention, board } });
  } catch (error) {
    console.error("[api/agents] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "加载失败" },
      { status: 500 }
    );
  }
}
