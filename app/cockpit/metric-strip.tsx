"use client";

import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { Calendar03Icon, ArrowUp01Icon, ArrowDown01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Card, CardContent } from "@/components/ui/card";
import { AnimatedNumber } from "@/app/shared/animated-number";
import type { CalendarContext } from "@/lib/domain/tax-calendar";
import { summarizeObligations, formatAmount, type ObligationTotals } from "@/lib/domain/cash-obligations";
import type { CockpitSummary } from "./types";

/** 距申报截止随状态换色:今天=报警 → ≤3天=警告 → ≤7天=提醒 → 其余=中性。 */
function deadlineTone(daysLeft: number): string {
  if (daysLeft <= 0) return "var(--tone-alarm)";
  if (daysLeft <= 3) return "var(--tone-warn)";
  if (daysLeft <= 7) return "var(--tone-notice)";
  return "var(--tone-neutral)";
}

/** 收付 KPI 副文案:已填合计金额(+ 表示另有未填额);无到期→「本月无到期」(红线4 不编)。 */
function obligationDelta(t: ObligationTotals): string {
  if (t.count === 0) return "本月无到期";
  if (t.amount === 0 && t.unknownAmount > 0) return `${t.unknownAmount} 笔未填额`;
  return t.unknownAmount > 0 ? `${formatAmount(t.amount)}+` : formatAmount(t.amount);
}

function MetricCard({ icon: Icon, label, value, delta, tone }: {
  icon: IconSvgElement;
  label: string;
  value: number | null;
  delta: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-4">
        <div
          className={`flex size-8 shrink-0 items-center justify-center rounded-md ${tone ? "fa-toned" : "bg-muted text-muted-foreground"}`}
          style={tone ? ({ "--tone": tone } as CSSProperties) : undefined}
        >
          <HugeiconsIcon icon={Icon} size={16} aria-hidden />
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-meta text-muted-foreground">{label}</span>
          <strong className="text-figure tabular-nums leading-none">
            {value != null ? <AnimatedNumber value={value} /> : "--"}
          </strong>
          <em className="text-meta text-muted-foreground not-italic">{delta}</em>
        </div>
      </CardContent>
    </Card>
  );
}

export function MetricStrip({ calendar, summary }: { calendar: CalendarContext | null; summary: CockpitSummary | null }) {
  const deadline = calendar?.deadlines[0] ?? null;
  const obl = summary ? summarizeObligations(summary.obligations) : null;
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      <MetricCard
        icon={Calendar03Icon}
        label="距申报截止"
        value={deadline ? deadline.daysLeft : null}
        delta={deadline ? `${deadline.day} 日截止` : "本月已过申报期"}
        tone={deadline ? deadlineTone(deadline.daysLeft) : undefined}
      />
      <MetricCard
        icon={ArrowUp01Icon}
        label="本月应付·合同"
        value={obl ? obl.payable.count : null}
        delta={obl ? obligationDelta(obl.payable) : ""}
        tone={obl && obl.payable.count > 0 ? "var(--tone-warn)" : undefined}
      />
      <MetricCard
        icon={ArrowDown01Icon}
        label="本月应收·合同"
        value={obl ? obl.receivable.count : null}
        delta={obl ? obligationDelta(obl.receivable) : ""}
        tone={obl && obl.receivable.count > 0 ? "var(--tone-ok)" : undefined}
      />
      <MetricCard
        icon={CheckListIcon}
        label="待办"
        value={summary ? summary.todos.length : null}
        delta={summary && summary.todos.some((t) => t.severity === "urgent") ? "含紧急事项" : "按当前节点推导"}
        tone={
          summary && summary.todos.some((t) => t.severity === "urgent")
            ? "var(--tone-alarm)"
            : summary && summary.todos.length > 0
              ? "var(--tone-notice)"
              : undefined
        }
      />
    </div>
  );
}
