"use client";

import type { ReactNode, Ref } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { NoteIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { SkillRef } from "@/app/chat/chat-types";

/** 浮层里的技能项:summary 给人扫选用;description 仍留给引用/Agent。 */
export type PickerSkill = {
  name: string;
  description: string;
  /** 短说明(SKILL.md summary);缺省时弹窗回退到 description 首句。 */
  summary?: string;
  source: "bundled" | "user";
};

/** 技能名 slug 校验(与后端 skills-store 同口径),供 / 弹窗的自由输入判断是否可引用。 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** 弹窗短说明:优先 summary;否则取 description 首句(到 。！？.!? 或换行)。 */
export function skillPickerBlurb(summary: string | undefined, description: string): string {
  const short = summary?.trim();
  if (short) return short;
  const full = description.trim();
  if (!full) return "";
  const m = full.match(/^[^。！？.!?\n]+[。！？.!?]?/);
  return (m?.[0] ?? full).trim();
}

/** 技能选择浮层:名称 + 一行短说明(summary);完整 description 仍随引用传给 Agent。 */
export function SkillPopup({
  skills,
  customName,
  selectedIndex,
  selectSkill,
  setSelectedIndex,
}: {
  skills: PickerSkill[];
  customName: string | null;
  selectedIndex: number;
  selectSkill: (skill: SkillRef) => void;
  setSelectedIndex: (index: number) => void;
}) {
  const customIndex = customName ? skills.length : -1;
  const row = (
    key: string,
    index: number,
    name: string,
    description: string,
    blurb: string,
    tag: string | null,
  ) => (
    <button
      key={key}
      className={index === selectedIndex ? "selected" : ""}
      type="button"
      role="option"
      aria-selected={index === selectedIndex}
      onClick={() => selectSkill({ name, description })}
      onMouseEnter={() => setSelectedIndex(index)}
    >
      <HugeiconsIcon icon={NoteIcon} size={16} className="skill-icon" />
      <span className="skill-body">
        <span className="skill-head">
          <span className="skill-name">{name}</span>
          {tag ? <span className="skill-tag">{tag}</span> : null}
        </span>
        {blurb ? <span className="skill-desc">{blurb}</span> : null}
      </span>
    </button>
  );
  return (
    <div className="skill-popup" role="listbox" aria-label="选择技能">
      {skills.length || customName ? (
        <>
          {skills.map((s, index) =>
            row(
              s.name,
              index,
              s.name,
              s.description,
              skillPickerBlurb(s.summary, s.description),
              s.source === "user" ? "个人" : null,
            ),
          )}
          {customName ? row(`__custom_${customName}`, customIndex, customName, "", "自定义引用", null) : null}
        </>
      ) : (
        <div className="skill-empty">暂无可用技能,可在 技能 页里管理</div>
      )}
    </div>
  );
}

/** 转义正则特殊字符(技能名本身已被 isValidSkillName 限制字符集,这里只做防御)。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 匹配 /skillName 整词(前后是空白或首尾),用于在草稿文本里定位需要高亮的引用。 */
function buildSkillTokenPattern(skills: SkillRef[]): RegExp | null {
  if (!skills.length) return null;
  const names = [...skills].sort((a, b) => b.name.length - a.name.length).map((s) => escapeRegExp(s.name));
  return new RegExp(`(?<!\\S)/(?:${names.join("|")})(?!\\S)`, "g");
}

/**
 * 输入框内 /skillName 的高亮镜像层:与 textarea 同宽高、同排版,叠在其后方,
 * 让引用留在正文里(不再挪成上方 chip),只用主色 token 标出来。
 */
export function ComposerHighlightOverlay({
  text,
  skills,
  ref,
}: {
  text: string;
  skills: SkillRef[];
  ref?: Ref<HTMLDivElement>;
}) {
  const pattern = buildSkillTokenPattern(skills);
  const nodes: ReactNode[] = [];
  if (pattern) {
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = pattern.exec(text))) {
      if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
      nodes.push(
        <span key={key++} className="text-[var(--primary)]">
          {match[0]}
        </span>
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  } else {
    nodes.push(text);
  }
  // whitespace-pre-wrap 会把末尾换行折叠掉一行高度,补一个空格保证与 textarea 高度一致。
  if (text.endsWith("\n")) nodes.push(" ");
  return (
    <div ref={ref} aria-hidden className="composer-highlight-overlay text-body py-1 min-h-[24px]">
      {nodes}
    </div>
  );
}

/** 「深度思考」开关:快速/推理二段式 pill,选中项高亮;默认快速 = 用快速模型,选推理 = 用推理模型。 */
export function DeepThinkToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label="模型档位"
      className="inline-flex items-center rounded-full border border-border bg-muted p-0.5 text-small select-none"
    >
      <button
        type="button"
        aria-pressed={!active}
        onClick={() => onToggle(false)}
        className={cn(
          "rounded-full px-2 py-0.5 transition-colors",
          !active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        )}
      >
        快速
      </button>
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onToggle(true)}
        className={cn(
          "rounded-full px-2 py-0.5 transition-colors",
          active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        )}
      >
        推理
      </button>
    </div>
  );
}
