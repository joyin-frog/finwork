"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TrustBadge } from "@/app/shared/trust-badge";
import type { AttentionItem } from "@/lib/domain/attention";
import type { CalendarContext } from "@/lib/domain/tax-calendar";
import { getCockpitSuggestions } from "@/lib/domain/cockpit-suggestions";
import { ROLE_UI, ROLE_LABELS } from "@/lib/domain/role-ui";

const DEFAULT_VISIBLE = 5;

function AttentionCard({ item }: { item: AttentionItem }) {
  const action = item.actions[0];
  const isGate = item.source === "gate";
  const roleUi = isGate && item.roleId ? ROLE_UI[item.roleId as keyof typeof ROLE_UI] : null;
  const pillTone = roleUi ? roleUi.tone : "--tone-notice";

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5">
      <span
        className={`fa-tone-dot shrink-0 ${item.severity === "urgent" ? "fa-dot-pulse" : ""}`}
        style={{ "--tone": item.severity === "urgent" ? "var(--tone-alarm)" : "var(--tone-notice)" } as CSSProperties}
        aria-label={item.severity === "urgent" ? "紧急" : "普通"}
      />
      <span
        className="fa-tone-pill text-meta shrink-0"
        style={{ "--tone": `var(${pillTone})` } as CSSProperties}
      >
        {item.sourceLabel}
        {isGate && item.roleId && ` · ${(ROLE_LABELS as Record<string, string>)[item.roleId] ?? item.roleId}`}
      </span>
      {isGate && (
        <TrustBadge tier="pending" />
      )}
      <span className="text-body flex-1 min-w-0 truncate">{item.title}</span>
      {action && (
        <Link
          href={action.href}
          className="shrink-0"
        >
          <Button variant="outline" size="sm">
            {action.label}
          </Button>
        </Link>
      )}
    </div>
  );
}

export function AttentionSection({
  items,
  calendar,
}: {
  items: AttentionItem[];
  calendar: CalendarContext | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const suggestions = calendar ? getCockpitSuggestions(calendar) : null;
  const visible = expanded ? items : items.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = items.length - DEFAULT_VISIBLE;

  return (
    <section id="attention" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-title font-semibold">需要你关注</h2>
        {items.length > 0 && (
          <span className="text-meta text-muted-foreground">{items.length} 项</span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-body text-muted-foreground">
          当前没有需要你处理的事
          {suggestions?.attentionEmptyHint ? `  ·  ${suggestions.attentionEmptyHint}` : ""}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {visible.map((item) => (
              <AttentionCard key={item.id} item={item} />
            ))}
          </div>
          {!expanded && hiddenCount > 0 && (
            <button
              className="text-meta text-muted-foreground hover:text-foreground transition-colors self-start"
              onClick={() => setExpanded(true)}
            >
              还有 {hiddenCount} 项
            </button>
          )}
          {expanded && hiddenCount > 0 && (
            <button
              className="text-meta text-muted-foreground hover:text-foreground transition-colors self-start"
              onClick={() => setExpanded(false)}
            >
              收起
            </button>
          )}
        </>
      )}
    </section>
  );
}
