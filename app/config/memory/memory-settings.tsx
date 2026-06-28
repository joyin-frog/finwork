"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/app/config/settings-ui";
import { toast } from "sonner";

const MAX_BYTES = 64 * 1024;

export function MemorySettings() {
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/memory");
        const payload = (await res.json()) as { ok: boolean; data?: { content: string; updatedAt: string | null } };
        if (payload.ok && payload.data) {
          setContent(payload.data.content);
          setUpdatedAt(payload.data.updatedAt);
        }
      } catch {
        toast.error("记忆加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/memory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (payload.ok) {
        setUpdatedAt(new Date().toISOString());
        toast.success("保存成功");
      } else {
        toast.error(payload.error ?? "保存失败");
      }
    } catch {
      toast.error("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  const byteCount = new TextEncoder().encode(content).length;
  const overLimit = byteCount > MAX_BYTES;

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="记忆"
        description="小财确认过的约定会自动写进来，你也可以直接改。这里的内容每次对话都会注入提示词。"
      >
        {updatedAt && (
          <p className="-mt-1 text-meta text-muted-foreground">
            上次更新：{new Date(updatedAt).toLocaleString("zh-CN")}
          </p>
        )}
        <Textarea
          className="min-h-64 font-mono text-body"
          value={loading ? "" : content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={loading ? "加载中…" : "还没有记忆内容。在对话里对小财说你的规矩，或直接在这里编写。"}
          disabled={loading}
        />
        <div className="flex items-center justify-between gap-2">
          <span className={`text-meta ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
            {byteCount.toLocaleString()} / {MAX_BYTES.toLocaleString()} 字节
          </span>
          <Button onClick={() => void save()} disabled={saving || loading || overLimit} size="sm">
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
