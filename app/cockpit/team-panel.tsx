"use client";

// 团队面板（CV-3 §5.2）
// 低拟人红线：无头像、无性格文案、无第一人称；唯一的「人味」是中文岗位名。
// 生长时刻：localStorage key "cockpit.seenRoleIds" 记录已见角色；新角色播放 fa-team-enter 入场动画。
// prefers-reduced-motion: fa-team-enter 只在 globals.css @media(no-preference) 内定义，降级时直接出现。

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { TeamRoleItem } from "./types";
import { ROLE_UI } from "@/lib/domain/role-ui";

const SEEN_KEY = "cockpit.seenRoleIds";

function loadSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeenIds(ids: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 60) return min <= 1 ? "刚刚" : `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

export function TeamPanel({ team }: { team: TeamRoleItem[] }) {
  const [newRoleIds, setNewRoleIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = loadSeenIds();
    const newIds = new Set<string>();
    for (const item of team) {
      if (!seen.has(item.roleId)) {
        newIds.add(item.roleId);
        seen.add(item.roleId);
      }
    }
    if (newIds.size > 0) {
      setNewRoleIds(newIds);
      saveSeenIds(seen);
    }
  }, [team]);

  // team 为空时不渲染整卡（§5.2 空态）
  if (team.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-2">
      <h2 className="text-sm font-semibold">我的团队</h2>
      <div className="flex flex-col gap-1.5">
        {team.map((item) => {
          const ui = ROLE_UI[item.roleId as keyof typeof ROLE_UI];
          const tone = ui?.tone ?? "--tone-neutral";
          const isNew = newRoleIds.has(item.roleId);

          return (
            <div
              key={item.roleId}
              // 新角色触发入场动画（fa-team-enter 在 globals.css @media prefers-reduced-motion:no-preference 内定义）
              // prefers-reduced-motion: reduce 时无 animation，直接出现
              className={`flex items-center gap-3 py-1 ${isNew ? "fa-team-enter" : ""}`}
              title={item.lastSummary ?? undefined}
            >
              {/* 圆形域图标（fa-toned 底，角色 tone） */}
              <span
                className="fa-toned shrink-0 flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold select-none"
                style={{ "--tone": `var(${tone})` } as CSSProperties}
                aria-hidden="true"
              >
                {item.name.slice(0, 1)}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{item.name}</span>
                <span className="text-xs text-muted-foreground ml-2 truncate">{item.charter}</span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                {item.dispatchCount} 次{item.lastAt ? ` · ${relativeTime(item.lastAt)}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
