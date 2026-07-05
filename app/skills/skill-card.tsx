"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { BubbleChatAddIcon } from "@hugeicons/core-free-icons";
import { SourceTag } from "@/app/skills/skills-shared";
import type { SkillSummary } from "@/app/skills/skills-shared";
import { cn } from "@/lib/utils";

export function SkillCard({ skill }: { skill: SkillSummary }) {
  const router = useRouter();
  return (
    <Link
      href={`/skills/${encodeURIComponent(skill.name)}`}
      className={cn(
        "group relative flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        "border-border hover:border-primary/40 hover:bg-accent/40",
        !skill.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-body font-medium line-clamp-2">{skill.title || skill.name}</div>
        <SourceTag source={skill.source} />
      </div>
      <p className="text-meta text-muted-foreground line-clamp-3">{skill.summary || skill.description}</p>
      <div className="flex justify-end pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* 停用的用户技能不进 SDK 白名单,禁用「进入对话」入口(避免带一个加载不了的技能进对话) */}
        <button
          type="button"
          title={skill.enabled ? "进入对话" : "技能已停用，启用后可进入对话"}
          aria-label="进入对话"
          disabled={!skill.enabled}
          onClick={(e) => { e.preventDefault(); if (skill.enabled) router.push(`/chat/new?skill=${encodeURIComponent(skill.name)}`); }}
          className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-accent transition-colors disabled:pointer-events-none disabled:opacity-40"
        >
          <HugeiconsIcon icon={BubbleChatAddIcon} size={14} />
        </button>
      </div>
    </Link>
  );
}
