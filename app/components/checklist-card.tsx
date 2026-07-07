"use client";

/**
 * ChecklistCard: WP14a 可勾选清单工件卡片
 *
 * 分发条件：structured.kind === 'artifact_checklist'（kind 判别优先，WP4a 模式）
 * 状态来源：mount 时 GET /api/artifacts/[id] 拉最新 state（历史重开保真）
 * 勾选：PATCH /api/artifacts/[id]，等待响应（submitting 态），失败恢复并提示
 * 404 降级：只读静态视图 + "工件已删除，无法操作"灰字
 * 底部声明："勾选仅记录处理进度，不改变实际申报/业务状态"
 * 三态：open/done/ignored
 */

import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { WarningIcon } from "@/lib/icons";
import { toast } from "sonner";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type ChecklistItemSeverity = "warn" | "info";
export type ChecklistItemState = "open" | "done" | "ignored";

export type ChecklistItem = {
  id: string;
  label: string;
  detail?: string;
  severity?: ChecklistItemSeverity;
};

export type ChecklistStructured = {
  kind: "artifact_checklist";
  artifactId: string;
  title: string;
  items: ChecklistItem[];
};

// ── 严格 parse（解析失败返回 null，回退纯文本） ────────────────────────────────

export function parseChecklistStructured(structured: unknown): ChecklistStructured | null {
  if (!structured || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;
  if (s.kind !== "artifact_checklist") return null;
  if (typeof s.artifactId !== "string" || !s.artifactId) return null;
  if (typeof s.title !== "string") return null;
  if (!Array.isArray(s.items)) return null;
  // 每个 item 至少需要 id 和 label
  const items: ChecklistItem[] = [];
  for (const raw of s.items) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) return null;
    if (typeof item.label !== "string" || !item.label) return null;
    items.push({
      id: item.id,
      label: item.label,
      ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
      ...(item.severity === "warn" || item.severity === "info" ? { severity: item.severity } : {}),
    });
  }
  return {
    kind: "artifact_checklist",
    artifactId: String(s.artifactId),
    title: String(s.title),
    items,
  };
}

// ── 三态标签 ──────────────────────────────────────────────────────────────────

const STATE_LABELS: Record<ChecklistItemState, string> = {
  open: "待办",
  done: "已处理",
  ignored: "已忽略",
};

const STATE_NEXT: Record<ChecklistItemState, ChecklistItemState> = {
  open: "done",
  done: "ignored",
  ignored: "open",
};

// ── ChecklistCard 组件 ────────────────────────────────────────────────────────

interface ChecklistCardProps {
  data: ChecklistStructured;
}

export function ChecklistCard({ data }: ChecklistCardProps) {
  const { artifactId, title, items } = data;

  // 本地 state（key: itemId → state）
  const [itemStates, setItemStates] = useState<Record<string, ChecklistItemState>>({});
  const [loading, setLoading] = useState(true);
  const [deleted, setDeleted] = useState(false);
  // 正在提交中的 itemId
  const [submitting, setSubmitting] = useState<string | null>(null);

  // mount 时 GET 拉最新 state（历史重开保真）
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/artifacts/${artifactId}`);
        if (res.status === 404) {
          setDeleted(true);
          setLoading(false);
          return;
        }
        if (res.ok) {
          const body = await res.json() as { state?: Record<string, string> };
          const serverState: Record<string, ChecklistItemState> = {};
          for (const [k, v] of Object.entries(body.state ?? {})) {
            if (v === "open" || v === "done" || v === "ignored") {
              serverState[k] = v;
            }
          }
          setItemStates(serverState);
        }
      } catch {
        // 网络失败：保持默认 open 状态（不降级为只读，仍可操作）
      } finally {
        setLoading(false);
      }
    })();
  }, [artifactId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(itemId: string) {
    if (deleted || submitting) return;
    const current: ChecklistItemState = itemStates[itemId] ?? "open";
    const next = STATE_NEXT[current];

    // 先更新本地（乐观 UI）
    const prev = itemStates;
    setItemStates((s) => ({ ...s, [itemId]: next }));
    setSubmitting(itemId);

    try {
      const res = await fetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, state: next }),
      });
      if (!res.ok) {
        // 失败恢复
        setItemStates(prev);
        toast.error("更新失败，请重试");
      }
    } catch {
      setItemStates(prev);
      toast.error("更新失败，请重试");
    } finally {
      setSubmitting(null);
    }
  }

  // 404 降级：只读静态视图
  if (deleted) {
    return (
      <Surface className="shadow-none text-body overflow-hidden">
        <div className="px-3 py-2 border-b border-border text-meta font-medium">{title}</div>
        <ul className="divide-y divide-border/60">
          {items.map((item) => (
            <li key={item.id} className="px-3 py-2 flex items-start gap-2 text-body">
              <SeverityIcon severity={item.severity} />
              <span className="flex-1 text-muted-foreground">{item.label}</span>
            </li>
          ))}
        </ul>
        <div className="px-3 py-1.5 border-t border-border bg-muted/30 text-caption text-muted-foreground/60">
          工件已删除，无法操作
        </div>
      </Surface>
    );
  }

  return (
    <Surface className="shadow-none text-body overflow-hidden">
      {/* 标题栏 */}
      <div className="px-3 py-2 border-b border-border text-meta font-medium flex items-center justify-between gap-2">
        <span>{title}</span>
        {loading && (
          <span className="text-caption text-muted-foreground/60">加载中…</span>
        )}
      </div>

      {/* 清单项 */}
      <ul className="divide-y divide-border/60">
        {items.map((item) => {
          const state: ChecklistItemState = itemStates[item.id] ?? "open";
          const isSubmitting = submitting === item.id;

          return (
            <li key={item.id} className="px-3 py-2 flex items-start gap-2 text-body">
              <SeverityIcon severity={item.severity} />
              <div className="flex-1 min-w-0">
                <span className={cn(
                  "block",
                  state === "done" && "line-through text-muted-foreground",
                  state === "ignored" && "text-muted-foreground/60"
                )}>
                  {item.label}
                </span>
                {item.detail && (
                  <span className="block text-caption text-muted-foreground/70 mt-0.5">{item.detail}</span>
                )}
              </div>
              {/* 三态按钮 */}
              <button
                type="button"
                disabled={isSubmitting || loading || deleted}
                onClick={() => void handleToggle(item.id)}
                className={cn(
                  // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                  "shrink-0 px-2 py-0.5 rounded-[var(--radius-chip)] border text-caption transition-colors cursor-pointer",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  state === "open" && "border-border bg-card text-muted-foreground hover:bg-accent",
                  state === "done" && "border-[color:var(--tone-ok)]/40 bg-[color:var(--tone-ok)]/10 text-[color:var(--tone-ok)]",
                  state === "ignored" && "border-border/50 bg-muted/30 text-muted-foreground/60"
                )}
              >
                {isSubmitting ? "…" : STATE_LABELS[state]}
              </button>
            </li>
          );
        })}
      </ul>

      {/* 底部声明 */}
      <div className="px-3 py-1.5 border-t border-border bg-muted/30 text-caption text-muted-foreground/60">
        勾选仅记录处理进度，不改变实际申报/业务状态
      </div>
    </Surface>
  );
}

function SeverityIcon({ severity }: { severity?: ChecklistItemSeverity }) {
  if (!severity) return null;
  if (severity === "warn") {
    return (
      <HugeiconsIcon
        icon={WarningIcon}
        size={13}
        className="shrink-0 mt-0.5 text-[color:var(--tone-notice)]"
        aria-hidden="true"
      />
    );
  }
  // info
  return <span className="shrink-0 w-3.5 h-3.5 mt-0.5 text-caption text-muted-foreground/60" aria-hidden="true">ℹ</span>;
}
