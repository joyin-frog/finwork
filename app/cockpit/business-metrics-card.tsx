"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { BarChartIcon, ChartDecreaseIcon, ChartIncreaseIcon } from "@hugeicons/core-free-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrustBadge } from "@/app/shared/trust-badge";
import { deriveTrustTier } from "@/lib/domain/trust-tier";
import type { TrustSource } from "@/lib/domain/trust-tier";
import type { BusinessOverview, BusinessPeriodView } from "@/lib/db/finance-store";

type ViewKey = "month" | "quarter" | "year";

function formatAmount(n: number | null): string {
  if (n === null) return "--";
  const abs = Math.abs(n);
  if (abs >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString("zh-CN");
}

function PctChange({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur === null || prev === null || prev === 0) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span className="flex items-center gap-1 text-meta text-muted-foreground">
      {up ? <HugeiconsIcon icon={ChartIncreaseIcon} size={11} aria-hidden /> : <HugeiconsIcon icon={ChartDecreaseIcon} size={11} aria-hidden />}
      {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

function MetricRow({
  label,
  value,
  prev,
  profitSign,
}: {
  label: string;
  value: number | null;
  prev: number | null;
  profitSign?: boolean;
}) {
  const tone =
    profitSign && value !== null
      ? value >= 0
        ? "var(--tone-ok)"
        : "var(--tone-alarm)"
      : undefined;

  return (
    <div className="flex items-center justify-between">
      <span className="text-meta text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <PctChange cur={value} prev={prev} />
        <strong
          className="text-small tabular-nums"
          style={tone ? ({ color: tone } as CSSProperties) : undefined}
        >
          {formatAmount(value)}
        </strong>
      </div>
    </div>
  );
}

const VIEW_LABELS: Record<ViewKey, string> = { month: "月", quarter: "季", year: "年" };

const EMPTY_PROMPT = encodeURIComponent(
  "请帮我录入最近几个月的经营数据（收入和利润），我来报数字。"
);

const VALID_TRUST_SOURCES: TrustSource[] = ["engine_calc", "file_parse", "user_dictated", "llm_inferred"];

function toTrustSource(s: string | null | undefined): TrustSource {
  if (s && (VALID_TRUST_SOURCES as string[]).includes(s)) return s as TrustSource;
  return "user_dictated";
}

export function BusinessMetricsCard({ business }: { business: BusinessOverview | null }) {
  const [view, setView] = useState<ViewKey>("month");

  const data: BusinessPeriodView | null = business ? business[view] : null;
  const hasData = data && (data.revenue !== null || data.profit !== null);

  // 信任标签（spec §4.3）：从最近一条数据的 source 推导
  const trustTier = business?.source
    ? deriveTrustTier(toTrustSource(business.source), "none")
    : null;

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div
              className="flex size-6 items-center justify-center rounded-md fa-toned"
              style={{ "--tone": "var(--tone-neutral)" } as CSSProperties}
            >
              <HugeiconsIcon icon={BarChartIcon} size={13} aria-hidden />
            </div>
            <CardTitle>经营数据</CardTitle>
            {trustTier && (
              <TrustBadge
                tier={trustTier}
                sourceLabel={business?.source === "user_dictated" ? "用户口述" : undefined}
              />
            )}
          </div>
          {/* Segmented control */}
          <div className="flex rounded-md border border-border overflow-hidden text-meta">
            {(["month", "quarter", "year"] as ViewKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setView(k)}
                aria-pressed={view === k}
                className={`px-2.5 py-1 transition-colors ${
                  view === k
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {VIEW_LABELS[k]}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {hasData ? (
          <>
            <MetricRow label="收入" value={data.revenue} prev={data.prevRevenue} />
            <MetricRow label="利润" value={data.profit} prev={data.prevProfit} profitSign />
            <p className="text-meta text-muted-foreground">
              {data.label}
              {view !== "month" && data.monthsCovered > 0
                ? ` · 已录 ${data.monthsCovered} 个月`
                : ""}
            </p>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
            <p className="text-body text-muted-foreground">暂无经营数据</p>
            <Link
              href={`/chat/new?prompt=${EMPTY_PROMPT}`}
              className="text-meta px-3 py-1.5 rounded-md border border-border hover:bg-accent transition-colors"
            >
              上传利润表或口述数字
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
