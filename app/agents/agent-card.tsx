"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ROLE_UI } from "@/lib/domain/role-ui";
import { relativeTime } from "@/lib/utils/relative-time";
import type { RoleCard } from "@/lib/domain/agent-board";

type AgentCardProps = {
  card: RoleCard;
  selected?: boolean;
  compact?: boolean;
  onClick?: () => void;
  /** 启停切换成功后回调（父级重取花名册） */
  onToggled?: () => void;
};

export function AgentCard({ card, selected = false, compact = false, onClick, onToggled }: AgentCardProps) {
  const ui = ROLE_UI[card.roleId as keyof typeof ROLE_UI];
  const tone = ui?.tone ?? "--tone-neutral";
  const isDisabled = !card.available || card.userDisabled;
  const isBlocked = card.blockedReason != null && card.blockedReason !== "";
  const isRunning = card.status === "running";
  const [toggling, setToggling] = useState(false);

  async function handleToggle() {
    if (toggling) return;
    setToggling(true);
    try {
      await fetch("/api/agents/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleId: card.roleId, disabled: !card.userDisabled }),
      });
      onToggled?.();
    } finally {
      setToggling(false);
    }
  }

  const avatarSize = compact ? "1.75rem" : "2rem";
  // 底部控件行左缩进，对齐正文（头像宽 + gap）
  const bottomIndent = compact ? "2.5rem" : "2.75rem";
  const canDispatch = !isDisabled;

  return (
    <div
      className={[
        "rounded-lg border bg-card cursor-pointer select-none transition-colors",
        selected ? "border-foreground/30 ring-1 ring-foreground/10" : "border-border hover:border-foreground/20",
        isDisabled && !isBlocked && !isRunning ? "opacity-60" : "",
        compact ? "px-3 py-2" : "px-4 py-3",
      ].filter(Boolean).join(" ")}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
      aria-pressed={selected}
    >
      {/* 顶部行：头像 + 名称/域/状态 + 右上角开关 */}
      <div className="flex items-start gap-3">
        <span
          className="fa-toned shrink-0 flex items-center justify-center rounded-full font-semibold select-none"
          style={{ "--tone": `var(${tone})`, width: avatarSize, height: avatarSize, fontSize: compact ? "0.75rem" : "0.875rem" } as CSSProperties}
          aria-hidden="true"
        >
          {card.name.slice(0, 1)}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={compact ? "text-meta font-semibold" : "text-body font-semibold"}>{card.name}</span>
            {!compact && <span className="text-meta text-muted-foreground">{card.domain}</span>}
            {isRunning && (
              <span className="fa-tone-pill text-meta shrink-0" style={{ "--tone": "var(--tone-analysis)" } as CSSProperties}>进行中</span>
            )}
            {isBlocked && !isRunning && (
              <span className="fa-tone-pill text-meta shrink-0" style={{ "--tone": "var(--tone-notice)" } as CSSProperties}>待拍板</span>
            )}
            {!card.available && (
              <span className="text-meta px-1.5 py-0.5 rounded bg-muted text-muted-foreground">尚未启用</span>
            )}
          </div>
          {!compact && <p className="text-meta text-muted-foreground truncate">{card.charter}</p>}
        </div>

        {/* 右上角：启停开关（仅可用角色）。stopPropagation 防止触发卡片点击（开抽屉） */}
        {card.available && (
          <span
            className="shrink-0 flex items-center"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            title={card.userDisabled ? "已停用，点击启用" : "已启用，点击停用"}
          >
            <Switch checked={!card.userDisabled} onCheckedChange={handleToggle} disabled={toggling} aria-label={card.userDisabled ? "启用" : "停用"} />
          </span>
        )}
      </div>

      {/* 底部行：本月次数（左）+ 派活（右下角） */}
      <div className="flex items-center justify-between mt-2" style={{ paddingLeft: bottomIndent }}>
        <span className="text-meta text-muted-foreground whitespace-nowrap">
          {card.dispatchCount > 0
            ? `${card.dispatchCount} 次${card.lastAt ? ` · ${relativeTime(card.lastAt)}` : ""}`
            : card.available ? "暂无记录" : ""}
        </span>
        {canDispatch && (
          <Link
            href={`/chat/new?prompt=${encodeURIComponent(`让${card.name}帮我处理…`)}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0"
          >
            <Button variant="outline" size="sm">派活</Button>
          </Link>
        )}
      </div>
    </div>
  );
}
