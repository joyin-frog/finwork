"use client";

import { useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection, SaveStatusText, type SaveStatus } from "@/app/config/settings-ui";
import { toast } from "sonner";

const MAX_BYTES = 64 * 1024;

export function MemorySettings() {
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [loading, setLoading] = useState(true);
  // 首个 post-load 渲染是加载进来的数据,不应触发自动保存
  const hydrated = useRef(false);

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

  const byteCount = new TextEncoder().encode(content).length;
  const overLimit = byteCount > MAX_BYTES;

  // 自动保存:内容变更防抖 600ms 落盘,带状态指示(同画像页)。
  // 超过 64KB 上限时暂停落盘,由下方红色提示显式告知——不可静默不存。
  useEffect(() => {
    if (loading) return;
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    if (new TextEncoder().encode(content).length > MAX_BYTES) return;
    const t = setTimeout(() => {
      void (async () => {
        setStatus("saving");
        try {
          const res = await fetch("/api/memory", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content }),
          });
          const payload = (await res.json()) as { ok: boolean; error?: string };
          if (payload.ok) {
            setUpdatedAt(new Date().toISOString());
            setStatus("saved");
          } else {
            setStatus("error");
          }
        } catch {
          setStatus("error");
        }
      })();
    }, 600);
    return () => clearTimeout(t);
  }, [content, loading]);

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="记忆"
        description="小财确认过的约定会自动写进来,你也可以直接改(自动保存)。这里的内容每次对话都会注入提示词。"
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
        <div className="flex items-center gap-2 text-meta">
          {/* 字节计数仅在逼近上限(>80%)时出现,平时不打扰 */}
          {byteCount > MAX_BYTES * 0.8 && (
            <span className={overLimit ? "text-destructive" : "text-muted-foreground"}>
              {byteCount.toLocaleString()} / {MAX_BYTES.toLocaleString()} 字节
            </span>
          )}
          {overLimit ? (
            <span className="text-destructive">已超过 64KB 上限,自动保存已暂停——删减内容后会自动恢复保存。</span>
          ) : (
            <SaveStatusText status={status} />
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
