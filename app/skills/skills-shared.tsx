"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Add01Icon } from "@hugeicons/core-free-icons";

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type SkillSource = "bundled" | "user";

export type SkillSummary = {
  name: string;
  title: string;
  summary: string;
  requires: string;
  starter: string;
  description: string;
  /** 分类:finance/file-tool；用户技能默认空 */
  category: string;
  source: SkillSource;
  editable: boolean;
  enabled: boolean;
};

export type SkillFileEntry = { path: string; isDir: boolean; size: number };

// ── 常量 ─────────────────────────────────────────────────────────────────────

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 渲染预览时去掉开头的 YAML frontmatter(--- … ---),只看正文,避免把 name/description 当正文显示。 */
export function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  return { ok: Boolean(json.ok), data: json.data, error: json.error, status: res.status };
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

/** 小工具按钮:只放图标,说明走 hover(同主菜单搜索/侧栏按钮的范式)。 */
export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  tone = "default",
  size = 16,
}: {
  icon: typeof Add01Icon;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "destructive";
  size?: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          disabled={disabled}
          className={cn(
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            "inline-grid place-items-center size-7 rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-50",
            tone === "destructive"
              ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              : active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={icon} size={size} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** 系统/个人 标签:用色块+文字区分,系统=中性,个人=品牌色描边。 */
export function SourceTag({ source }: { source: SkillSource }) {
  return (
    <span
      className={cn(
        // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
        "shrink-0 rounded px-1.5 py-0.5 text-meta",
        source === "user" ? "text-[var(--primary)] bg-[var(--primary)]/8" : "text-muted-foreground bg-muted",
      )}
    >
      {source === "user" ? "个人" : "系统"}
    </span>
  );
}
