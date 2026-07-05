"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SkillEditor } from "@/app/skills/skill-editor";
import { api, SourceTag, IconButton } from "@/app/skills/skills-shared";
import type { SkillSummary } from "@/app/skills/skills-shared";

type SkillDetail = SkillSummary & { body?: string };

export function SkillDetailPage({ name }: { name: string }) {
  const router = useRouter();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setSkill(null);
    void api<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`).then((r) => {
      setLoading(false);
      if (r.status === 404 || r.status === 400 || !r.ok || !r.data) {
        setNotFound(true);
      } else {
        setSkill(r.data);
      }
    });
  }, [name]);

  async function toggleEnabled(v: boolean) {
    if (!skill) return;
    // 乐观更新
    setSkill((prev) => prev ? { ...prev, enabled: v } : prev);
    const r = await api(`/api/skills/${encodeURIComponent(skill.name)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: v }),
    });
    if (!r.ok) {
      setSkill((prev) => prev ? { ...prev, enabled: !v } : prev);
      toast.error(r.error ?? "切换失败");
    }
  }

  async function deleteSkill() {
    if (!skill) return;
    if (!window.confirm(`删除技能「${skill.name}」?此操作不可撤销。`)) return;
    const r = await api(`/api/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
    if (r.ok) {
      toast.success("已删除技能");
      router.push("/skills");
    } else {
      toast.error(r.error ?? "删除失败");
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-body">
        加载中…
      </div>
    );
  }

  if (notFound || !skill) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>技能不存在</p>
        <Link href="/skills" className="text-primary hover:underline">← 返回</Link>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶部信息条 */}
      <div className="flex items-center gap-3 px-4 h-11 shrink-0 border-b border-border">
        <Link
          href="/skills"
          className="flex items-center gap-1 text-body text-muted-foreground hover:text-foreground transition-colors"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
          返回
        </Link>
        <span className="text-title font-semibold">{skill.title || skill.name}</span>
        <SourceTag source={skill.source} />
        {skill.requires && (
          <span className="text-meta text-muted-foreground">需要准备：{skill.requires}</span>
        )}
        <div className="flex-1" />
        {skill.source === "user" && (
          <Switch
            checked={skill.enabled}
            onCheckedChange={(v) => void toggleEnabled(v)}
            aria-label={skill.enabled ? "停用" : "启用"}
          />
        )}
        <Button asChild size="sm">
          <Link href={`/chat/new?skill=${encodeURIComponent(skill.name)}`}>开始对话</Link>
        </Button>
        {skill.editable && (
          <IconButton
            icon={Delete02Icon}
            label="删除技能"
            tone="destructive"
            onClick={() => void deleteSkill()}
          />
        )}
      </div>

      {/* 文件树编辑器 */}
      <div className="flex-1 min-h-0 flex">
        <SkillEditor key={skill.name} skill={skill} />
      </div>
    </div>
  );
}
