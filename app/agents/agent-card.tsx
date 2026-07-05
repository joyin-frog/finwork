"use client";

import type { CSSProperties } from "react";
import { ROLE_UI } from "@/lib/domain/role-ui";
import { relativeTime } from "@/lib/utils/relative-time";
import type { RoleCard } from "@/lib/domain/agent-board";

type AgentCardProps = {
  card: RoleCard;
  selected?: boolean;
  compact?: boolean;
  onClick?: () => void;
};

export function AgentCard({ card, selected = false, compact = false, onClick }: AgentCardProps) {
  const ui = ROLE_UI[card.roleId as keyof typeof ROLE_UI];
  const tone = ui?.tone ?? "--tone-neutral";
  const isDisabled = !card.available || card.userDisabled;
  const isBlocked = card.blockedReason != null && card.blockedReason !== "";
  const isRunning = card.status === "running";

  return (
    <div
      className={[
        "rounded-lg border bg-card cursor-pointer select-none transition-colors",
        selected
          ? "border-foreground/30 ring-1 ring-foreground/10"
          : "border-border hover:border-foreground/20",
        isDisabled && !isBlocked && !isRunning ? "opacity-60" : "",
        compact ? "px-3 py-2" : "px-4 py-3",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
      aria-pressed={selected}
    >
      <div className="flex items-center gap-3">
        {/* tone 头像 */}
        <span
          className="fa-toned shrink-0 flex items-center justify-center rounded-full font-semibold select-none"
          style={{
            "--tone": `var(${tone})`,
            width: compact ? "1.75rem" : "2rem",
            height: compact ? "1.75rem" : "2rem",
            fontSize: compact ? "0.75rem" : "0.875rem",
          } as CSSProperties}
          aria-hidden="true"
        >
          {card.name.slice(0, 1)}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={compact ? "text-meta font-semibold" : "text-body font-semibold"}>
              {card.name}
            </span>
            {!compact && (
              <span className="text-meta text-muted-foreground">{card.domain}</span>
            )}
            {/* 状态 pill */}
            {isRunning && (
              <span
                className="fa-tone-pill text-meta shrink-0"
                style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}
              >
                进行中
              </span>
            )}
            {isBlocked && !isRunning && (
              <span
                className="fa-tone-pill text-meta shrink-0"
                style={{ "--tone": "var(--tone-notice)" } as CSSProperties}
              >
                待拍板
              </span>
            )}
            {card.userDisabled && (
              <span className="text-meta px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                已停用
              </span>
            )}
            {!card.available && !card.userDisabled && (
              <span className="text-meta px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                尚未启用
              </span>
            )}
          </div>
          {!compact && (
            <p className="text-meta text-muted-foreground truncate">{card.charter}</p>
          )}
        </div>

        {!compact && (
          <span className="text-meta text-muted-foreground shrink-0 whitespace-nowrap">
            {card.dispatchCount > 0
              ? `${card.dispatchCount} 次${card.lastAt ? ` · ${relativeTime(card.lastAt)}` : ""}`
              : "暂无记录"}
          </span>
        )}
      </div>
    </div>
  );
}
