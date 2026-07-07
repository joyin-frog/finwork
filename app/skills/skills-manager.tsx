"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { filterByCategory, filterSkills } from "@/app/skills/file-tree";
import { IconButton, api, SKILL_NAME_RE } from "@/app/skills/skills-shared";
import type { SkillSummary } from "@/app/skills/skills-shared";
import { SkillCard } from "@/app/skills/skill-card";
import { useShortcutEvent } from "@/app/shared/global-shortcuts";
import { cn } from "@/lib/utils";

type Category = "all" | "finance" | "file-tool" | "user";

export function SkillsManager() {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [creating, setCreating] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useShortcutEvent("search-skills", () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });

  const loadSkills = useCallback(async () => {
    const r = await api<SkillSummary[]>("/api/skills");
    if (r.ok && r.data) setSkills(r.data);
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filtered = filterByCategory(filterSkills(skills, query), category);

  const chips: { key: Category; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "finance", label: "财务" },
    { key: "file-tool", label: "文件工具" },
    { key: "user", label: "个人" },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 h-12 shrink-0 border-b border-border">
        <h1 className="text-title font-semibold">技能</h1>
        <div className="flex-1" />
        {/* 常驻搜索框:无边框,图标+placeholder */}
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索技能..."
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            className="w-44 h-8 pl-7 pr-3 text-body rounded-md placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
        <IconButton
          icon={Add01Icon}
          label="新建技能"
          onClick={() => setCreating(true)}
          active={creating}
        />
      </div>

      {creating ? (
        <NewSkillForm
          existing={skills.map((s) => s.name)}
          onCancel={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false);
            router.push(`/skills/${encodeURIComponent(name)}`);
          }}
        />
      ) : (
        <>
          {/* 筛选 chip 行 */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-2 shrink-0">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                className={cn(
                  "px-3 py-1 rounded-md text-body transition-colors",
                  category === c.key
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* 卡片网格 */}
          <div className="flex-1 overflow-auto">
            {skills.length === 0 ? (
              <p className="px-4 py-6 text-meta text-muted-foreground">加载中…</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-6 text-meta text-muted-foreground">无匹配技能</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-4">
                {filtered.map((s) => (
                  <SkillCard key={s.name} skill={s} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── 新建技能表单 ─────────────────────────────────────────────────────────────

function NewSkillForm({
  existing,
  onCancel,
  onCreated,
}: {
  existing: string[];
  onCancel: () => void;
  onCreated: (name: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("# 技能说明\n\n描述这个技能要做什么、怎么做。");
  const [busy, setBusy] = useState(false);

  const nameErr =
    name && !SKILL_NAME_RE.test(name)
      ? "只能用小写字母、数字、连字符,且字母/数字开头"
      : existing.includes(name)
        ? "该名称已存在"
        : "";

  async function submit() {
    if (!name || nameErr) return;
    setBusy(true);
    const r = await api<{ name: string }>("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, body }),
    });
    setBusy(false);
    if (r.ok && r.data) {
      toast.success("已创建技能");
      await onCreated(r.data.name);
    } else {
      toast.error(r.error ?? "创建失败");
    }
  }

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-2xl">
      <h2 className="text-title font-semibold mb-4">新建技能</h2>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-body">技能名(英文标识)</span>
          <Input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="例如 my-reimburse-check" />
          {nameErr && <span className="text-meta text-destructive">{nameErr}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-body">描述(触发说明,给 AI 判断何时用)</span>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-body">SKILL.md 正文</span>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="font-mono text-small" />
        </label>
        <div className="flex gap-2">
          <Button onClick={() => void submit()} disabled={!name || !!nameErr || busy}>创建</Button>
          <Button variant="ghost" onClick={onCancel}>取消</Button>
        </div>
      </div>
    </div>
  );
}
