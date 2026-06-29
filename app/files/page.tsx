"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isTauri } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Delete02Icon,
  Folder02Icon,
  Search01Icon,
  BookmarkAdd01Icon,
  BookmarkRemove01Icon,
  LibraryIcon,
  LayoutAlignRightIcon,
  PanelRightIcon,
  CleanIcon,
} from "@hugeicons/core-free-icons";
import { ResourceTabs } from "@/app/shared/resource-tabs";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import { FilePreviewPage, type ConversationPreviewFile, type KnowledgePreviewFile, type LocalPreviewFile } from "@/app/shared/file-preview-page";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { ResourceCard, type ResourceCardMenuItem } from "@/app/shared/resource-card";
import { usePreviewResize } from "@/app/shared/use-preview-resize";
import { cn } from "@/lib/utils";
import type { UnifiedFileEntry } from "@/lib/db/sqlite";

type KindFilter = "all" | "upload" | "generated" | "library";
type SortKey = "date" | "name" | "size";

const KIND_LABELS: Record<string, string> = {
  upload: "上传",
  generated: "生成",
  knowledge: "知识库",
  library: "已保留",
};

// 卡片整圈边框 + 淡色底,按 kind 上色
// 静止态用全局 token 边框(border-border,同其他卡);只在 hover 时叠加对应 kind 色(上传蓝/生成紫/知识绿/库琥珀)。
const KIND_CARD_CLS: Record<string, string> = {
  upload: "border-border hover:border-blue-400 hover:bg-blue-50/40 dark:hover:border-blue-800 dark:hover:bg-blue-950/20",
  generated: "border-border hover:border-violet-400 hover:bg-violet-50/40 dark:hover:border-violet-800 dark:hover:bg-violet-950/20",
  knowledge: "border-border hover:border-emerald-400 hover:bg-emerald-50/40 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/20",
  library: "border-border hover:border-amber-400 hover:bg-amber-50/40 dark:hover:border-amber-800 dark:hover:bg-amber-950/20",
};

const KIND_CHIP_SELECTED: Record<string, string> = {
  upload: "bg-blue-600 text-white border-blue-600",
  generated: "bg-violet-600 text-white border-violet-600",
  knowledge: "bg-emerald-600 text-white border-emerald-600",
  library: "bg-amber-600 text-white border-amber-600",
};

const KIND_CHIP_UNSELECTED: Record<string, string> = {
  upload: "border-blue-200 text-blue-700 hover:border-blue-400 dark:border-blue-800 dark:text-blue-400",
  generated: "border-violet-200 text-violet-700 hover:border-violet-400 dark:border-violet-800 dark:text-violet-400",
  knowledge: "border-emerald-200 text-emerald-700 hover:border-emerald-400 dark:border-emerald-800 dark:text-emerald-400",
  library: "border-amber-200 text-amber-700 hover:border-amber-400 dark:border-amber-800 dark:text-amber-400",
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", year: "numeric" });
  } catch {
    return s;
  }
}

// Group files: by conversationId (non-null) or source (null conversationId)
function groupFiles(files: UnifiedFileEntry[]): Array<{ groupKey: string; title: string; files: UnifiedFileEntry[] }> {
  const groupMap = new Map<string, { title: string; files: UnifiedFileEntry[] }>();
  const groupOrder: string[] = [];

  for (const f of files) {
    const key = f.conversationId !== null
      ? `conv:${f.conversationId}`
      : `src:${f.source}`;

    if (!groupMap.has(key)) {
      groupOrder.push(key);
      const title = f.conversationId !== null
        ? (f.source || `对话 #${f.conversationId}`)
        : f.source;
      groupMap.set(key, { title, files: [] });
    }
    groupMap.get(key)!.files.push(f);
  }

  return groupOrder.map((key) => ({
    groupKey: key,
    ...groupMap.get(key)!,
  }));
}

export default function FilesPage() {
  return (
    <Suspense fallback={null}>
      <FilesPageContent />
    </Suspense>
  );
}

function FilesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [files, setFiles] = useState<UnifiedFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sort, setSort] = useState<SortKey>("date");
  const [selected, setSelected] = useState<UnifiedFileEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedFileEntry | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addingChatRef = useRef(false);

  // 去重清理状态(B 功能)
  const [dedupAnalysis, setDedupAnalysis] = useState<{
    redundantFiles: number;
    reclaimableBytes: number;
    sameConvDupGroups: number;
    orphanFiles: number;
  } | null>(null);
  const [dedupConfirmOpen, setDedupConfirmOpen] = useState(false);
  const [dedupCleaning, setDedupCleaning] = useState(false);

  // AC2: preview sidebar resize via shared hook
  // 列表列至少留 460:头部(对话文件｜知识库 + 文件数 + 清理重复 + 收起)在更窄时会换行/挤掉。
  const { collapsed: previewCollapsed, previewW, dragging, mainRef, beginResize, toggle: togglePreview, open: openPreview, resetWidth, maximize, maximized } = usePreviewResize(460);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sort });
      if (kindFilter !== "all" && kindFilter !== "library") params.set("kind", kindFilter);
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/files-library?${params.toString()}`);
      const payload = (await res.json()) as { ok: boolean; data?: { files: UnifiedFileEntry[] }; error?: string };
      if (!payload.ok) throw new Error(payload.error ?? "加载失败");
      setFiles(payload.data?.files ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sort, kindFilter, q]);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  // ?file=<id> 来自全局搜索:文件加载后自动打开预览,然后清掉 URL 参数
  useEffect(() => {
    const fileParam = searchParams.get("file");
    if (!fileParam || files.length === 0) return;
    const target = files.find((f) => f.id === fileParam);
    if (target) {
      setSelected(target);
      openPreview();
      const next = new URLSearchParams(searchParams.toString());
      next.delete("file");
      router.replace("/files" + (next.toString() ? "?" + next.toString() : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, files]);

  async function handleKeep(file: UnifiedFileEntry) {
    if (!file.id.startsWith("attach:")) return;
    setActionLoading(file.id);
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "keep", fileId: file.id, kept: !file.kept }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (!payload.ok) throw new Error(payload.error);
      await fetchFiles();
    } catch (err) {
      toast.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReveal(file: UnifiedFileEntry) {
    setActionLoading(file.id);
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reveal", fileId: file.id }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (!payload.ok) throw new Error(payload.error);
    } catch (err) {
      toast.error(`在系统中显示失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleExport(file: UnifiedFileEntry) {
    setActionLoading(file.id);
    try {
      let destPath: string | null = null;
      if (isTauri()) {
        destPath = await saveDialog({ defaultPath: file.name });
      }
      if (!destPath) {
        setActionLoading(null);
        return;
      }
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", fileId: file.id, destPath }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (!payload.ok) throw new Error(payload.error);
    } catch (err) {
      toast.error(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(file: UnifiedFileEntry) {
    setDeleteTarget(file);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setActionLoading(deleteTarget.id);
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", fileId: deleteTarget.id }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (!payload.ok) throw new Error(payload.error);
      if (selected?.id === deleteTarget.id) setSelected(null);
      await fetchFiles();
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
      setDeleteTarget(null);
    }
  }

  async function handlePromote(file: UnifiedFileEntry) {
    setActionLoading(file.id);
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote", fileId: file.id }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string; alreadyExists?: boolean };
      if (!payload.ok) throw new Error(payload.error);
      if (payload.alreadyExists) {
        toast.info("该文件已在知识库中（内容相同）");
      } else {
        toast.success("已加入知识库");
        await fetchFiles();
      }
    } catch (err) {
      toast.error(`加入知识库失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  }

  // ─── 去重清理流程(B 功能) ──────────────────────────────────────────────────
  async function handleDedupAnalyze() {
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze-duplicates" }),
      });
      const payload = (await res.json()) as {
        ok: boolean;
        data?: { redundantFiles: number; reclaimableBytes: number; sameConvDupGroups: number; orphanFiles: number };
        error?: string;
      };
      if (!payload.ok) throw new Error(payload.error ?? "分析失败");
      const analysis = payload.data!;
      setDedupAnalysis(analysis);
      const total = analysis.redundantFiles + analysis.orphanFiles;
      if (total === 0) {
        toast.info("没有可清理的重复或孤儿文件");
        return;
      }
      setDedupConfirmOpen(true);
    } catch (err) {
      toast.error(`分析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function confirmDedupCleanup() {
    setDedupConfirmOpen(false);
    setDedupCleaning(true);
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cleanup-duplicates" }),
      });
      const payload = (await res.json()) as {
        ok: boolean;
        data?: { cleanedFiles: number; reclaimedBytes: number };
        error?: string;
      };
      if (!payload.ok) throw new Error(payload.error ?? "清理失败");
      const { cleanedFiles, reclaimedBytes } = payload.data!;
      toast.success(`已清理 ${cleanedFiles} 个文件，释放 ${fmtBytes(reclaimedBytes)}`);
      await fetchFiles();
    } catch (err) {
      toast.error(`清理失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDedupCleaning(false);
      setDedupAnalysis(null);
    }
  }

  function buildPreviewSelection(file: UnifiedFileEntry) {
    if (file.kind === "knowledge") {
      const id = Number(file.id.slice(5));
      return {
        kind: "knowledge" as const,
        documentId: id,
        name: file.name,
        path: file.storagePath,
        mimeType: file.mime,
        sizeBytes: file.sizeBytes,
      } satisfies KnowledgePreviewFile;
    }
    if (file.kind === "library") {
      return {
        kind: "local" as const,
        path: file.storagePath,
        name: file.name,
        mimeType: file.mime,
        sizeBytes: file.sizeBytes,
      } satisfies LocalPreviewFile;
    }
    // upload / generated: conversation attachment
    if (file.conversationId) {
      return {
        kind: "conversation" as const,
        conversationId: file.conversationId,
        storagePath: file.storagePath,
        name: file.name,
        mimeType: file.mime,
        sizeBytes: file.sizeBytes,
      } satisfies ConversationPreviewFile;
    }
    return null;
  }

  const previewSelection = selected ? buildPreviewSelection(selected) : null;

  // 对话文件 tab:只看对话来源(上传/生成/已保留);知识库文件归 /知识库 tab,这里排除
  const convFiles = files.filter((f) => f.kind !== "knowledge");

  // "已保留" filter by kept===true
  const displayFiles = kindFilter === "library"
    ? convFiles.filter((f) => f.kept)
    : convFiles;

  const kindCounts: Record<string, number> = { all: convFiles.length };
  for (const f of convFiles) { kindCounts[f.kind] = (kindCounts[f.kind] ?? 0) + 1; }
  kindCounts["library"] = convFiles.filter((f) => f.kept).length;

  const groups = groupFiles(displayFiles);

  // Build ⋮ menu items per file
  function buildMenuItems(file: UnifiedFileEntry): ResourceCardMenuItem[] {
    const busy = actionLoading === file.id;
    const items: ResourceCardMenuItem[] = [];

    // 加入知识库 (仅 upload/generated)
    if (file.kind === "upload" || file.kind === "generated") {
      items.push({
        label: "加入知识库",
        icon: <HugeiconsIcon icon={LibraryIcon} size={13} />,
        onClick: () => void handlePromote(file),
        disabled: busy,
      });
    }

    // 在系统中显示
    items.push({
      label: "在文件夹中显示",
      icon: <HugeiconsIcon icon={Folder02Icon} size={13} />,
      onClick: () => void handleReveal(file),
      disabled: busy,
    });

    // 保留 toggle (upload/generated)
    if (file.kind === "upload" || file.kind === "generated") {
      items.push({
        label: file.kept ? "取消保留" : "保留(对话删除时不丢失)",
        icon: <HugeiconsIcon icon={file.kept ? BookmarkRemove01Icon : BookmarkAdd01Icon} size={13} />,
        onClick: () => void handleKeep(file),
        disabled: busy,
      });
    }

    // 删除 (不支持知识库类型)
    if (file.kind !== "knowledge") {
      items.push({
        label: "删除",
        icon: <HugeiconsIcon icon={Delete02Icon} size={13} />,
        onClick: () => void handleDelete(file),
        destructive: true,
        separator: items.length > 0,
        disabled: busy,
      });
    }

    return items;
  }

  // 对话:把文件带入新对话(本机读盘→暂存→/chat/new),与知识库一致;所有卡片都可用
  async function addToChat(file: UnifiedFileEntry) {
    if (addingChatRef.current) return; // 防重入:慢编译/无反馈时连点会叠满 sessionStorage 触发配额报错
    addingChatRef.current = true;
    setActionLoading(file.id);
    try {
      const res = await fetch(`/api/files-library?download=${encodeURIComponent(file.id)}`);
      if (!res.ok) { toast.error("添加到对话失败", { description: `HTTP ${res.status}` }); return; }
      const blob = await res.blob();
      const mimeType = blob.type || file.mime || "application/octet-stream";
      const dataUrl = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.readAsDataURL(blob); });
      let text: string | undefined;
      if (blob.size < 300 * 1024 && /text|json|xml|csv|md/i.test(mimeType)) text = await blob.text();
      const existing = JSON.parse(sessionStorage.getItem("pendingChatAttachments") ?? "[]");
      existing.push({ id: `${file.name}-${blob.size}-${Date.now()}-${crypto.randomUUID()}`, name: file.name, mimeType, size: blob.size, dataUrl, text });
      sessionStorage.setItem("pendingChatAttachments", JSON.stringify(existing));
      router.push("/chat/new");
    } catch (err) {
      toast.error("添加到对话失败", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      addingChatRef.current = false;
      setActionLoading(null);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Main panel */}
      <div className="flex flex-1 overflow-hidden" ref={mainRef}>

        {/* Left list column —— 放大时整列隐藏:预览宽=容器宽-4 已假定兄弟列消失(对齐 chat 隐藏主内容区),
           否则 min-w 列不收缩会把预览撑出容器、右侧「还原」按钮被 overflow-hidden 裁掉(看不见取消全屏) */}
        <div className={cn("flex flex-col flex-1 min-w-[280px] overflow-hidden", maximized && "hidden")}>

          {/* Topbar —— 只跨列表列,不横跨预览:预览卡浮在右侧、脱离标题栏。窄列时各项不换行,真放不下横向滚动(不露滚动条)。 */}
          <header className="relative flex items-center gap-3 pr-5 h-11 shrink-0 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <DragHandle />
            <SidebarToggle />
            <ResourceTabs active="files" />
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <span className="text-meta text-muted-foreground whitespace-nowrap shrink-0">{displayFiles.length} 个文件</span>
              {/* 去重清理按钮(B 功能) */}
              <button
                type="button"
                className="flex items-center gap-2 px-2.5 py-1 rounded-md text-meta text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
                onClick={() => void handleDedupAnalyze()}
                disabled={dedupCleaning}
                title="清理重复文件"
              >
                <HugeiconsIcon icon={CleanIcon} size={14} />
                {dedupCleaning ? "清理中…" : "清理重复"}
              </button>
              <button
                type="button"
                className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                onClick={togglePreview}
                title={previewCollapsed ? "展开预览" : "收起预览"}
                aria-label={previewCollapsed ? "展开预览" : "收起预览"}
                aria-expanded={!previewCollapsed}
              >
                {/* 与对话页右侧栏按钮同逻辑:收起态用「展开」图标、展开态用「面板」图标 */}
                <HugeiconsIcon icon={previewCollapsed ? LayoutAlignRightIcon : PanelRightIcon} size={16} />
              </button>
            </div>
          </header>

          {/* Search */}
          <div className="px-3.5 pt-3 pb-2 shrink-0">
            <div className="relative max-w-sm">
              <HugeiconsIcon icon={Search01Icon} size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                ref={searchRef}
                type="text"
                placeholder="搜索文件..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full h-8 pl-8 pr-7 text-body border border-input rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                aria-label="搜索文件"
              />
              {q && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => { setQ(""); searchRef.current?.focus(); }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Filter chips + sort */}
          <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border overflow-x-auto [scrollbar-width:none] shrink-0">
            {(["all", "upload", "generated", "library"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKindFilter(k)}
                className={cn(
                  "px-3 py-1 rounded-full border text-meta font-medium whitespace-nowrap cursor-pointer transition-colors",
                  kindFilter === k
                    ? k === "all"
                      ? "bg-foreground text-background border-transparent"
                      : KIND_CHIP_SELECTED[k]
                    : k === "all"
                      ? "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      : KIND_CHIP_UNSELECTED[k]
                )}
              >
                {k === "all" ? "全部" : KIND_LABELS[k]} {kindCounts[k] ?? 0}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1 shrink-0 pl-2">
              <span className="text-meta text-muted-foreground">排序:</span>
              {(["date", "name", "size"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSort(s)}
                  className={cn(
                    "px-2 py-0.5 rounded text-meta transition-colors",
                    sort === s ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s === "date" ? "时间" : s === "name" ? "名称" : "大小"}
                </button>
              ))}
            </div>
          </div>

          {/* Card grid with grouping */}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center h-24 text-body text-muted-foreground">
                正在加载...
              </div>
            )}
            {!loading && error && (
              <div className="px-4 py-6 text-body text-destructive">{error}</div>
            )}
            {!loading && !error && displayFiles.length === 0 && (
              <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
                <span className="text-body">暂无文件</span>
                <span className="text-meta">在对话里上传、或由 Agent 生成的文件，会在这里显示</span>
              </div>
            )}
            {!loading && !error && groups.map((group) => (
              <div key={group.groupKey} className="px-3.5 pt-4 pb-2">
                {/* Group title */}
                <div className="text-meta font-medium text-muted-foreground mb-2 flex items-center gap-2">
                  <span className="truncate">{group.title}</span>
                  <span className="text-muted-foreground/50 shrink-0">{group.files.length} 个</span>
                </div>
                {/* Card grid: auto-fill columns */}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {group.files.map((file) => (
                    <ResourceCard
                      key={file.id}
                      name={file.name}
                      mimeType={file.mime}
                      selected={selected?.id === file.id}
                      colorCls={KIND_CARD_CLS[file.kind]}
                      busy={actionLoading === file.id}
                      meta={
                        <>
                          {file.kept && (
                            <span className="inline-flex items-center text-amber-600 dark:text-amber-500" title="已保留">
                              <HugeiconsIcon icon={BookmarkAdd01Icon} size={12} />
                            </span>
                          )}
                          <span>{fmtBytes(file.sizeBytes)}</span>
                          <span className="text-muted-foreground/50">·</span>
                          <span>{fmtDate(file.createdAt)}</span>
                        </>
                      }
                      onClick={() => {
                        setSelected(selected?.id === file.id ? null : file);
                        openPreview();
                      }}
                      onChat={() => void addToChat(file)}
                      onDownload={() => void handleExport(file)}
                      menuItems={buildMenuItems(file)}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* 底部统计 */}
            {!loading && displayFiles.length > 0 && (
              <div className="px-3.5 py-3 text-meta text-muted-foreground">
                共 {displayFiles.length} 个文件
              </div>
            )}
          </div>
        </div>

        {/* Resize divider */}
        {!previewCollapsed && (
          <div
            className={cn("w-1 shrink-0 cursor-col-resize bg-clip-content px-[1.5px] hover:bg-primary/30 transition-colors", dragging && "bg-primary/30")}
            onMouseDown={beginResize}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            onDoubleClick={resetWidth}
          />
        )}

        {/* Right preview – AC1: 直接渲 FilePreviewPage,无外层 header */}
        {!previewCollapsed && (
          <div className={cn("flex flex-col shrink-0 preview-card-frame", maximized && "is-maximized")} style={{ width: previewW }}>
            {selected ? (
              previewSelection ? (
                <FilePreviewPage
                  selection={previewSelection}
                  onSelectionChange={() => {}}
                  title="资料预览"
                  description="文件内容预览"
                  onMaximize={maximize}
                  isMaximized={maximized}
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 flex-1 text-center p-6 text-muted-foreground">
                  <h3 className="text-body font-medium text-foreground">无法预览</h3>
                  <p className="text-body">该文件暂不支持在线预览</p>
                </div>
              )
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 h-full text-center p-6 text-muted-foreground">
                <h3 className="text-body font-medium text-foreground">选择文件预览</h3>
                <p className="text-body">点击左侧文件列表中的文件，在这里预览内容</p>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除文件"
        description={deleteTarget ? <>确定要删除「{deleteTarget.name}」吗？此操作会同时删除磁盘文件，不可恢复。</> : undefined}
        confirmLabel="确认删除"
        destructive
        onConfirm={confirmDelete}
      />

      {/* 去重清理确认框(B 功能) */}
      <ConfirmDialog
        open={dedupConfirmOpen}
        onOpenChange={(open) => { if (!open) setDedupConfirmOpen(false); }}
        title="确认清理重复文件"
        description={dedupAnalysis ? (
          <>
            发现 {dedupAnalysis.redundantFiles + dedupAnalysis.orphanFiles} 个重复/残留文件，
            可回收约 {fmtBytes(dedupAnalysis.reclaimableBytes)}。
            <br />
            <span className="text-muted-foreground text-body">操作不可撤销，是否继续？</span>
          </>
        ) : undefined}
        confirmLabel="确认清理"
        onConfirm={confirmDedupCleanup}
      />
    </div>
  );
}
