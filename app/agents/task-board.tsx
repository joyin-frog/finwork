"use client";

/**
 * task-board.tsx — 本月任务看板视图
 *
 * 纯展示组件：props 接受 board 数据，零动作，全部交互为 Link 深链。
 * 注意：本文件内不得出现任何角色中文名字面量（T4h 守卫）。
 */

import type { CSSProperties } from "react";
import Link from "next/link";
import { Surface } from "@/components/ui/surface";
import type { TaskBoard, TaskBoardCard, TaskBoardCardState, TaskBoardNode } from "@/lib/domain/task-board";

// ─── Props ───────────────────────────────────────────────────────────────────

type TaskBoardProps = {
  board: TaskBoard;
};

// ─── State pill ──────────────────────────────────────────────────────────────

const STATE_TONE: Record<TaskBoardCardState, string> = {
  running: "--tone-analysis",
  locked:  "--tone-ok",
  blocked: "--tone-notice",
  failed:  "--tone-alarm",
  pending: "--tone-neutral",
};

const STATE_LABEL: Record<TaskBoardCardState, string> = {
  running: "进行中",
  locked:  "已拍板",
  blocked: "待拍板",
  failed:  "失败",
  pending: "待确认",
};

function StatePill({ state }: { state: TaskBoardCardState }) {
  return (
    <span
      className="fa-tone-pill text-meta shrink-0"
      style={{ "--tone": `var(${STATE_TONE[state]})` } as CSSProperties}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

// ─── Headline（从 counts 组装中文汇总句） ────────────────────────────────────

/**
 * 从 counts 组装例外优先的汇总句，顺序：blocked → running → pending → failed → locked。
 * counts 为空（空节点/manual 节点）时返回 null。
 */
function buildHeadline(counts: Partial<Record<TaskBoardCardState, number>>): string | null {
  const parts: string[] = [];
  const ORDER: TaskBoardCardState[] = ["blocked", "running", "pending", "failed", "locked"];
  const LABEL: Record<TaskBoardCardState, string> = {
    blocked: "待拍板",
    running: "进行中",
    pending: "待确认",
    failed:  "失败",
    locked:  "已拍板",
  };
  for (const state of ORDER) {
    const n = counts[state];
    if (n) parts.push(`${n} 项${LABEL[state]}`);
  }
  return parts.length > 0 ? parts.join("，") : null;
}

// ─── Global headline（聚合所有节点 counts） ───────────────────────────────────

function buildGlobalHeadline(board: TaskBoard): string {
  const totals: Partial<Record<TaskBoardCardState, number>> = {};
  for (const node of board.nodes) {
    if (node.kind === "cards") {
      for (const [state, n] of Object.entries(node.counts) as [TaskBoardCardState, number][]) {
        totals[state] = (totals[state] ?? 0) + n;
      }
    }
  }
  const headline = buildHeadline(totals);
  return headline ?? "本月任务均未开始";
}

// ─── Card ────────────────────────────────────────────────────────────────────

function DispatchCard({ card }: { card: TaskBoardCard }) {
  const inner = (
    <Surface
      level="card"
      edge="hairline"
      shape="control"
      className="flex flex-col gap-1 px-4 py-3"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <StatePill state={card.state} />
        <span className="text-body font-medium truncate flex-1 min-w-0">{card.objectLabel}</span>
        {card.state === "locked" && (
          <span className="shrink-0" aria-label="已拍板">🔒</span>
        )}
      </div>
      {card.summary && (
        <p className="text-meta text-muted-foreground truncate">{card.summary}</p>
      )}
      {card.state === "blocked" && card.blockedReason && (
        <p className="text-meta text-destructive truncate">{card.blockedReason}</p>
      )}
      {card.conversationId && (
        <span className="text-meta text-muted-foreground hover:text-foreground transition-colors">
          查看会话 →
        </span>
      )}
    </Surface>
  );

  if (card.conversationId) {
    return (
      <Link href={`/chat/recent?id=${card.conversationId}`} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}

// ─── Node ────────────────────────────────────────────────────────────────────

function BoardNode({ node }: { node: TaskBoardNode }) {
  return (
    <section className="flex flex-col gap-2">
      {/* 节点标题行 */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <h3 className="text-title font-semibold">{node.templateName}</h3>
        <span className="text-meta text-muted-foreground">{node.roleName}</span>
        {node.kind === "cards" && (() => {
          const h = buildHeadline(node.counts);
          return h ? <span className="text-meta text-muted-foreground">{h}</span> : null;
        })()}
        {node.kind === "empty" && (
          <span className="text-meta text-muted-foreground">未开始</span>
        )}
        {node.kind === "manual" && (
          <span className="text-meta text-muted-foreground">主对话执行</span>
        )}
      </div>

      {/* 节点内容 */}
      {node.kind === "cards" && (
        <div className="flex flex-col gap-2">
          {node.cards.map((card) => (
            <DispatchCard key={card.dispatchId} card={card} />
          ))}
        </div>
      )}

      {node.kind === "empty" && (
        <Surface level="card" edge="hairline" shape="control" className="px-4 py-3 flex items-center gap-3">
          <span className="text-body text-muted-foreground flex-1">本月尚未执行</span>
          <Link
            href={node.startHref}
            className="text-meta text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            去派活 →
          </Link>
        </Surface>
      )}

      {node.kind === "manual" && (
        <Surface level="card" edge="hairline" shape="control" className="px-4 py-3 flex items-center gap-3">
          <span className="text-meta text-muted-foreground flex-1">{node.note}</span>
          <Link
            href={node.startHref}
            className="text-meta text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            去执行 →
          </Link>
        </Surface>
      )}
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TaskBoardView({ board }: TaskBoardProps) {
  const globalHeadline = buildGlobalHeadline(board);

  return (
    <div className="flex flex-col gap-5">
      {/* 全局汇总行 */}
      <div className="flex items-center gap-2">
        <span className="text-title font-semibold">{board.period}</span>
        <span className="text-body text-muted-foreground">{globalHeadline}</span>
      </div>

      {/* 节点列表 */}
      {board.nodes.map((node) => (
        <BoardNode key={node.templateId} node={node} />
      ))}
    </div>
  );
}
