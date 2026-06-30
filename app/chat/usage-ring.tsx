"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UsageData, UsageWindow } from "./use-usage";

// 进度环颜色阈值(与对话区红字共用 token):正常蓝 / 接近橙 / 满额红。
function ringColor(pct: number): string {
  if (pct >= 95) return "var(--tone-alarm)";
  if (pct >= 80) return "var(--tone-warn)";
  return "var(--primary)";
}

function fmtReset(resetAt: number, kind: "5h" | "week"): string {
  const d = new Date(resetAt);
  return kind === "5h"
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function Ring({ pct, size = 20, stroke = 2.5 }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const color = ringColor(clamped);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function UsageBar({ label, win, kind }: { label: string; win: UsageWindow; kind: "5h" | "week" }) {
  const pct = Math.max(0, Math.min(100, win.pct));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-small">
        <span className="text-foreground">{label}</span>
        <span className="text-meta text-muted-foreground">
          {fmtReset(win.resetAt, kind)} 重置 · {pct}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: ringColor(pct) }} />
      </div>
    </div>
  );
}

/** 5h / 周两条额度比例条;进度环浮层与设置「用量」页共用。只显示百分比与重置时刻,不露绝对数与上限。 */
export function UsageDetail({ usage }: { usage: UsageData }) {
  if (!usage.fivehour || !usage.week) return null;
  return (
    <div className="flex flex-col gap-3">
      <UsageBar label="5 小时额度" win={usage.fivehour} kind="5h" />
      <UsageBar label="每周额度" win={usage.week} kind="week" />
    </div>
  );
}

/** 输入框旁的用量进度环;显示更吃紧窗口的百分比,点击弹出 5h/周两条额度浮层。未启用/无数据时不渲染。 */
export function UsageRing({ usage }: { usage: UsageData | null }) {
  if (!usage?.enabled || !usage.fivehour || !usage.week) return null;
  const maxPct = Math.max(usage.fivehour.pct, usage.week.pct);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
          aria-label={`用量 ${maxPct}%，点击查看额度`}
          title={`用量 ${maxPct}%`}
        >
          <Ring pct={maxPct} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64 p-3">
        <div className="mb-2 text-meta text-muted-foreground">用量额度</div>
        <UsageDetail usage={usage} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
