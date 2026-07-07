"use client";

/**
 * attention-panel.tsx — 等你拍板区（智能体页顶部）
 *
 * 与 cockpit/AttentionSection 同源：数据来自 /api/agents 路由，
 * 路由内使用与 cockpit 相同的 deriveAttentionItems/blockedDispatchToAttentionItem/sortAttentionItems。
 * 客户端只负责渲染，不重复计算。
 */

import type { CSSProperties } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import type { AttentionItem } from "@/lib/domain/attention";
import { ROLE_UI, ROLE_LABELS } from "@/lib/domain/role-ui";
import { TrustBadge } from "@/app/shared/trust-badge";

function AttentionCard({ item }: { item: AttentionItem }) {
  const action = item.actions[0];
  const isGate = item.source === "gate";
  const roleUi = isGate && item.roleId ? ROLE_UI[item.roleId as keyof typeof ROLE_UI] : null;
  const pillTone = roleUi ? roleUi.tone : "--tone-notice";

  return (
    <Surface level="card" edge="hairline" shape="control" className="flex items-center gap-3 px-4 py-2.5">
      <span
        className={`fa-tone-dot shrink-0 ${item.severity === "urgent" ? "fa-dot-pulse" : ""}`}
        style={{
          "--tone": item.severity === "urgent" ? "var(--tone-alarm)" : "var(--tone-notice)",
        } as CSSProperties}
        aria-label={item.severity === "urgent" ? "紧急" : "普通"}
      />
      <span
        className="fa-tone-pill text-meta shrink-0"
        style={{ "--tone": `var(${pillTone})` } as CSSProperties}
      >
        {item.sourceLabel}
        {isGate && item.roleId && ` · ${(ROLE_LABELS as Record<string, string>)[item.roleId] ?? item.roleId}`}
      </span>
      {isGate && <TrustBadge tier="pending" />}
      <span className="text-body flex-1 min-w-0 truncate">{item.title}</span>
      {action && (
        <Link href={action.href} className="shrink-0">
          <Button variant="outline" size="sm">
            {action.label}
          </Button>
        </Link>
      )}
    </Surface>
  );
}

type AttentionPanelProps = {
  items: AttentionItem[];
};

export function AttentionPanel({ items }: AttentionPanelProps) {
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-title font-semibold">等你拍板</h2>
        <span className="text-meta text-muted-foreground">{items.length} 项</span>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <AttentionCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
