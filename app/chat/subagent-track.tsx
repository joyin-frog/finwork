"use client";

import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, Alert02Icon } from "@hugeicons/core-free-icons";
import { SuccessIcon } from "@/lib/icons";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { ThinkingSpark } from "@/app/shared/thinking-spark";
import type { AgentEvent } from "@/app/chat/chat-types";

type TimelineItem = {
  id: string;
  event: AgentEvent;
  createdAt: number;
  /** AR2a: 子代理实例标识（live 流 = 非空字符串；DB 历史条目 = undefined）。 */
  instanceId?: string | null;
};

/**
 * SubagentTrack — 子代理子轨道。
 * 渲染一个子代理的里程碑序列：角色标签行 + 逐步工具步骤 + blocked 高亮。
 * 复用 ToolStepList 的步骤样式与 tone token；blocked 用 --tone-notice（仿 agents/page.tsx 的「停在确认门」）。
 */
export function SubagentTrack({
  label,
  items,
  isActive,
}: {
  label: string;
  items: TimelineItem[];
  isActive: boolean;
}) {
  // AR2a: 主判据 instanceId != null（live 流），兜底 event.type === "subagent"（DB 历史）
  const subagentEvents = items
    .filter((item) => item.instanceId != null || item.event.type === "subagent")
    .map((item) => item.event)
    .filter((ev): ev is Extract<AgentEvent, { type: "subagent" }> => ev.type === "subagent");

  const startEvent = subagentEvents.find((ev) => ev.phase === "start");
  const toolEvents = subagentEvents.filter((ev) => ev.phase === "tool");
  const blockedEvents = subagentEvents.filter((ev) => ev.phase === "blocked");
  const doneEvent = subagentEvents.find((ev) => ev.phase === "done");

  const isDone = doneEvent != null;
  const hasBlocked = blockedEvents.length > 0;

  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {/* 子代理标签行（角色名 + 状态） */}
      <Marker className="py-1 text-small">
        <MarkerIcon>
          {isActive && !isDone ? (
            <ThinkingSpark size={14} />
          ) : isDone ? (
            <HugeiconsIcon
              icon={doneEvent.success === false ? Alert02Icon : SuccessIcon}
              size={14}
              className={doneEvent.success === false ? "text-[color:var(--tone-alarm)]" : "text-muted-foreground"}
            />
          ) : (
            <HugeiconsIcon icon={Loading03Icon} size={14} className="text-muted-foreground" />
          )}
        </MarkerIcon>
        <MarkerContent>
          <span className={isActive && !isDone ? "shimmer shimmer-color-primary text-muted-foreground" : "text-muted-foreground"}>
            {startEvent?.summary ?? label}
            {isDone && doneEvent.success === false ? " · 失败" : ""}
          </span>
        </MarkerContent>
      </Marker>

      {/* 工具步骤行 */}
      {toolEvents.map((ev, idx) => (
        <Marker key={`tool-${idx}`} className="py-1 text-small pl-4">
          <MarkerContent className="text-muted-foreground truncate">
            {ev.summary ?? ev.toolName ?? "工具"}
            {ev.durationMs != null && ev.durationMs > 0 ? (
              <span className="ml-1 text-caption opacity-60">{(ev.durationMs / 1000).toFixed(1)}s</span>
            ) : null}
            {ev.isError ? <span className="ml-1 text-[color:var(--tone-alarm)]">失败</span> : null}
          </MarkerContent>
        </Marker>
      ))}

      {/* blocked 高亮行（仿 agents/page.tsx「停在确认门」） */}
      {blockedEvents.map((ev, idx) => (
        <div
          key={`blocked-${idx}`}
          className="flex items-start gap-2 rounded px-2 py-1 text-meta fa-toned"
          style={{ "--tone": "var(--tone-notice)" } as CSSProperties}
        >
          <span
            className="fa-tone-pill shrink-0 font-medium whitespace-nowrap"
            style={{ "--tone": "var(--tone-notice)" } as CSSProperties}
          >
            停在确认门
          </span>
          <span className="flex-1 min-w-0 truncate">
            {ev.summary ?? ev.toolName ?? "高风险动作已拦截"}
          </span>
        </div>
      ))}

      {/* 完成行（仅在 done 且有明确状态时） */}
      {isDone && !isActive && !hasBlocked ? (
        <Marker className="py-1 text-small pl-4">
          <MarkerContent className="text-muted-foreground">
            {doneEvent.success ? "完成" : "失败"}
            {doneEvent.durationMs != null && doneEvent.durationMs > 0 ? (
              <span className="ml-1 text-caption opacity-60">{(doneEvent.durationMs / 1000).toFixed(1)}s</span>
            ) : null}
          </MarkerContent>
        </Marker>
      ) : null}
    </div>
  );
}
