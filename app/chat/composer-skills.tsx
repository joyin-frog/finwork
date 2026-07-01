"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { MagicWand01Icon, Atom01Icon } from "@hugeicons/core-free-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SkillRef } from "@/app/chat/chat-types";

/** 浮层里的技能项:比引用 chip 多一个来源,用于右侧「系统/个人」标签。 */
export type PickerSkill = { name: string; description: string; source: "bundled" | "user" };

/** 技能名 slug 校验(与后端 skills-store 同口径),供 / 弹窗的自由输入判断是否可引用。 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** 技能选择浮层(参考 Claude 技能选单):一行 = 名称 + 右侧小一号截断说明 + 最右「系统/个人」。 */
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
      <HugeiconsIcon icon={MagicWand01Icon} size={16} className="shrink-0 text-muted-foreground" />
      <span className="skill-name">{name}</span>
      <span className="skill-desc">{description}</span>
      {tag ? <span className="skill-tag">{tag}</span> : null}
    </button>
  );
  return (
    <div className="skill-popup" role="listbox" aria-label="选择技能">
      {skills.length || customName ? (
        <>
          {skills.map((s, index) => row(s.name, index, s.name, s.description, s.source === "user" ? "个人" : "系统"))}
          {customName ? row(`__custom_${customName}`, customIndex, customName, "自定义引用", null) : null}
        </>
      ) : (
        <div className="skill-empty">暂无可用技能,可在 技能 页里管理</div>
      )}
    </div>
  );
}

/** 已引用技能的 chip 行。复用 .attachment-chip 系列样式,放在文件托盘旁。 */
export function SkillTray({
  skills,
  onRemove,
}: {
  skills: SkillRef[];
  onRemove: (name: string) => void;
}) {
  if (!skills.length) return null;
  return (
    <div className="attachment-tray" aria-label="已引用技能">
      {skills.map((skill) => (
        <span className="attachment-chip" key={skill.name} title={skill.description || skill.name}>
          <span className="attachment-chip-main">
            <span className="attachment-chip-icon">
              <HugeiconsIcon icon={MagicWand01Icon} size={18} className="text-muted-foreground" />
            </span>
            <span className="attachment-chip-text">
              <span className="attachment-chip-name">{skill.name}</span>
              <span className="attachment-chip-type">技能</span>
            </span>
          </span>
          <button
            type="button"
            className="attachment-chip-close"
            onClick={() => onRemove(skill.name)}
            aria-label={`移除技能 ${skill.name}`}
          >
            &times;
          </button>
        </span>
      ))}
    </div>
  );
}

/** 「深度思考」开关:选中=高亮=用推理模型;默认不选中=快速模型。无下拉箭头,hover 提示含义。 */
export function DeepThinkToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          onClick={() => onToggle(!active)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-caption transition-colors select-none",
            active
              ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={Atom01Icon} size={15} />
          <span>深度思考</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">深度思考:用推理模型解决复杂问题;关闭则用快速模型</TooltipContent>
    </Tooltip>
  );
}
