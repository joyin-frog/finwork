"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { getCalendarContext, type CalendarContext } from "@/lib/domain/tax-calendar";
import type { CockpitSummary } from "./types";
import { AttentionSection } from "./attention-section";
import { BusinessMetricsCard } from "./business-metrics-card";
import { CashObligationsCard } from "./cash-obligations-card";
import { ComplianceStrip } from "./compliance-strip";
import { DispatchInput } from "./dispatch-input";
import { MetricStrip } from "./metric-strip";
import { PeriodBadge } from "./period-badge";
import { RecentWorkCard } from "./recent-work-card";
import { TeamPanel } from "./team-panel";
import { TeamGrowthHint } from "./team-growth-hint";
import { FinanceCalendarCard } from "./finance-calendar-card";

function TodayDate() {
  const [dateStr, setDateStr] = useState("");
  useEffect(() => {
    setDateStr(new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }));
  }, []);
  return <span className="text-body text-muted-foreground">{dateStr}</span>;
}

export default function CockpitPage() {
  const [summary, setSummary] = useState<CockpitSummary | null>(null);
  const [calendar, setCalendar] = useState<CalendarContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cockpit/summary");
      const json = await res.json();
      if (json.ok) setSummary(json.data);
      else setError(json.error || "加载失败");
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setCalendar(getCalendarContext(new Date()));
    fetchSummary();
  }, [fetchSummary]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="relative flex items-center gap-3 pr-5 h-11 shrink-0">
        <DragHandle />
        <SidebarToggle />
        <h1 className="text-title">总览</h1>
        <TodayDate />
        <PeriodBadge calendar={calendar} />
        <div className="ml-auto">
          <Button variant="ghost" size="icon" onClick={fetchSummary} aria-label="刷新数据">
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6 flex flex-col gap-6">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-body text-muted-foreground">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={fetchSummary}>重试</Button>
          </div>
        ) : (
          <>
            <DispatchInput calendar={calendar} />
            <AttentionSection items={summary?.attention ?? []} calendar={calendar} />
            <MetricStrip calendar={calendar} summary={summary} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* 左列：经营数据在上，合同收付在下（v1.1 评审决定） */}
              <div className="lg:col-span-2 flex flex-col gap-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <BusinessMetricsCard business={summary?.business ?? null} />
                  <RecentWorkCard items={summary?.recentWork ?? []} />
                </div>
                <CashObligationsCard obligations={summary?.obligations ?? []} />
              </div>

              {/* 右列：团队面板（有记录）或生长引导卡（冷启动），日历在下 */}
              <div className="flex flex-col gap-4">
                {(summary?.team ?? []).length > 0 ? (
                  <TeamPanel team={summary!.team} />
                ) : (
                  <TeamGrowthHint />
                )}
                <FinanceCalendarCard calendar={calendar} />
              </div>
            </div>

            {/* 薪税 / 发票 / 报销：周期性合规，降权为一行细条 */}
            <ComplianceStrip payroll={summary?.payroll ?? null} invoices={summary?.invoices ?? null} />
          </>
        )}
      </div>
    </div>
  );
}
