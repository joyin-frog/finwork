/**
 * task-board.ts — 本月任务看板领域模型
 *
 * 纯函数：不 import store、不读时钟（period 由调用方传入）。
 * date 不进 domain 层，方便测试。
 */

import type { TaskTemplate } from "@/lib/agent/roles/task-templates";
import { buildTemplateDispatchHref } from "@/lib/agent/roles/task-templates";
import type { DispatchRow } from "@/lib/db/dispatch-store";
import { getRoleDefinition } from "@/lib/agent/roles/registry";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TaskBoardCardState = "running" | "blocked" | "failed" | "locked" | "pending";

export type TaskBoardCard = {
  dispatchId: number;
  /** businessObject ?? template.objectLabel ?? label ?? "未命名任务" */
  objectLabel: string;
  state: TaskBoardCardState;
  summary: string | null;
  blockedReason: string | null;
  conversationId: string | null;
  startedAt: string | null;
  /** 输入文件 basename 列表（从完整路径 split 取末段，空时 [] */
  fileNames: string[];
};

export type TaskBoardNode =
  | {
      kind: "cards";
      templateId: string;
      templateName: string;
      roleId: string;
      roleName: string;
      cards: TaskBoardCard[];
      /** 各状态计数，只含非零项（例外式稀疏性在类型层表达） */
      counts: Partial<Record<TaskBoardCardState, number>>;
    }
  | {
      kind: "empty";
      templateId: string;
      templateName: string;
      roleId: string;
      roleName: string;
      startHref: string;
    }
  | {
      kind: "manual";
      templateId: string;
      templateName: string;
      roleId: string;
      roleName: string;
      startHref: string;
      note: string;
    };

export type TaskBoard = { period: string; nodes: TaskBoardNode[] };

// ─── State derivation ────────────────────────────────────────────────────────

/**
 * 卡片状态优先级：running > locked > blocked(blockedReason≠null) > failed > pending。
 * locked 排在 blocked 之前：人工终审终态，拍板即视为连同拦截门一并处理完毕。
 */
function deriveCardState(row: DispatchRow): TaskBoardCardState {
  if (row.status === "running") return "running";
  if (row.reviewStatus === "locked") return "locked";
  if (row.blockedReason != null) return "blocked";
  if (row.status === "failed") return "failed";
  return "pending";
}

// ─── Main function ───────────────────────────────────────────────────────────

/**
 * 按模板列表与当月派发记录推导看板节点。
 *
 * @param templates  TASK_TEMPLATES 声明顺序即节点顺序
 * @param dispatches 已按 period 精确过滤的派发行（来自 listDispatchesForPeriod）
 * @param period     YYYY-MM 格式的当月，由调用方传入
 */
export function deriveTaskBoard(
  templates: TaskTemplate[],
  dispatches: DispatchRow[],
  period: string
): TaskBoard {
  const nodes: TaskBoardNode[] = templates.map((t) => {
    const roleName = getRoleDefinition(t.roleId)?.name ?? t.roleId;

    // main-skill 型：恒为 manual 节点，无进度跟踪
    if (t.mode === "main-skill") {
      return {
        kind: "manual",
        templateId: t.id,
        templateName: t.name,
        roleId: t.roleId,
        roleName,
        startHref: buildTemplateDispatchHref(t, roleName, period),
        note: "在主对话执行，看板暂不跟踪进度",
      };
    }

    // subagent 型：按 taskTemplateId 过滤当月派发，已排序（入参为 startedAt DESC）
    const templateDispatches = dispatches.filter((d) => d.taskTemplateId === t.id);

    if (templateDispatches.length === 0) {
      return {
        kind: "empty",
        templateId: t.id,
        templateName: t.name,
        roleId: t.roleId,
        roleName,
        startHref: buildTemplateDispatchHref(t, roleName, period),
      };
    }

    // 有派发记录 → cards 节点
    const cards: TaskBoardCard[] = templateDispatches.map((row) => ({
      dispatchId: row.id,
      objectLabel: row.businessObject ?? t.objectLabel ?? row.label ?? "未命名任务",
      state: deriveCardState(row),
      summary: row.summary,
      blockedReason: row.blockedReason,
      conversationId: row.conversationId,
      startedAt: row.startedAt,
      fileNames: row.files.map((p) => p.split(/[/\\]/).pop() ?? p),
    }));

    // counts：累加即只含非零项（键只在出现该状态卡片时才写入）
    const counts: Partial<Record<TaskBoardCardState, number>> = {};
    for (const card of cards) {
      counts[card.state] = (counts[card.state] ?? 0) + 1;
    }

    return {
      kind: "cards",
      templateId: t.id,
      templateName: t.name,
      roleId: t.roleId,
      roleName,
      cards,
      counts,
    };
  });

  return { period, nodes };
}
