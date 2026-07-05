/**
 * agent-board.ts — 智能体团队看板的纯领域函数（无 DB/IO）
 *
 * 导出：
 *   partitionRoles(roster, dispatches) → { active, rest }
 *   groupAttentionItems(blockedRows, attentionItems) → AttentionItem[]
 */

import type { AttentionItem } from "./attention";

// ─── Types ─────────────────────────────────────────────────────────────────

export type RoleDispatchStatus = {
  roleId: string;
  isRunning: boolean;
  isBlocked: boolean;
  conversationId?: string | null;
};

export type RosterItem = {
  roleId: string;
  name: string;
  domain: string;
  charter: string;
  dataScope: string[];
  skills: { name: string; description: string }[];
  available: boolean;
  userDisabled: boolean;
  dispatchCount: number;
  lastAt: string | null;
  lastSummary?: string | null;
  status?: string | null;
  blockedReason?: string | null;
  conversationId?: string | null;
};

export type RoleCard = RosterItem & {
  isActive: boolean;
};

export type PartitionResult = {
  active: RoleCard[];
  rest: RoleCard[];
};

/**
 * 按派发状态分组角色：
 *   active = running 或有 blocked 派发 → 置顶
 *   rest   = 其余（idle；available:false 置最后）
 *
 * 纯函数：无 DB/IO，仅依赖传入数据。
 */
export function partitionRoles(roster: RosterItem[]): PartitionResult {
  const active: RoleCard[] = [];
  const restEnabled: RoleCard[] = [];
  const restDisabled: RoleCard[] = [];

  for (const item of roster) {
    const isActive =
      item.status === "running" ||
      (item.blockedReason != null && item.blockedReason !== "");
    const card: RoleCard = { ...item, isActive };

    if (isActive) {
      active.push(card);
    } else if (!item.available || item.userDisabled) {
      restDisabled.push(card);
    } else {
      restEnabled.push(card);
    }
  }

  // active 组：running 在前，blocked 在后
  active.sort((a, b) => {
    const aRun = a.status === "running" ? 0 : 1;
    const bRun = b.status === "running" ? 0 : 1;
    return aRun - bRun;
  });

  return {
    active,
    rest: [...restEnabled, ...restDisabled],
  };
}

/**
 * 等你拍板区：从已排好序的 AttentionItem 列表中提取 gate 类（停在确认门）。
 * rule 类由调用方通过 deriveAttentionItems 产出，server 端合并后一起传来。
 * 本函数仅用于源码契约测试验证「两页使用同源数据路径」，无额外逻辑。
 */
export function filterGateItems(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => i.source === "gate");
}
