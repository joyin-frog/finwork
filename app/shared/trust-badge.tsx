"use client";

import type { TrustTier } from "@/lib/domain/trust-tier";

/** tier → { 文案, CSS 变量名 } 映射（spec §2.2 表格） */
const TIER_MAP: Record<TrustTier, { label: string; tone: string }> = {
  verified:   { label: "已核实", tone: "--tone-ok" },
  pending:    { label: "待确认", tone: "--tone-warn" },
  inferred:   { label: "推测",   tone: "--tone-neutral" },
  unverified: { label: "未核实", tone: "--tone-unverified" },
};

type Props = {
  tier: TrustTier;
  /** 可选来源短语，如「用户口述」，拼为「未核实 · 用户口述」 */
  sourceLabel?: string;
};

/**
 * TrustBadge — 信任四级标签（spec §2.2）
 *
 * 用法：
 *   <TrustBadge tier="verified" />
 *   <TrustBadge tier="unverified" sourceLabel="用户口述" />
 *
 * 渲染为 fa-tone-pill，容器通过 --tone CSS 变量注入颜色，
 * 与 globals.css 里 .fa-tone-pill 的模式完全一致。
 */
export function TrustBadge({ tier, sourceLabel }: Props) {
  const { label, tone } = TIER_MAP[tier];
  const text = sourceLabel ? `${label} · ${sourceLabel}` : label;

  return (
    <span
      className="fa-tone-pill"
      style={{ "--tone": `var(${tone})` } as React.CSSProperties}
    >
      {text}
    </span>
  );
}
