"use client";

import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CalendarContext } from "@/lib/domain/tax-calendar";

/** 申报截止随状态换色:今天=报警 → ≤3天=警告 → ≤7天=提醒 → 其余=中性。 */
function deadlineTone(daysLeft: number): string {
  if (daysLeft <= 0) return "var(--tone-alarm)";
  if (daysLeft <= 3) return "var(--tone-warn)";
  if (daysLeft <= 7) return "var(--tone-notice)";
  return "var(--tone-neutral)";
}

/** 财务日历:申报期 / 算薪窗口 / 月末结账等合规节点。合同收付到期已移至「合同收付总览」卡。 */
export function FinanceCalendarCard({ calendar }: { calendar: CalendarContext | null }) {
  const nearest = calendar?.deadlines[0] ?? null;
  return (
    <Card>
      <CardHeader>
        <div
          className={`flex size-6 items-center justify-center rounded-md ${nearest ? "fa-toned" : "bg-muted text-muted-foreground"}`}
          style={nearest ? ({ "--tone": deadlineTone(nearest.daysLeft) } as CSSProperties) : undefined}
        >
          <HugeiconsIcon icon={Calendar03Icon} size={13} aria-hidden />
        </div>
        <CardTitle>财务日历</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-body">
          当前处于 <strong>{calendar?.windowLabel ?? "--"}</strong>
        </p>
        {calendar && calendar.deadlines.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {calendar.deadlines.map((d) => (
              <li key={d.name} className="flex items-center justify-between text-body">
                <span className="text-muted-foreground">{d.name}（{d.day} 日截止）</span>
                <span className="fa-tone-pill tabular-nums" style={{ "--tone": deadlineTone(d.daysLeft) } as CSSProperties}>
                  {d.daysLeft === 0 ? "今天截止" : <>还剩 {d.daysLeft} 天</>}
                </span>
              </li>
            ))}
          </ul>
        ) : calendar ? (
          <p className="text-body text-muted-foreground">本月申报截止日已过</p>
        ) : null}
        {calendar && <p className="text-meta text-muted-foreground">{calendar.notice}</p>}
      </CardContent>
    </Card>
  );
}
