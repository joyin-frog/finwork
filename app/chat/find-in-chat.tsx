"use client";

// CSS Custom Highlight API 兼容性说明:
// - Tauri WKWebView (Safari 17.2+) 和 Windows WebView2 (Chromium) 均支持。
// - 浏览器不支持时退化为:仅显示计数、不高亮。
// 特性检测: typeof CSS !== "undefined" && "highlights" in CSS

import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, ArrowDown01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { findMatches } from "./find-matches";

interface FindInChatProps {
  open: boolean;
  initialQuery?: string;
  threadRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 外部传入 nonce,query 变化/消息数量变化时重算高亮 */
  contentNonce?: number;
}

interface TextNodeEntry {
  node: Text;
  /** 该文本节点的起始全局偏移 */
  start: number;
}

function buildTextIndex(root: HTMLElement): { text: string; entries: TextNodeEntry[] } {
  const entries: TextNodeEntry[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    // 跳过浮窗自身的文本节点
    if (textNode.parentElement?.closest("[data-find-ui]")) continue;
    entries.push({ node: textNode, start: text.length });
    text += textNode.textContent ?? "";
  }
  return { text, entries };
}

function makeRange(
  entries: TextNodeEntry[],
  globalStart: number,
  globalEnd: number
): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { node, start } = entries[i];
    const nodeEnd = start + (node.textContent?.length ?? 0);

    if (!startNode && globalStart < nodeEnd) {
      startNode = node;
      startOffset = globalStart - start;
    }
    if (startNode && globalEnd <= nodeEnd) {
      endNode = node;
      endOffset = globalEnd - start;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function clearHighlights() {
  if (typeof CSS !== "undefined" && "highlights" in CSS) {
    CSS.highlights.delete("find-all");
    CSS.highlights.delete("find-active");
  }
}

export function FindInChat({ open, initialQuery = "", threadRef, onClose, contentNonce }: FindInChatProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 同步 initialQuery → query
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // autoFocus when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const applyHighlights = useCallback(() => {
    if (!threadRef.current || !open) return;
    clearHighlights();

    const q = query.trim();
    if (!q) {
      setTotalCount(0);
      return;
    }

    const { text, entries } = buildTextIndex(threadRef.current);
    const matches = findMatches(text, q);
    setTotalCount(matches.length);

    if (matches.length === 0) return;

    const idx = Math.min(activeIndex, matches.length - 1);

    const supportsHighlight = typeof CSS !== "undefined" && "highlights" in CSS;
    if (supportsHighlight) {
      const allRanges: Range[] = [];
      for (const [s, e] of matches) {
        const r = makeRange(entries, s, e);
        if (r) allRanges.push(r);
      }
      if (allRanges.length > 0) {
        CSS.highlights.set("find-all", new Highlight(...allRanges));
      }

      const activeRange = makeRange(entries, matches[idx][0], matches[idx][1]);
      if (activeRange) {
        CSS.highlights.set("find-active", new Highlight(activeRange));

        // 滚动到活跃命中
        try {
          (activeRange.startContainer as Element).parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch {
          // 忽略不支持 scrollIntoView 的情况
        }
      }
    }
  }, [query, activeIndex, open, threadRef, contentNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyHighlights();
  }, [applyHighlights]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载清理
  useEffect(() => {
    return () => clearHighlights();
  }, []);

  function handleClose() {
    clearHighlights();
    onClose();
  }

  function goNext() {
    if (totalCount === 0) return;
    setActiveIndex((i) => (i + 1) % totalCount);
  }

  function goPrev() {
    if (totalCount === 0) return;
    setActiveIndex((i) => (i - 1 + totalCount) % totalCount);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      goNext();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      goPrev();
    }
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    setActiveIndex(0);
  }

  if (!open) return null;

  const displayIndex = totalCount > 0 ? Math.min(activeIndex, totalCount - 1) + 1 : 0;

  return (
    <div
      data-find-ui
      className="absolute right-4 top-4 z-30 flex items-center gap-1.5 rounded-xl border border-border bg-card shadow-[var(--elevation-2)] px-2 py-1.5"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        placeholder="在对话中查找…"
        className="w-44 bg-transparent text-small text-foreground placeholder:text-muted-foreground outline-none"
        aria-label="查找"
      />
      <span className="text-caption text-muted-foreground min-w-[3rem] text-right select-none">
        {query.trim() ? `${displayIndex} / ${totalCount}` : ""}
      </span>
      <button
        onClick={goPrev}
        aria-label="上一个"
        className="rounded p-0.5 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={totalCount === 0}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
      </button>
      <button
        onClick={goNext}
        aria-label="下一个"
        className="rounded p-0.5 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={totalCount === 0}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
      </button>
      <button
        onClick={handleClose}
        aria-label="关闭查找"
        className="rounded p-0.5 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} />
      </button>
    </div>
  );
}
