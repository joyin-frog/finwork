"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { TrustBadge } from "@/app/shared/trust-badge";
import type { AttentionItem } from "@/lib/domain/attention";
import type { CalendarContext } from "@/lib/domain/tax-calendar";
import { getCockpitSuggestions } from "@/lib/domain/cockpit-suggestions";
import { ROLE_UI, ROLE_LABELS } from "@/lib/domain/role-ui";
import { cn } from "@/lib/utils";

const DEFAULT_VISIBLE = 5;

function AttentionCard({ item }: { item: AttentionItem }) {
  const action = item.actions[0];
  const isGate = item.source === "gate";
  const roleUi = isGate && item.roleId ? ROLE_UI[item.roleId as keyof typeof ROLE_UI] : null;
  const pillTone = roleUi ? roleUi.tone : "--tone-notice";

  const body = (
    <>
      <span
        className={`fa-tone-dot shrink-0 ${item.severity === "urgent" ? "fa-dot-pulse" : ""}`}
        style={{ "--tone": item.severity === "urgent" ? "var(--tone-alarm)" : "var(--tone-notice)" } as CSSProperties}
        aria-label={item.severity === "urgent" ? "紧急" : "普通"}
      />
      <span
        // 行首已有严重度点，胶囊去掉 ::before 色点，避免双点
        className="fa-tone-pill text-meta shrink-0 before:hidden"
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
        <span
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none")}
        >
          {action.label}
        </span>
      )}
    </>
  );

  const rowClass = "flex items-center gap-3 px-4 py-2.5";

  // 有主动作：整卡可点（单一入口，不嵌套按钮）
  if (action) {
    return (
      <Link
        href={action.href}
        // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
        className={cn(
          surfaceVariants({ level: "card", edge: "hairline", shape: "control" }),
          rowClass,
          "hover:bg-accent/40 transition-colors active:translate-y-px"
        )}
      >
        {body}
      </Link>
    );
  }

  return (
    <Surface level="card" edge="hairline" shape="control" className={rowClass}>
      {body}
    </Surface>
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
