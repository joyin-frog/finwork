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
import { relativeTime } from "@/lib/utils/relative-time";

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
  const isBlocked = card.state === "blocked";
  const timeLabel = relativeTime(card.startedAt);

  // 文件名列表：最多显示 3 个，超出用 "+N" 标注
  const shownFiles = card.fileNames.slice(0, 3);
  const extraCount = card.fileNames.length - shownFiles.length;

  const inner = (
    <Surface
      level="card"
      edge="hairline"
      shape="card"
      className={`flex flex-col gap-2 px-4 py-3${isBlocked ? " relative overflow-hidden" : ""}`}
    >
      {/* blocked 左侧色条（需要 Surface 有 relative 定位） */}
      {isBlocked && (
        <span
          className="fa-tone-edge"
          style={{ "--tone": "var(--tone-alarm)" } as CSSProperties}
        />
      )}

      {/* 顶行：StatePill + 相对时间 */}
      <div className="flex items-center gap-2 justify-between">
        <StatePill state={card.state} />
        {timeLabel && (
          <span className="text-meta text-muted-foreground shrink-0">{timeLabel}</span>
        )}
        {card.state === "locked" && (
          <span className="shrink-0" aria-label="已拍板">🔒</span>
        )}
      </div>

      {/* 主体：objectLabel + summary */}
      <div className="flex flex-col gap-1">
        <span className="text-body font-semibold leading-snug">{card.objectLabel}</span>
        {card.summary && (
          <p
            className="text-meta text-muted-foreground"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            } as CSSProperties}
          >
            {card.summary}
          </p>
        )}
      </div>

      {/* blocked 提示红字（blockedReason 存的是机器工具名，不直接给财务用户看） */}
      {isBlocked && card.blockedReason && (
        <p
          className="text-meta"
          style={{ color: "var(--tone-alarm)" } as CSSProperties}
        >
          高风险动作已拦截，等你在对话里拍板
        </p>
      )}

      {/* 输入文件名（非空时渲染） */}
      {shownFiles.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shownFiles.map((name) => (
            <span key={name} className="text-meta text-muted-foreground truncate max-w-[160px]">
              {name}
            </span>
          ))}
          {extraCount > 0 && (
            <span className="text-meta text-muted-foreground shrink-0">+{extraCount}</span>
          )}
        </div>
      )}

      {/* 深链（SC2 契约：/chat/recent?id=） */}
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

function BoardNode({ node, period }: { node: TaskBoardNode; period: string }) {
  // 银行对账节点：只用 templateId 识别（T4h 守卫禁止中文名字面量）
  const isBankRecon = node.templateId === "bank-recon";
  const bankReconPrompt = "我要把本月各账户银行流水批量对一遍，稍后上传流水文件（每账户一个，可附账面记录）";

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
        {/* 银行对账次级深链（仅 bank-recon 节点） */}
        {isBankRecon && (
          <Link
            href={`/chat/new?prompt=${encodeURIComponent(bankReconPrompt)}`}
            className="text-meta text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-auto"
          >
            批量对账 →
          </Link>
        )}
      </div>

      {/* 节点内容 */}
      {node.kind === "cards" && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
        >
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

  // 申报前复核批跑预填 prompt（SC5 契约：含"申报前复核批量"关键词）
  const filingBatchPrompt = `把 ${board.period} 申报前复核批量跑一遍（增值税及附加、个税各出一张复核卡）`;

  return (
    <div className="flex flex-col gap-6">
      {/* 全局汇总行 + 批量复核申报前主按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-title font-semibold">{board.period}</span>
        <span className="text-body text-muted-foreground flex-1">{globalHeadline}</span>
        <Link
          href={`/chat/new?prompt=${encodeURIComponent(filingBatchPrompt)}`}
          className="fa-toned text-meta font-medium px-3 py-1 rounded-md shrink-0 hover:opacity-80 transition-opacity"
          style={{ "--tone": "var(--tone-neutral)" } as CSSProperties}
        >
          批量复核申报前 →
        </Link>
      </div>

      {/* 节点列表 */}
      {board.nodes.map((node) => (
        <BoardNode key={node.templateId} node={node} period={board.period} />
      ))}
    </div>
  );
}
