"use client";

import type { CSSProperties } from "react";
import { filingUrgency, type CalendarContext } from "@/lib/domain/tax-calendar";

/**
 * PeriodBadge — 期间徽章（spec §4.2）
 *
 * 平峰（windows 为空）不渲染；仅显优先级最高的一枚（filing > payroll_prep > closing）。
 * filing 用 filingUrgency 配色；payroll_prep / closing 固定 notice。
 */
export function PeriodBadge({ calendar }: { calendar: CalendarContext | null }) {
  if (!calendar || calendar.windows.length === 0) return null;

  // 优先级：filing > payroll_prep > closing
  const windows = calendar.windows;
  const hasFiling = windows.includes("tax_filing");
  const hasPayrollPrep = windows.includes("payroll_prep");
  const hasClosing = windows.includes("closing");

  let label: string;
  let tone: string;

  if (hasFiling) {
    const daysLeft = calendar.deadlines[0]?.daysLeft ?? 0;
    const urgency = filingUrgency(daysLeft);
    tone = `var(--tone-${urgency})`;
    label = `报税期 · 距截止 ${daysLeft} 天`;
  } else if (hasPayrollPrep) {
    tone = "var(--tone-notice)";
    label = "算薪窗口";
  } else if (hasClosing) {
    tone = "var(--tone-notice)";
    label = "月末结账";
  } else {
    return null;
  }

  return (
    <span
      className="fa-tone-pill text-meta"
      style={{ "--tone": tone } as CSSProperties}
      title={calendar.windows.map((w) => {
        if (w === "tax_filing") return `报税期（${calendar.deadlines[0]?.daysLeft ?? 0} 天）`;
        if (w === "payroll_prep") return "算薪窗口";
        if (w === "closing") return "月末结账";
        return w;
      }).join(" · ")}
    >
      {label}
    </span>
  );
}
