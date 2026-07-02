"use client";

// 团队面板（CV-3 §5.2 + v3-P2 行内展开）
// 低拟人红线：无头像、无性格文案、无第一人称；唯一的「人味」是中文岗位名。
// prefers-reduced-motion: fa-team-enter 只在 globals.css @media(no-preference) 内定义，降级时直接出现。

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

type DispatchRow = {
  id: number;
  roleId: string;
  label: string | null;
  summary: string | null;
  status: string;
  blockedReason: string | null;
  conversationId: string | null;
  startedAt: string | null;
};

function RoleDispatchExpand({ roleId }: { roleId: string }) {
  const [rows, setRows] = useState<DispatchRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (rows !== null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/dispatches?roleId=${encodeURIComponent(roleId)}&limit=5`);
      const json = await res.json() as { ok: boolean; data?: { rows: DispatchRow[] } };
      if (json.ok && json.data) setRows(json.data.rows);
      else setRows([]);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [roleId, rows]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-xs text-muted-foreground py-1 pl-10">加载中…</p>;
  }

  if (!rows || rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-1 pl-10">暂无工作记录</p>;
  }

  return (
    <div className="flex flex-col gap-1 pl-10 pb-1">
      {rows.map((row) => {
        const isBlocked = row.blockedReason != null && row.blockedReason !== "";
        const href = row.conversationId ? `/chat/recent?id=${row.conversationId}` : undefined;

        const inner = (
          <div className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
            isBlocked
              ? "bg-[color:var(--tone-notice,hsl(var(--muted)))/0.12] border border-[color:var(--tone-notice,hsl(var(--border)))]"
              : "bg-muted/40"
          }`}>
            {isBlocked && (
              <span className="shrink-0 font-medium px-1.5 py-0.5 rounded bg-[color:var(--tone-notice,hsl(var(--muted)))] text-[color:var(--tone-notice-fg,hsl(var(--foreground)))] whitespace-nowrap text-xs">
                待确认
              </span>
            )}
            <span className="flex-1 min-w-0 truncate text-foreground">
              {row.label ?? row.summary ?? `#${row.id}`}
            </span>
            <span className="shrink-0 text-muted-foreground whitespace-nowrap">
              {relativeTime(row.startedAt)}
            </span>
          </div>
        );

        return href ? (
          <Link key={row.id} href={href} className="block hover:no-underline">
            {inner}
          </Link>
        ) : (
          <div key={row.id}>{inner}</div>
        );
      })}
    </div>
  );
}

export function TeamPanel({ team }: { team: TeamRoleItem[] }) {
  const [newRoleIds, setNewRoleIds] = useState<Set<string>>(new Set());
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);

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
      <h2 className="text-sm font-semibold">智能体</h2>
      <div className="flex flex-col gap-1.5">
        {team.map((item) => {
          const ui = ROLE_UI[item.roleId as keyof typeof ROLE_UI];
          const tone = ui?.tone ?? "--tone-neutral";
          const isNew = newRoleIds.has(item.roleId);
          const isExpanded = expandedRoleId === item.roleId;

          function handleRowClick() {
            setExpandedRoleId((prev) => (prev === item.roleId ? null : item.roleId));
          }

          function handleDispatch(e: React.MouseEvent) {
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent("cockpit:prefill-dispatch", {
                detail: { text: `让${item.name}帮我处理` },
              })
            );
          }

          return (
            <div key={item.roleId} className="flex flex-col">
              <div
                className={`flex items-center gap-3 py-1 cursor-pointer select-none rounded px-1 hover:bg-muted/40 transition-colors ${isNew ? "fa-team-enter" : ""}`}
                title={item.lastSummary ?? undefined}
                onClick={handleRowClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleRowClick()}
                aria-expanded={isExpanded}
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
                </div>
                <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                  {item.dispatchCount} 次{item.lastAt ? ` · ${relativeTime(item.lastAt)}` : ""}
                </span>
                {/* 行尾「派活」次动作 → 预填派活入口并聚焦 */}
                <button
                  type="button"
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-muted transition-colors"
                  onClick={handleDispatch}
                  aria-label={`让${item.name}派活`}
                >
                  派活
                </button>
              </div>

              {/* inline 展开：最近 5 条任务 */}
              {isExpanded && <RoleDispatchExpand roleId={item.roleId} />}
            </div>
          );
        })}
      </div>
      <div className="pt-1 border-t border-border">
        <Link href="/agents" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          查看全部 →
        </Link>
      </div>
    </section>
  );
}
