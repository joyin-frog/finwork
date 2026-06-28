"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { CAT_LABELS, highlightLine, type SearchData, type SearchMatch } from "./shared";

export function SearchResults({
  results,
  error,
  activeDocId,
  active,
  onViewLine,
  onAddToChat,
}: {
  results: SearchData | null;
  error: string;
  activeDocId: number | null;
  active: boolean;
  onViewLine: (docId: number, lineNo?: number) => void;
  onAddToChat: (docId: number) => void;
}) {
  if (error) {
    return (
      <div className="py-4 px-4 text-center text-body text-muted-foreground">
        {error}{error.includes("rg not installed") ? " — 请安装 ripgrep 后重试" : ""}
      </div>
    );
  }
  if (!results || results.files.length === 0) {
    return <div className="py-4 text-center text-body text-muted-foreground">未找到匹配内容</div>;
  }
  return (
    <>
      <div className="px-3.5 py-2 text-meta text-muted-foreground">
        共 {results.totalFiles} 个文件 ({results.elapsedMs}ms){results.truncated ? " · 部分结果已截断" : ""}
      </div>
      {results.files.map(f => (
        <article
          key={f.docId}
          className={cn(
            "group flex flex-col px-3.5 py-2.5 border-l-2 transition-colors",
            activeDocId === f.docId && active ? "bg-accent border-l-primary" : "border-l-transparent hover:bg-accent/50"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-body font-medium truncate">{f.fileName}</span>
            <button
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-meta border border-border rounded-md text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              onClick={e => { e.stopPropagation(); onViewLine(f.docId); }}
            >
              <HugeiconsIcon icon={ViewIcon} size={12} /> 查看原文
            </button>
          </div>
          <div className="text-meta text-muted-foreground mt-0.5">
            {CAT_LABELS[f.category] ?? f.category} · 命中 {f.hitCount} 次
          </div>
          {f.matches.length > 0 && (
            <div className="max-h-[340px] overflow-y-auto mt-2 border-t border-border pt-1">
              {f.matches.map((m: SearchMatch, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2 px-2 py-1 rounded-md text-meta text-muted-foreground cursor-pointer hover:bg-accent transition-colors"
                  onClick={() => onViewLine(f.docId, m.lineNo)}
                >
                  <span className="shrink-0 min-w-[32px] text-right text-caption text-muted-foreground/60">L{m.lineNo}</span>
                  <span>{highlightLine(m.line, m.ranges)}</span>
                </div>
              ))}
              {f.hitCount > f.matches.length && (
                <div className="text-center text-caption text-muted-foreground/60 border-t border-border mt-0.5 pt-1">
                  共 {f.hitCount} 条匹配，仅显示前 {f.matches.length} 条
                </div>
              )}
            </div>
          )}
          <button
            className="self-end inline-flex items-center gap-1 mt-2 px-2 py-1 text-meta border border-border rounded-md text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            onClick={e => { e.stopPropagation(); onAddToChat(f.docId); }}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} size={13} /> 添加到对话
          </button>
        </article>
      ))}
    </>
  );
}
