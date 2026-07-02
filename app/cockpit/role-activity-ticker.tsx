"use client";

/**
 * role-activity-ticker.tsx — 角色工作动态条（D1 切片）
 *
 * 接替 dispatch-input 的位置。
 * - fetch GET /api/agents/activity 获取最近派发活动
 * - 有活动：定时（约 5s）淡入轮换单条「{角色名} {相对时间} {label/summary 首行}」
 * - 无活动：渲染 getCockpitSuggestions(calendar).attentionEmptyHint 一句话
 * - 淡入淡出轮换，不横滚；prefers-reduced-motion 降级直接切换
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ROLE_LABELS } from "@/lib/domain/role-ui";
import { getCockpitSuggestions } from "@/lib/domain/cockpit-suggestions";
import type { CalendarContext } from "@/lib/domain/tax-calendar";

type ActivityRow = {
  id: number;
  roleId: string;
  label: string | null;
  summary: string | null;
  status: string;
  conversationId: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 2) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

function formatRow(row: ActivityRow): string {
  const roleName = ROLE_LABELS[row.roleId] ?? row.roleId;
  const time = relativeTime(row.startedAt);
  const desc = row.label ?? row.summary?.split("\n")[0] ?? "";
  if (row.status === "running") {
    return `${roleName}正在处理${desc ? `：${desc}` : ""}`;
  }
  return [roleName, time, desc].filter(Boolean).join(" · ");
}

export function RoleActivityTicker({ calendar }: { calendar: CalendarContext | null }) {
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  // fetch 动态数据
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/agents/activity?limit=10");
        const json = await res.json() as { ok: boolean; data?: ActivityRow[] };
        if (!cancelled && json.ok && json.data) {
          setActivities(json.data);
          setCurrentIdx(0);
        }
      } catch {
        // 静默失败，降级到无活动空态
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  // 定时轮换（约 5s），淡入淡出
  useEffect(() => {
    if (activities.length <= 1) return;
    const timer = setInterval(() => {
      // 先淡出
      setVisible(false);
      setTimeout(() => {
        setCurrentIdx((prev) => (prev + 1) % activities.length);
        setVisible(true);
      }, 300);
    }, 5000);
    return () => clearInterval(timer);
  }, [activities.length]);

  // 无活动：渲染 getCockpitSuggestions 一句话
  if (activities.length === 0) {
    const hint = calendar ? getCockpitSuggestions(calendar).attentionEmptyHint : null;
    if (!hint) return null;
    return (
      <p className="text-sm text-muted-foreground px-1 py-1">
        {hint}
      </p>
    );
  }

  const row = activities[currentIdx];
  const text = formatRow(row);
  const href = row.conversationId ? `/chat/recent?id=${row.conversationId}` : undefined;

  return (
    <div
      className="text-sm text-muted-foreground px-1 py-1 transition-opacity duration-300 motion-reduce:transition-none"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {href ? (
        <Link
          href={href}
          className="hover:text-foreground transition-colors"
        >
          {text}
        </Link>
      ) : (
        <span>{text}</span>
      )}
    </div>
  );
}
