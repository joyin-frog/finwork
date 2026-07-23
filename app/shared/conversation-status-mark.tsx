"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import { WarningIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

/**
 * 会话状态标（侧栏 / 总览「最近工作」等共用）。
 *
 * idle / done → 灰色空心小圆（已完成与默认态同外观，不另标）
 * streaming|running → 中性转圈
 * error|stopped → 警告三角
 */
export type ConversationStatusKind = "idle" | "streaming" | "done" | "error";

const LABELS: Record<ConversationStatusKind, string> = {
  idle: "",
  streaming: "正在生成",
  done: "",
  error: "未正常完成",
};

/** 侧栏：live / hasError / 当前会话 → 状态；done 与 idle 同外观。 */
export function resolveConversationStatus(opts: {
  live?: string | null;
  hasError?: boolean;
  isActive?: boolean;
}): ConversationStatusKind {
  const { live, hasError, isActive } = opts;
  if (live === "streaming") {
    return isActive ? "idle" : "streaming";
  }
  // 已完成不再用蓝点提醒，与默认空闲同标
  if (live === "done") return "idle";
  if (live === "error" || live === "stopped") return "error";
  if (hasError) return "error";
  return "idle";
}

/** 总览 RecentWorkItem：running→转圈，error→警告，done→idle 空心。 */
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
          : status === "done"
            ? "idle"
            : status;

  if (!kind) return null;

  const text = label === undefined ? LABELS[kind] : label;
  const dotPx = Math.max(6, Math.round(size * 0.5));
  // idle（及已折叠的 done）：空心描边，占位但不抢眼
  const hollowDot = (
    <span
      className="rounded-full border border-current opacity-40"
      style={{ width: dotPx, height: dotPx }}
      aria-hidden
    />
  );

  const icon =
    kind === "streaming" ? (
      <HugeiconsIcon icon={Loading03Icon} size={size} className="animate-spin" />
    ) : kind === "error" ? (
      <HugeiconsIcon icon={WarningIcon} size={size} />
    ) : (
      hollowDot
    );

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center pointer-events-none",
        (kind === "idle" || kind === "streaming") && "text-muted-foreground",
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
