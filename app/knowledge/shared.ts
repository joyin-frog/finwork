import { createElement, type ReactNode } from "react";
import type { KnowledgeCategory } from "@/lib/knowledge/types";

export type DocRow = {
  id: number; title: string; file_name: string; mime_type: string;
  category: string; size_bytes: number; chunk_count: number;
  created_at: string; updated_at: string;
  last_hit_at: string | null; hit_count: number; archived: number;
  // P1 合同归纳
  metadata: string | null; meta_status: string;
};

export type SearchMatch = {
  lineNo: number; line: string; before: string[]; after: string[];
  ranges: Array<[number, number]>;
};

export type SearchFile = {
  docId: number; title: string; fileName: string; category: string;
  hitCount: number; matches: SearchMatch[];
};

export type SearchData = {
  files: SearchFile[];
  totalFiles: number;
  truncated: boolean;
  elapsedMs: number;
};

export type PreviewData = { title: string; fileName: string; mimeType: string; text: string };

export const CAT_LABELS: Record<string, string> = {
  expense_policy: "报销制度", contract: "合同", finance_spec: "财务规范", tax: "税务", general: "通用", all: "全部",
};
export const CATS: KnowledgeCategory[] = ["expense_policy", "contract", "finance_spec", "tax", "general"];

/** 长期未使用阈值(天):超过则提示可考虑归档 */
export const STALE_DAYS = 90;

export function isStaleDoc(doc: DocRow): boolean {
  const ref = doc.last_hit_at ?? doc.created_at;
  return Date.now() - new Date(ref).getTime() > STALE_DAYS * 86_400_000;
}

export function fmtBytes(b: number) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

export function fmtTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + " 小时前";
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + " 天前";
  return Math.floor(days / 30) + " 月前";
}

export function buildHitLines(file: SearchFile): number[] {
  return [...new Set(file.matches.map(m => m.lineNo))].sort((a, b) => a - b);
}

/** 把匹配区间渲染成高亮片段(供搜索结果与预览复用) */
export function highlightLine(line: string, ranges: Array<[number, number]>): ReactNode {
  if (!ranges.length) return line;
  const parts: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([start, end], i) => {
    if (start > last) parts.push(createElement("span", { key: `t${i}` }, line.slice(last, start)));
    parts.push(
      createElement("mark", { key: `m${i}`, className: "bg-yellow-200/70 dark:bg-yellow-500/30 text-inherit rounded-sm" }, line.slice(start, end))
    );
    last = end;
  });
  if (last < line.length) parts.push(createElement("span", { key: "tail" }, line.slice(last)));
  return parts;
}
