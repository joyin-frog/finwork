"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import { WarningIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

/**
 * 会话状态标（侧栏 / 总览「最近工作」等共用）。
 *
 * idle → 灰色实心小圆（默认，始终可见）
 * streaming|running → 中性转圈
 * done → 蓝色实心小圆（离开后「已完成」提醒；当前会话回落 idle）
 * error|stopped → 警告三角
 *
 * Hugeicons CircleSmallIcon 是空心描边；实心圆用手写 filled 圆点。
 */
export type ConversationStatusKind = "idle" | "streaming" | "done" | "error";

const LABELS: Record<ConversationStatusKind, string> = {
  idle: "",
  streaming: "正在生成",
  done: "已完成，点击查看",
  error: "未正常完成",
};

/** 侧栏：live / hasError / 当前会话 → 状态；无特殊态时回落 idle（保证图形槽有标）。 */
export function resolveConversationStatus(opts: {
  live?: string | null;
  hasError?: boolean;
  isActive?: boolean;
}): ConversationStatusKind {
  const { live, hasError, isActive } = opts;
  if (live === "streaming" || live === "done") {
    return isActive ? "idle" : live;
  }
  if (live === "error" || live === "stopped") return "error";
  if (hasError) return "error";
  return "idle";
}

/** 总览 RecentWorkItem：running→转圈，error→警告，done→灰色实心（非未读蓝点）。 */
export function conversationStatusFromWorkItem(
  status: "running" | "done" | "error",
): ConversationStatusKind {
  if (status === "running") return "streaming";
  if (status === "error") return "error";
  return "idle";
}

export function ConversationStatusMark({
  status,
  size = 14,
  className,
  label,
}: {
  status: ConversationStatusKind | "running" | "stopped" | null | undefined;
  size?: number;
  className?: string;
  /** 覆盖默认 aria/title；传空串则不设 title。 */
  label?: string;
}) {
  const kind: ConversationStatusKind | null =
    status == null
      ? null
      : status === "running"
        ? "streaming"
        : status === "stopped"
          ? "error"
          : status;

  if (!kind) return null;

  const text = label === undefined ? LABELS[kind] : label;
  const solidPx = Math.max(6, Math.round(size * 0.5));
  const solidDot = (
    <span
      className="rounded-full bg-current"
      style={{ width: solidPx, height: solidPx }}
      aria-hidden
    />
  );

  const icon =
    kind === "streaming" ? (
      <HugeiconsIcon icon={Loading03Icon} size={size} className="animate-spin" />
    ) : kind === "error" ? (
      <HugeiconsIcon icon={WarningIcon} size={size} />
    ) : (
      // idle（灰）与 done（蓝）都是实心圆
      solidDot
    );

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center pointer-events-none",
        (kind === "idle" || kind === "streaming") && "text-muted-foreground",
        kind === "done" && "text-primary",
        kind === "error" && "text-[color:var(--tone-alarm)]",
        className,
      )}
      title={text || undefined}
      aria-label={text || undefined}
      role={kind === "idle" ? undefined : "status"}
    >
      {icon}
    </span>
  );
}
