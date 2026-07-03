"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, File01Icon } from "@hugeicons/core-free-icons";
import type { SkillSummary } from "@/lib/agent/skills-store";
import { Button } from "@/components/ui/button";

const CAPABILITY_GROUPS = [
  { label: "算薪窗口", skills: ["payroll-calc", "reimbursement-check"] },
  { label: "报税期", skills: ["tax-incentive", "rnd-deduction-check"] },
  { label: "结账出数", skills: ["kingdee-draft", "finance-analysis", "business-analysis"] },
  { label: "随时可用", skills: ["contract-extract"] },
] as const;

const FILE_SKILLS = ["xlsx", "pdf", "docx", "pptx"];

export function SkillCatalog() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("/api/skills")
      .then((res) => res.json() as Promise<{ data?: SkillSummary[] }>)
      .then((payload) => setSkills(payload.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-body font-semibold">财务能力</h3>
        <p className="mt-1 text-meta text-muted-foreground">选一项工作进入对话，小财会按对应流程处理。</p>
      </div>
      {loading ? <p className="text-body text-muted-foreground">加载中…</p> : null}
      {!loading ? CAPABILITY_GROUPS.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h4 className="text-meta font-medium text-muted-foreground">{group.label}</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.skills.map((name) => {
              const skill = byName.get(name);
              if (!skill) return null;
              return (
                <article key={name} className="flex min-h-44 flex-col rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-sm)]">
                  <h5 className="text-body font-semibold">{skill.title || skill.name}</h5>
                  <p className="mt-1 text-small leading-5 text-muted-foreground">{skill.summary || skill.description}</p>
                  <div className="mt-3 rounded-md bg-muted px-3 py-2 text-meta">
                    <span className="text-muted-foreground">需要准备：</span>
                    <span>{skill.requires || "相关业务材料"}</span>
                  </div>
                  <Button asChild size="sm" className="mt-auto w-fit self-end">
                    <Link href={`/chat/new?skill=${encodeURIComponent(skill.name)}`}>
                      开始
                      <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
                    </Link>
                  </Button>
                </article>
              );
            })}
          </div>
        </section>
      )) : null}
      <div className="flex items-center gap-3 rounded-lg border border-border/70 px-4 py-3 text-small">
        <HugeiconsIcon icon={File01Icon} size={17} className="text-muted-foreground" />
        <div>
          <p className="font-medium">文件处理 · 自动生效</p>
          <p className="text-meta text-muted-foreground">
            {FILE_SKILLS.map((name) => byName.get(name)?.title).filter(Boolean).join("、") || "Excel、PDF、Word、PPT"} 会按你上传的文件自动启用。
          </p>
        </div>
      </div>
      <Link href="/skills" className="w-fit text-meta text-muted-foreground transition-colors hover:text-foreground">
        高级：技能文件管理 ↗
      </Link>
    </div>
  );
}
