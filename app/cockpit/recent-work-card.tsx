"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_UI, ROLE_LABELS } from "@/lib/domain/role-ui";
import type { RecentWorkItem } from "@/lib/db/sqlite";
import { relativeTime } from "@/lib/utils/relative-time";

/** ≤8 条限制：由 listRecentWorkItems(8) 保证；此处用常量记录意图。 */
const MAX_ITEMS = 8;

function StatusDot({ status }: { status: RecentWorkItem["status"] }) {
  if (status === "running") {
    return (
      <span
        className="fa-tone-dot fa-dot-pulse shrink-0"
        style={{ "--tone": "var(--color-primary)" } as CSSProperties}
        aria-label="进行中"
      />
    );
  }
  if (status === "error") {
    return (
      <span
        className="fa-tone-dot shrink-0"
        style={{ "--tone": "var(--tone-alarm)" } as CSSProperties}
        aria-label="出错"
      />
    );
  }
  // done
  return (
    <span
      className="fa-tone-dot shrink-0"
      style={{ "--tone": "var(--tone-ok)" } as CSSProperties}
      aria-label="已完成"
    />
  );
}

function RoleChip({ roleId }: { roleId: string }) {
  const ui = ROLE_UI[roleId as keyof typeof ROLE_UI];
  const label = ROLE_LABELS[roleId] ?? roleId;
  if (!ui) return null;
  return (
    <span
      className="fa-tone-pill text-meta shrink-0"
      style={{ "--tone": `var(${ui.tone})` } as CSSProperties}
    >
      {label}
    </span>
  );
}

function WorkRow({ item }: { item: RecentWorkItem }) {
  const chips = item.roleIds.slice(0, 2);
  return (
    <Link
      href={`/chat/recent?id=${item.conversationId}`}
      className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent/40 transition-colors group"
    >
      <StatusDot status={item.status} />
      <span className="flex-1 min-w-0 text-body truncate group-hover:text-foreground">
        {item.title}
      </span>
      {chips.map((roleId) => (
        <RoleChip key={roleId} roleId={roleId} />
      ))}
      <span className="text-meta text-muted-foreground shrink-0 tabular-nums">
        {relativeTime(item.updatedAt)}
      </span>
    </Link>
  );
}

export function RecentWorkCard({ items }: { items: RecentWorkItem[] }) {
  // 最多 MAX_ITEMS 条（server 侧已限制，前端做防御截断）
  const visible = items.slice(0, MAX_ITEMS);

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle>最近工作</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-0.5 px-2">
        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
            <p className="text-body text-muted-foreground">还没有工作记录</p>
            <Link
              href="/chat/new"
              className="text-meta px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors"
            >
              从派第一个活开始
            </Link>
          </div>
        ) : (
          visible.map((item) => (
            <WorkRow key={item.conversationId} item={item} />
          ))
        )}
      </CardContent>
    </Card>
  );
}
