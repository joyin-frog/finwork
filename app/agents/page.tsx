"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { ROLE_UI } from "@/lib/domain/role-ui";

// ─── Types ─────────────────────────────────────────────────────────────────

type SkillEntry = {
  name: string;
  description: string;
};

type InvoiceStats = {
  total: number;
  addedThisMonth: number;
};

type AgentRosterItem = {
  roleId: string;
  name: string;
  domain: string;
  charter: string;
  dataScope: string[];
  skills: SkillEntry[];
  available: boolean;
  userDisabled: boolean;
  dispatchCount: number;
  lastAt: string | null;
  invoiceStats?: InvoiceStats;
};

type DispatchRow = {
  id: number;
  roleId: string;
  label: string | null;
  summary: string | null;
  status: string;
  blockedReason: string | null;
  conversationId: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── DispatchList（台账区，按需懒加载） ────────────────────────────────────

function DispatchList({ roleId, initialDispatches }: { roleId: string; initialDispatches?: DispatchRow[] }) {
  const [rows, setRows] = useState<DispatchRow[] | null>(initialDispatches ?? null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (rows !== null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/dispatches?roleId=${encodeURIComponent(roleId)}&limit=5`);
      const json = await res.json();
      if (json.ok) setRows(json.data.rows);
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
    return <p className="text-meta text-muted-foreground py-2">加载中…</p>;
  }

  if (!rows || rows.length === 0) {
    return <p className="text-meta text-muted-foreground py-2">暂无工作记录</p>;
  }

  // 「停在确认门」的 blocked 行前置
  const sorted = [...rows].sort((a, b) => {
    const aBlocked = a.blockedReason != null ? 0 : 1;
    const bBlocked = b.blockedReason != null ? 0 : 1;
    return aBlocked - bBlocked;
  });

  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {sorted.map((row) => {
        const isBlocked = row.blockedReason != null;
        const href = row.conversationId ? `/chat/recent?id=${row.conversationId}` : undefined;

        const inner = (
          <div
            className={`flex items-start gap-2 rounded px-2 py-1.5 text-meta ${
              isBlocked ? "bg-[color:var(--tone-notice,hsl(var(--muted)))/0.12] border border-[color:var(--tone-notice,hsl(var(--border)))]" : "bg-muted/40"
            }`}
          >
            {isBlocked && (
              <span className="shrink-0 text-xs font-medium px-1.5 py-0.5 rounded bg-[color:var(--tone-notice,hsl(var(--muted)))] text-[color:var(--tone-notice-fg,hsl(var(--foreground)))] whitespace-nowrap">
                停在确认门
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

      <p className="text-meta text-muted-foreground pt-1">
        已显示最近 {rows.length} 条派发记录
      </p>
    </div>
  );
}

// ─── AgentRow（花名册行 + 展开详情） ────────────────────────────────────────

function AgentRow({ agent }: { agent: AgentRosterItem }) {
  const [expanded, setExpanded] = useState(false);
  const ui = ROLE_UI[agent.roleId as keyof typeof ROLE_UI];
  const tone = ui?.tone ?? "--tone-neutral";
  const isDisabled = !agent.available || agent.userDisabled;

  const promptText = encodeURIComponent(`让${agent.name}帮我处理…`);
  const dispatchHref = `/chat/new?prompt=${promptText}`;

  return (
    <div
      className={`rounded-lg border border-border bg-card transition-colors ${isDisabled ? "opacity-60" : ""}`}
    >
      {/* 主行 */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {/* 圆形域图标 */}
        <span
          className="fa-toned shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold select-none"
          style={{ "--tone": `var(${tone})` } as CSSProperties}
          aria-hidden="true"
        >
          {agent.name.slice(0, 1)}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{agent.name}</span>
            <span className="text-meta text-muted-foreground">{agent.domain}</span>
            {isDisabled && (
              <span className="text-meta px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                尚未启用
              </span>
            )}
          </div>
          <p className="text-meta text-muted-foreground truncate">{agent.charter}</p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-meta text-muted-foreground whitespace-nowrap">
            {agent.dispatchCount} 次
            {agent.lastAt ? ` · ${relativeTime(agent.lastAt)}` : ""}
          </span>
          {!isDisabled && (
            <Link
              href={dispatchHref}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0"
            >
              <Button variant="outline" size="sm">
                派活
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-4">
          {/* 数据权限域 */}
          <div>
            <p className="text-meta font-medium text-muted-foreground mb-1.5">数据权限</p>
            <div className="flex flex-wrap gap-1.5">
              {agent.dataScope.map((scope) => (
                <span
                  key={scope}
                  className="text-meta px-2 py-0.5 rounded-full border border-border bg-muted/50"
                >
                  {scope}
                </span>
              ))}
            </div>
          </div>

          {/* 会做的活（技能） */}
          {agent.skills.length > 0 && (
            <div>
              <p className="text-meta font-medium text-muted-foreground mb-1.5">会做的活</p>
              <div className="flex flex-wrap gap-1.5">
                {agent.skills.map((skill) => (
                  <span
                    key={skill.name}
                    title={skill.description}
                    className="text-meta px-2 py-0.5 rounded-full border border-border bg-muted/50 cursor-help"
                  >
                    {skill.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* bookkeeper 专项：发票台账计数 */}
          {agent.invoiceStats && (
            <div>
              <p className="text-meta font-medium text-muted-foreground mb-1.5">发票台账</p>
              <div className="flex gap-4 text-body">
                <span>本月新增 {agent.invoiceStats.addedThisMonth} 张</span>
                <span className="text-muted-foreground">累计 {agent.invoiceStats.total} 张</span>
              </div>
            </div>
          )}

          {/* 工作台账 */}
          <div>
            <p className="text-meta font-medium text-muted-foreground mb-1">工作台账</p>
            <DispatchList roleId={agent.roleId} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const [roster, setRoster] = useState<AgentRosterItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agents");
      const json = await res.json();
      if (json.ok) setRoster(json.data.roster);
      else setError(json.error || "加载失败");
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRoster();
  }, [fetchRoster]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="relative flex items-center gap-3 pr-5 h-11 shrink-0">
        <DragHandle />
        <SidebarToggle />
        <h1 className="text-title">智能体</h1>
        <span className="text-body text-muted-foreground">
          你的财务班子：谁在岗、能碰什么、干过什么
        </span>
      </header>

      <div className="flex-1 overflow-auto p-6 flex flex-col gap-4">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-body text-muted-foreground">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={fetchRoster}>重试</Button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
            加载中…
          </div>
        ) : (
          roster?.map((agent) => (
            <AgentRow key={agent.roleId} agent={agent} />
          ))
        )}
      </div>
    </div>
  );
}
