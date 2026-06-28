"use client";

import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Archive02Icon, Archive01Icon, ArrowRight01Icon, ViewIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { FileTypeIcon } from "@/app/shared/file-type-icon";
import { cn } from "@/lib/utils";
import { CAT_LABELS, fmtBytes, fmtTime, isStaleDoc, type DocRow } from "./shared";

export function DocCard({
  doc,
  active,
  onView,
  onAddToChat,
  onToggleArchive,
  onDelete,
}: {
  doc: DocRow;
  active: boolean;
  onView: (doc: DocRow) => void;
  onAddToChat: (docId: number) => void;
  onToggleArchive: (doc: DocRow) => void;
  onDelete: (doc: DocRow) => void;
}) {
  const archived = doc.archived === 1;
  const stale = !archived && isStaleDoc(doc);
  return (
    <article
      className={cn(
        "group flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        active ? "border-primary bg-accent" : "border-border hover:border-primary/40 hover:bg-accent/40",
        archived && "opacity-60"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="size-9 shrink-0 flex items-center justify-center">
          <FileTypeIcon name={doc.title} mimeType={doc.mime_type} width={26} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-body font-medium line-clamp-2" title={doc.title}>{doc.title}</div>
          <div className="text-meta text-muted-foreground mt-1">{CAT_LABELS[doc.category] ?? doc.category} · {fmtBytes(doc.size_bytes)}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-meta text-muted-foreground">
        <span>{doc.hit_count > 0 ? `检索 ${doc.hit_count} 次` : "未被检索"}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{doc.last_hit_at ? `最近 ${fmtTime(doc.last_hit_at)}` : `更新于 ${fmtTime(doc.updated_at)}`}</span>
        {archived && <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">已归档</span>}
        {stale && <span className="fa-tone-pill" style={{ "--tone": "var(--tone-notice)" } as CSSProperties}>长期未使用</span>}
      </div>

      <div className="flex items-center gap-1 pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="inline-flex items-center gap-1 px-2 py-1 text-meta border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          onClick={() => onView(doc)}
          title="查看原文"
        >
          <HugeiconsIcon icon={ViewIcon} size={12} /> 查看
        </button>
        {!archived && (
          <button
            className="inline-flex items-center gap-1 px-2 py-1 text-meta border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            onClick={() => onAddToChat(doc.id)}
            title="添加到对话"
          >
            <HugeiconsIcon icon={ArrowRight01Icon} size={12} /> 对话
          </button>
        )}
        <button
          className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => onToggleArchive(doc)}
          title={archived ? "恢复" : "归档（从检索中移除，不删除文件）"}
        >
          {archived ? <HugeiconsIcon icon={Archive01Icon} size={15} /> : <HugeiconsIcon icon={Archive02Icon} size={15} />}
        </button>
        <button
          className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          onClick={() => onDelete(doc)}
          title="删除"
        >
          <HugeiconsIcon icon={Delete02Icon} size={15} />
        </button>
      </div>
    </article>
  );
}
