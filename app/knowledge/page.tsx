"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isTauri } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, LayoutAlignRightIcon, PanelRightIcon, Add01Icon, Search01Icon, Cancel01Icon, Clock01Icon, Edit01Icon, Archive01Icon, Archive02Icon, Delete02Icon, Folder02Icon, DatabaseIcon } from "@hugeicons/core-free-icons";
import { SuccessCircleIcon } from "@/lib/icons";
import { FilePreviewPage, type KnowledgePreviewFile } from "@/app/shared/file-preview-page";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { ResourceTabs } from "@/app/shared/resource-tabs";
import { FilterChipGroup } from "@/app/shared/filter-chip-group";
import { ResourceCard, type ResourceCardMenuItem } from "@/app/shared/resource-card";
import { PageSearchBar } from "@/app/shared/page-search-dialog";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import { usePreviewResize } from "@/app/shared/use-preview-resize";
import { ResizablePreviewPanel } from "@/app/shared/resizable-preview-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { inferCategory } from "@/lib/knowledge/category";
import type { DocMetadata } from "@/lib/knowledge/types";
import { Surface } from "@/components/ui/surface";
import { SearchResults } from "./search-results";
import {
  buildHitLines, CAT_LABELS, CATS, fmtBytes, fmtTime, isStaleDoc, highlightLine,
  type DocRow, type PreviewData, type SearchData,
} from "./shared";

// ─── MetaStatusBadge ─────────────────────────────────────
// 走全站 tone 系统(tone-ok/tone-warn)+ .fa-toned(压深文字达 AA、10% wash 底),
// 不再用 Tailwind emerald/amber 具名色,与其它状态标记同一套色语言。
function MetaStatusBadge({ status }: { status: string }) {
  const spec =
    status === "confirmed" ? { tone: "var(--tone-ok)", icon: SuccessCircleIcon, label: "已确认" }
    : status === "draft" ? { tone: "var(--tone-warn)", icon: Clock01Icon, label: "待确认" }
    : null;
  if (!spec) return null;
  return (
    <Surface
      level="page"
      edge="none"
      shape="chip"
      className="fa-toned inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium"
      style={{ ["--tone" as string]: spec.tone }}
    >
      <HugeiconsIcon icon={spec.icon} size={10} />{spec.label}
    </Surface>
  );
}

// ─── MetadataPanel ───────────────────────────────────────
function MetadataPanel({
  doc,
  onClose,
  onConfirm,
  onSave,
}: {
  doc: DocRow;
  onClose: () => void;
  onConfirm: (docId: number) => Promise<void>;
  onSave: (docId: number, metadata: DocMetadata) => Promise<void>;
}) {
  const parsed: DocMetadata = useMemo(() => {
    try { return doc.metadata ? JSON.parse(doc.metadata) : {}; } catch { return {}; }
  }, [doc.metadata]);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<DocMetadata>(parsed);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const p: DocMetadata = (() => { try { return doc.metadata ? JSON.parse(doc.metadata) : {}; } catch { return {}; } })();
    setForm(p);
    setEditing(false);
  }, [doc.id, doc.metadata]);

  async function handleSave() {
    setSaving(true);
    try { await onSave(doc.id, form); setEditing(false); } finally { setSaving(false); }
  }

  async function handleConfirm() {
    setConfirming(true);
    try { await onConfirm(doc.id); } finally { setConfirming(false); }
  }

  const display = editing ? form : parsed;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card shrink-0">
        <span className="flex-1 min-w-0 text-meta font-medium truncate">{doc.title}</span>
        <MetaStatusBadge status={doc.meta_status} />
        {/* eslint-disable-next-line no-restricted-syntax */}
        <button className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors" onClick={onClose} title="关闭">
          <HugeiconsIcon icon={Cancel01Icon} size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-meta">
        {[
          { label: "文档类型", key: "docType" as keyof DocMetadata },
          { label: "对方", key: "counterparty" as keyof DocMetadata },
          { label: "金额(元)", key: "amount" as keyof DocMetadata },
          { label: "货币", key: "amountCurrency" as keyof DocMetadata },
          { label: "周期", key: "recurrence" as keyof DocMetadata },
          { label: "业务状态", key: "status" as keyof DocMetadata },
        ].map(({ label, key }) => (
          <div key={key} className="flex flex-col gap-0.5">
            <label htmlFor={`meta-${key}`} className="text-caption text-muted-foreground">{label}</label>
            {editing ? (
              <Input
                id={`meta-${key}`}
                className="h-7 px-2 text-meta"
                value={String(form[key] ?? "")}
                onChange={e => {
                  const v = e.target.value;
                  setForm(prev => ({
                    ...prev,
                    [key]: key === "amount" ? (v === "" ? undefined : Number(v)) : (v || undefined),
                  }));
                }}
                placeholder="留空表示未知"
              />
            ) : (
              <span className={cn("text-foreground", !display[key] && "text-muted-foreground italic")}>
                {display[key] != null ? String(display[key]) : "—"}
              </span>
            )}
          </div>
        ))}
        {(display.keyDates ?? []).length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="text-caption text-muted-foreground font-medium">关键日期</span>
            <div className="space-y-1">
              {(display.keyDates ?? []).map((kd, i) => (
                <div key={i} className="flex gap-2 text-foreground">
                  <Surface level="page" edge="none" shape="chip" className="px-1.5 py-0.5 bg-muted text-muted-foreground text-caption">{kd.kind}</Surface>
                  <span>{kd.date}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {display.fields && Object.keys(display.fields).length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="text-caption text-muted-foreground font-medium">附加字段</span>
            <div className="space-y-1">
              {Object.entries(display.fields).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-muted-foreground">{k}:</span>
                  <span className="text-foreground">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!doc.metadata && (
          <p className="text-muted-foreground text-center py-6">暂无提炼要点。<br />上传后 Agent 自动提炼，或手动向 Agent 请求。</p>
        )}
      </div>
      <div className="flex gap-2 px-3 py-2 border-t border-border shrink-0">
        {editing ? (
          <>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => setEditing(false)}>取消</Button>
            <Button size="sm" className="flex-1" onClick={handleSave} disabled={saving}>{saving ? "保存中…" : "保存草稿"}</Button>
          </>
        ) : (
          <>
            {doc.meta_status !== "none" && (
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditing(true)} disabled={doc.meta_status === "confirmed"}>
                <HugeiconsIcon icon={Edit01Icon} size={12} />编辑
              </Button>
            )}
            {doc.meta_status === "draft" && (
              <Button size="sm" className="flex-1 gap-1" onClick={handleConfirm} disabled={confirming}>
                <HugeiconsIcon icon={SuccessCircleIcon} size={12} />{confirming ? "确认中…" : "确认生效"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── component ───────────────────────────────────────────

export default function KnowledgePage() {
  return (
    <Suspense fallback={null}>
      <KnowledgePageContent />
    </Suspense>
  );
}

function KnowledgePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // docs
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [docsError, setDocsError] = useState(false);
  const [filterCat, setFilterCat] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null);

  // metadata panel
  const [metaPanelDocId, setMetaPanelDocId] = useState<number | null>(null);

  // search
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [results, setResults] = useState<SearchData | null>(null);
  const [searchError, setSearchError] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  // preview
  const [previewDocId, setPreviewDocId] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<"file" | "search">("file");
  // 搜索命中→跳到原文件:存整份 linemap(镜像行→ xlsx{sheet,row} / pdf{page}),jumpTarget 随当前命中行派生,
  // 这样文件态内的 ↑↓(复用 navHit 改 hitIndex)能逐个命中跳。null=未从搜索跳入(直接开文件)。
  const [linemap, setLinemap] = useState<Array<{ sheet: string; row: number } | { page: number } | null> | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [hitLines, setHitLines] = useState<number[]>([]);
  const [hitIndex, setHitIndex] = useState<number>(-1);
  const previewContentRef = useRef<HTMLDivElement>(null);
  const lineEls = useRef<Map<number, HTMLElement>>(new Map());

  // reindex
  const [reindexing, setReindexing] = useState(false);

  // upload
  const [file, setFile] = useState<File | null>(null);
  const [upCat, setUpCat] = useState<string>("auto");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 内容哈希去重覆盖弹框
  const [overwriteTarget, setOverwriteTarget] = useState<{ existingId: number; existingTitle: string } | null>(null);

  // AC2: sidebar resize via shared hook
  // 列表列至少留 360:头部(对话文件｜知识库 + 文档数 + 收起)在更窄时会换行。
  const { collapsed: sidebarCollapsed, previewW: sidebarW, dragging, mainRef, beginResize, toggle: toggleSidebar, open: openSidebar, resetWidth, maximize, maximized } = usePreviewResize(360);

  const addingRef = useRef(false);

  const isSearchMode = results !== null && query.trim() !== "";

  // ─── docs ──────────────────────────────────────────

  const filteredDocs = useMemo(() => {
    const byArchive = docs.filter(d => (showArchived ? d.archived === 1 : d.archived !== 1));
    return filterCat === "all" ? byArchive : byArchive.filter(d => d.category === filterCat);
  }, [docs, filterCat, showArchived]);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/knowledge/documents");
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setDocsError(true);
      } else {
        setDocsError(false);
        setDocs(json.data.documents);
      }
    } catch {
      setDocsError(true);
    }
  }, []);

  useEffect(() => { void fetchDocs(); }, [fetchDocs]);

  // ?doc=<id> 来自全局搜索:文档加载后自动打开预览,然后清掉 URL 参数
  useEffect(() => {
    const docParam = searchParams.get("doc");
    if (!docParam || docs.length === 0) return;
    const targetId = Number(docParam);
    const doc = docs.find((d) => d.id === targetId || String(d.id) === docParam);
    if (doc) {
      viewFile(doc);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("doc");
      router.replace("/knowledge" + (next.toString() ? "?" + next.toString() : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, docs]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    await fetch(`/api/knowledge/documents/${deleteTarget.id}`, { method: "DELETE" });
    if (previewDocId === deleteTarget.id && previewMode === "file") { setPreviewDocId(null); setHitLines([]); setHitIndex(-1); }
    setDeleteTarget(null);
    void fetchDocs();
  }

  const catCounts = useMemo(() => {
    const active = docs.filter(d => d.archived !== 1);
    const m: Record<string, number> = { all: active.length };
    active.forEach(d => { m[d.category] = (m[d.category] ?? 0) + 1; });
    return m;
  }, [docs]);

  const archivedCount = useMemo(() => docs.filter(d => d.archived === 1).length, [docs]);

  const chips = [{ key: "all", label: "全部" }, ...CATS.map(c => ({ key: c, label: CAT_LABELS[c] ?? c }))];

  // ─── search ────────────────────────────────────────

  const doSearch = useCallback(async () => {
    const q = query.trim(); if (!q) { setResults(null); setSearchError(""); return; }
    setSearchError(""); setResults(null);
    try {
      const res = await fetch("/api/knowledge/search", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, topK: 20 }),
      });
      const json = await res.json();
      if (!json.ok) { setSearchError(json.error ?? "搜索失败"); setResults(null); }
      else { setResults(json.data); }
    } catch (err) { setSearchError(err instanceof Error ? err.message : "搜索失败"); setResults(null); }
    finally { /* search done */ }
  }, [query]);

  async function doReindex() {
    if (reindexing) return;
    setReindexing(true);
    try {
      const res = await fetch("/api/knowledge/reindex", { method: "POST" });
      const json = await res.json() as { ok: boolean; indexed?: number; skipped?: number; failed?: number; modelUnavailable?: boolean; error?: string };
      if (!json.ok) {
        toast.error("重建失败", { description: json.error });
      } else if (json.modelUnavailable) {
        toast.warning("嵌入模型不可用，语义索引未更新（仍可使用全文检索）");
      } else {
        toast.success(`语义索引已更新（新增 ${json.indexed ?? 0}，跳过 ${json.skipped ?? 0}，失败 ${json.failed ?? 0}）`);
      }
    } catch (err) {
      toast.error("重建失败", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setReindexing(false);
    }
  }

  async function toggleArchive(doc: DocRow) {
    await fetch(`/api/knowledge/documents/${doc.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: doc.archived !== 1 }),
    });
    fetchDocs();
  }

  // P1 合同归纳:metadata 确认/保存
  const metaPanelDoc = useMemo(() => docs.find(d => d.id === metaPanelDocId) ?? null, [docs, metaPanelDocId]);

  async function confirmMetadata(docId: number) {
    const res = await fetch(`/api/knowledge/documents/${docId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ metaStatus: "confirmed" }),
    });
    if (!(await res.json()).ok) { toast.error("确认失败"); return; }
    toast.success("已确认生效");
    fetchDocs();
  }

  async function saveMetadata(docId: number, metadata: import("@/lib/knowledge/types").DocMetadata) {
    const res = await fetch(`/api/knowledge/documents/${docId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ metaStatus: "draft", metadata }),
    });
    if (!(await res.json()).ok) { toast.error("保存失败"); return; }
    toast.success("草稿已保存");
    fetchDocs();
  }

  const loadSearchPreview = useCallback(async (docId: number) => {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/knowledge/documents/${docId}/content`);
      const json = await res.json();
      if (json.ok) setPreview(json.data); else setPreview(null);
    } catch { setPreview(null); }
    finally { setPreviewLoading(false); }
  }, []);

  function focusPreviewLine(lineNo: number) {
    const el = lineEls.current.get(lineNo);
    if (el) el.scrollIntoView({ block: "center" });
  }

  function navHit(delta: 1 | -1) {
    if (!hitLines.length) return;
    const next = (hitIndex + delta + hitLines.length) % hitLines.length;
    setHitIndex(next);
    focusPreviewLine(hitLines[next]);
  }

  // keyboard ↑↓
  useEffect(() => {
    if (previewMode !== "search" || !hitLines.length) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.key === "ArrowDown") { e.preventDefault(); navHit(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); navHit(-1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previewMode, hitLines, hitIndex]);

  useEffect(() => {
    if (hitIndex < 0 || !hitLines.length) return;
    focusPreviewLine(hitLines[hitIndex]);
  }, [hitIndex, hitLines]);

  useEffect(() => {
    lineEls.current.clear();
    return () => lineEls.current.clear();
  }, [preview]);

  // ─── preview actions ───────────────────────────────

  function viewFile(doc: DocRow) {
    setPreviewDocId(doc.id); setPreviewMode("file");
    setHitLines([]); setHitIndex(-1); setPreview(null);
    setLinemap(null); // 直接点开文件,清掉上一次搜索遗留的跳转映射
    openSidebar();
  }

  async function viewSearchResult(docId: number, lineNo?: number) {
    if (!results) return;
    const f = results.files.find(r => r.docId === docId);
    if (!f) return;
    const lines = buildHitLines(f);
    const idx = lineNo !== undefined ? lines.indexOf(lineNo) : 0;
    setPreviewDocId(docId);
    setHitLines(lines); setHitIndex(idx >= 0 ? idx : 0);
    loadSearchPreview(docId); // 预加载镜像,供"回搜索"用
    openSidebar();

    // xlsx/pdf:点命中直接进表格/翻页并跳到命中行(跳过镜像文本那步;jumpTarget 由 linemap+命中行派生)。
    const name = (f.fileName ?? "").toLowerCase();
    const isPdf = name.endsWith(".pdf");
    const isXlsx = name.endsWith(".xlsx");
    if (isPdf || isXlsx) {
      let lineMeta: Array<{ sheet: string; row: number } | { page: number } | null> | null = null;
      try {
        const res = await fetch(`/api/knowledge/documents/${docId}/${isPdf ? "pagemap" : "rowmap"}`);
        const json = await res.json();
        lineMeta = (json?.data?.lineMeta as typeof lineMeta) ?? null;
      } catch { /* 降级:不跳,仍开文件 */ }
      setLinemap(lineMeta);
      setPreviewMode("file");
      return;
    }

    // 其它类型(md/txt 等,镜像≈原文):镜像文本高亮视图
    setLinemap(null);
    setPreviewMode("search");
    if (lineNo) setTimeout(() => focusPreviewLine(lineNo), 0);
  }

  const currentFocusLine = hitIndex >= 0 && hitLines.length ? hitLines[hitIndex] : null;

  // 当前命中文档类型(决定按钮文案 + 取哪个映射端点 + 是否提供"在原文件中查看")
  const focusedDoc = previewDocId ? docs.find(x => x.id === previewDocId) : undefined;
  const focusedName = (focusedDoc?.file_name ?? "").toLowerCase();
  const focusedDocIsXlsx = Boolean(focusedDoc && (focusedDoc.mime_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || focusedName.endsWith(".xlsx")));
  const focusedDocIsPdf = Boolean(focusedDoc && (focusedDoc.mime_type === "application/pdf" || focusedName.endsWith(".pdf")));
  const focusedJumpable = focusedDocIsXlsx || focusedDocIsPdf;

  // 当前命中行(1 基)→ 跳转目标:xlsx 为 {sheet,row}、pdf 为 {page};派生自已取的 linemap;
  // 对不上(标记行/越界/无映射)为 null。文件态内 ↑↓ 改 hitIndex → 此值变 → file-preview 重新跳。
  const jumpTarget = (linemap && currentFocusLine != null) ? (linemap[currentFocusLine - 1] ?? null) : null;

  // 「在原文件中查看」:按类型取 rowmap(xlsx)/pagemap(pdf),存整份 linemap(供 ↑↓ 逐命中跳),切文件态。
  // 任何对不上(无映射/请求失败)都只是"切到文件态不跳",绝不乱跳、绝不崩。
  async function jumpToSource() {
    if (currentFocusLine == null || !previewDocId) return;
    const endpoint = focusedDocIsPdf ? "pagemap" : "rowmap";
    let lineMeta: Array<{ sheet: string; row: number } | { page: number } | null> | null = null;
    try {
      const res = await fetch(`/api/knowledge/documents/${previewDocId}/${endpoint}`);
      const json = await res.json();
      lineMeta = (json?.data?.lineMeta as typeof lineMeta) ?? null;
    } catch { /* 降级:不跳 */ }
    setLinemap(lineMeta);
    setPreviewMode("file");
    openSidebar();
  }

  const highlightKeywords = useMemo(() => {
    if (!previewDocId || !results) return new Set<string>();
    const f = results.files.find(r => r.docId === previewDocId);
    if (!f) return new Set<string>();
    const kws = new Set<string>();
    for (const m of f.matches) for (const [s, e] of m.ranges) kws.add(m.line.slice(s, e));
    return kws;
  }, [results, previewDocId]);

  const lines = useMemo(() => preview ? preview.text.split("\n") : [], [preview]);

  // 必须 memo:FilePreviewPage 按 selection「引用」重新加载预览(重取文件+重解析+重置 sheet/page)。
  // 只依赖真正决定「加载哪个文件」的量(文档/模式);打字改 query、↑↓ 改 jumpTarget 都不在内 →
  // selection 引用稳定 → 不触发重载。跳转目标走独立的 jumpTo prop(只滚动/高亮,不重载)。
  const previewSelection: KnowledgePreviewFile | null = useMemo(() => {
    if (!previewDocId || previewMode !== "file") return null;
    const d = docs.find(x => x.id === previewDocId);
    return d ? { kind: "knowledge", path: "", documentId: d.id, name: d.file_name, mimeType: d.mime_type, sizeBytes: d.size_bytes } : null;
  }, [previewDocId, previewMode, docs]);

  // ─── add to chat ───────────────────────────────────

  const addToChat = useCallback(async (docId: number) => {
    if (addingRef.current) return;
    addingRef.current = true;
    try {
      const res = await fetch(`/api/knowledge/documents/${docId}/download`);
      if (!res.ok) { toast.error("添加到对话失败", { description: `HTTP ${res.status}` }); return; }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?([^;]+)/);
      const fileName = fnMatch ? decodeURIComponent(fnMatch[1]) : "document";
      const mimeType = blob.type || "application/octet-stream";
      const dataUrl = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.readAsDataURL(blob); });
      let text: string | undefined;
      if (blob.size < 300 * 1024 && /text|json|xml|csv|md/i.test(mimeType)) text = await blob.text();
      const existing = JSON.parse(sessionStorage.getItem("pendingChatAttachments") ?? "[]");
      existing.push({ id: `${fileName}-${blob.size}-${Date.now()}-${crypto.randomUUID()}`, name: fileName, mimeType, size: blob.size, dataUrl, text });
      sessionStorage.setItem("pendingChatAttachments", JSON.stringify(existing));
      router.push("/chat/new");
    } catch (err) { toast.error("添加到对话失败", { description: err instanceof Error ? err.message : String(err) }); } finally { addingRef.current = false; }
  }, [router]);

  // ─── download (AC4:知识库新增下载) ─────────────────

  async function handleDownload(doc: DocRow) {
    try {
      let destPath: string | null = null;
      if (isTauri()) {
        destPath = await saveDialog({ defaultPath: doc.file_name });
      }
      if (!destPath) return;
      // 经 Tauri 保存框另存,走 storage_path 绝对路径(不外发,仅本机)
      const res = await fetch(`/api/knowledge/documents/${doc.id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destPath }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error);
      toast.success("已另存为 " + destPath);
    } catch (err) {
      toast.error(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── upload ────────────────────────────────────────

  // 知识库支持的上传类型(accept + 上传前校验 + 友好报错共用)
  const KB_SUPPORTED_EXTS = [".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".png", ".jpg", ".jpeg", ".webp"];
  const KB_SUPPORTED_LABEL = "PDF / Word(.docx) / Excel(.xlsx) / PPT(.pptx) / 文本(.txt/.md/.csv) / 图片(.png/.jpg/.webp)";
  const fileExt = (name: string) => { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i).toLowerCase() : ""; };
  const friendlyUploadError = (err?: string) => {
    if (!err) return "未知错误";
    if (err.includes("不支持的文件类型")) return `该文件类型暂不支持入库。支持:${KB_SUPPORTED_LABEL}`;
    if (err.includes("文档内容为空")) return "没从文件里提取到文字(图片可能没识别到文字,或文档本身是空的)。";
    if (err.includes(".xls")) return "旧版 .xls 不支持,请用 Excel/WPS『另存为 .xlsx』再上传。";
    return err;
  };

  async function doUpload(overwrite = false, fileArg?: File, catArg?: string) {
    const f = fileArg ?? file;
    const cat = catArg ?? upCat;
    if (!f) return;
    setUploading(true); setProgress("上传中…");
    try {
      const form = new FormData();
      form.append("file", f); form.append("title", f.name);
      if (cat !== "auto") form.append("category", cat);
      if (overwrite) form.append("overwrite", "true");
      const res = await fetch("/api/knowledge/documents", { method: "POST", body: form });
      const json = await res.json() as {
        ok: boolean;
        exists?: boolean;
        existingId?: number;
        existingTitle?: string;
        error?: string;
      };
      if (!json.ok) { setProgress(""); toast.error("上传失败", { description: friendlyUploadError(json.error) }); return; }
      if (json.exists && json.existingId !== undefined) {
        // 命中同内容 → 弹覆盖确认框
        setProgress("");
        setOverwriteTarget({ existingId: json.existingId, existingTitle: json.existingTitle ?? f.name });
        return;
      }
      setProgress("完成"); setFile(null); fetchDocs(); setTimeout(() => { setProgress(""); }, 800);
    } finally { setUploading(false); }
  }

  async function confirmOverwrite() {
    setOverwriteTarget(null);
    await doUpload(true);
  }

  // ─── build ⋮ menu for knowledge cards ─────────────

  function buildMenuItems(doc: DocRow): ResourceCardMenuItem[] {
    const archived = doc.archived === 1;
    const items: ResourceCardMenuItem[] = [];

    // 在系统中显示
    items.push({
      label: "在文件夹中显示",
      icon: <HugeiconsIcon icon={Folder02Icon} size={13} />,
      onClick: async () => {
        try {
          const res = await fetch(`/api/knowledge/documents/${doc.id}/reveal`, { method: "POST" });
          const json = await res.json() as { ok: boolean; error?: string };
          if (!json.ok) throw new Error(json.error);
        } catch (err) {
          toast.error(`在系统中显示失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // 归档 / 恢复
    items.push({
      label: archived ? "恢复(重新加入检索)" : "归档(从检索中移除)",
      icon: archived ? <HugeiconsIcon icon={Archive01Icon} size={13} /> : <HugeiconsIcon icon={Archive02Icon} size={13} />,
      onClick: () => toggleArchive(doc),
    });

    // 删除
    items.push({
      label: "删除",
      icon: <HugeiconsIcon icon={Delete02Icon} size={13} />,
      onClick: () => setDeleteTarget(doc),
      destructive: true,
      separator: true,
    });

    return items;
  }

  // ─── render ────────────────────────────────────────

  // 三路预览内容（依赖 knowledge 本地状态，原封不动进 preview 插槽）
  const previewContent = !sidebarCollapsed ? (
    metaPanelDoc ? (
      <MetadataPanel
        doc={metaPanelDoc}
        onClose={() => setMetaPanelDocId(null)}
        onConfirm={confirmMetadata}
        onSave={saveMetadata}
      />
    ) : previewMode === "file" ? (
      previewSelection ? (
        <div className="flex flex-col h-full overflow-hidden">
          {/* 从搜索跳入文件:顶部命中导航,↑↓ 逐个命中跳(复用 navHit→改 hitIndex→jumpTarget 派生变) */}
          {linemap && hitLines.length > 0 ? (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0 min-h-[33px]">
              <span className="text-caption text-muted-foreground whitespace-nowrap">第 {hitIndex + 1}/{hitLines.length} 个匹配</span>
              {/* eslint-disable-next-line no-restricted-syntax */}
              <button
                className="size-7 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                onClick={() => navHit(-1)}
                title="上一个匹配"
              >
                <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
              </button>
              {/* eslint-disable-next-line no-restricted-syntax */}
              <button
                className="size-7 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                onClick={() => navHit(1)}
                title="下一个匹配"
              >
                <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
              </button>
              <span className="flex-1" />
              {/* eslint-disable-next-line no-restricted-syntax */}
              <button
                className="px-2 h-7 flex items-center whitespace-nowrap text-caption border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                onClick={() => setPreviewMode("search")}
                title="回到搜索结果列表"
              >
                回搜索
              </button>
            </div>
          ) : null}
          <div className="flex-1 min-h-0">
            <FilePreviewPage
              selection={previewSelection}
              jumpTo={jumpTarget ?? undefined}
              title={docs.find(d => d.id === previewDocId)?.title}
              description="知识库文档预览"
              onMaximize={maximize}
              isMaximized={maximized}
              onCollapse={toggleSidebar}
            />
          </div>
        </div>
      ) : (
        <div className="relative flex flex-col items-center justify-center gap-2 h-full text-center p-6 text-muted-foreground">
          {/* eslint-disable-next-line no-restricted-syntax */}
          <button type="button" className="preview-empty-collapse-btn p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" onClick={toggleSidebar} aria-label="收起预览">
            <HugeiconsIcon icon={PanelRightIcon} size={16} />
          </button>
          <h3 className="text-body font-medium text-foreground">选择文档预览</h3>
          <p className="text-body">点击卡片查看文档内容</p>
        </div>
      )
    ) : (
      previewLoading ? (
        <div className="relative flex items-center justify-center h-full text-body text-muted-foreground">
          {/* eslint-disable-next-line no-restricted-syntax */}
          <button type="button" className="preview-empty-collapse-btn p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" onClick={toggleSidebar} aria-label="收起预览">
            <HugeiconsIcon icon={PanelRightIcon} size={16} />
          </button>
          加载中…
        </div>
      ) : preview ? (
        <div className="flex flex-col h-full overflow-hidden">
          {/* Preview nav bar */}
          <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card shrink-0 min-h-[33px]">
            <span className="flex-1 min-w-0 text-meta font-medium truncate" title={preview.fileName}>{preview.fileName}</span>
            {hitLines.length > 0 ? (
              <>
                <span className="text-caption text-muted-foreground whitespace-nowrap">第 {hitIndex + 1}/{hitLines.length} 个匹配</span>
                {focusedJumpable ? (
                  // eslint-disable-next-line no-restricted-syntax
                  <button
                    className="px-2 h-7 flex items-center whitespace-nowrap text-caption border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                    onClick={() => void jumpToSource()}
                    title={focusedDocIsPdf ? "翻到命中所在页" : "切到表格并高亮命中所在行"}
                  >
                    {focusedDocIsPdf ? "在原文中查看" : "在表格中查看"}
                  </button>
                ) : null}
                {/* eslint-disable-next-line no-restricted-syntax */}
                <button
                  className="size-7 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                  onClick={() => navHit(-1)}
                  title="上一个匹配 (↑)"
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
                </button>
                {/* eslint-disable-next-line no-restricted-syntax */}
                <button
                  className="size-7 flex items-center justify-center border border-border rounded-md text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                  onClick={() => navHit(1)}
                  title="下一个匹配 (↓)"
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
                </button>
              </>
            ) : (
              <span className="text-caption text-muted-foreground">{lines.length} 行</span>
            )}
            {/* eslint-disable-next-line no-restricted-syntax */}
            <button type="button" className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" onClick={toggleSidebar} aria-label="收起预览">
              <HugeiconsIcon icon={PanelRightIcon} size={16} />
            </button>
          </div>
          {/* Preview content */}
          <div className="flex-1 overflow-y-auto font-mono text-meta leading-relaxed" ref={previewContentRef}>
            {preview.text.length > 1_000_000 && (
              <div className="px-3 py-2 text-meta text-muted-foreground bg-[color:var(--tone-warn)]/10 border-b border-border">
                文件较大，仅显示前 1MB。
                <a href={`/api/knowledge/documents/${previewDocId}/download`} className="text-primary ml-2">下载完整文件</a>
              </div>
            )}
            <pre className="m-0 p-0 whitespace-pre-wrap break-all">
              {lines.slice(0, 20000).map((line, i) => {
                const lineNo = i + 1;
                const isHit = hitLines.includes(lineNo);
                const isTarget = lineNo === currentFocusLine;
                return (
                  <div
                    key={lineNo}
                    ref={el => { if (el) lineEls.current.set(lineNo, el); else lineEls.current.delete(lineNo); }}
                    className={cn("flex min-h-[22px] pr-3 transition-colors", isTarget ? "bg-accent" : isHit ? "bg-accent/40" : "")}
                    data-line={lineNo}
                  >
                    <span className="shrink-0 w-14 text-right pr-3 text-caption text-muted-foreground/50 select-none">{lineNo}</span>
                    <span className="flex-1 text-foreground">
                      {isHit && highlightKeywords.size > 0
                        ? highlightLine(line, Array.from(highlightKeywords).flatMap(kw => { const idx = line.indexOf(kw); return idx >= 0 ? [[idx, idx + kw.length] as [number, number]] : []; }))
                        : line}
                    </span>
                  </div>
                );
              })}
            </pre>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-col items-center justify-center gap-2 h-full text-center p-6 text-muted-foreground">
          {/* eslint-disable-next-line no-restricted-syntax */}
          <button type="button" className="preview-empty-collapse-btn p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" onClick={toggleSidebar} aria-label="收起预览">
            <HugeiconsIcon icon={PanelRightIcon} size={16} />
          </button>
          <h3 className="text-body font-medium text-foreground">选择搜索结果预览</h3>
          <p className="text-body">点击搜索结果查看文件内容</p>
        </div>
      )
    )
  ) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <ResizablePreviewPanel
        mainRef={mainRef}
        previewW={sidebarW}
        maximized={maximized}
        collapsed={sidebarCollapsed}
        dragging={dragging}
        onBeginResize={beginResize}
        onResetWidth={resetWidth}
        list={
          <>

          {/* Topbar —— 只跨列表列,不横跨预览:预览卡浮在右侧、脱离标题栏。窄列时各项不换行,真放不下横向滚动(不露滚动条)。 */}
          <header className="app-page-header relative flex items-center gap-3 pr-5 h-11 shrink-0 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <DragHandle />
            <SidebarToggle />
            <ResourceTabs active="knowledge" />
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {/* eslint-disable-next-line no-restricted-syntax */}
              <button
                type="button"
                className={cn("inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", reindexing && "opacity-40 cursor-not-allowed")}
                onClick={() => void doReindex()}
                disabled={reindexing}
                title={reindexing ? "重建中…" : "重建语义索引"}
                aria-label="重建语义索引"
              >
                <HugeiconsIcon icon={DatabaseIcon} size={16} />
              </button>
              <ShortcutHint label="搜索" combo="mod+f">
                {/* eslint-disable-next-line no-restricted-syntax */}
                <button
                  type="button"
                  className={cn("inline-grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", query && "bg-accent text-foreground")}
                  onClick={() => setSearchOpen(true)}
                  aria-label="搜索"
                >
                  <HugeiconsIcon icon={Search01Icon} size={16} />
                </button>
              </ShortcutHint>
              <span className="text-meta text-muted-foreground whitespace-nowrap shrink-0">{docs.length} 份文档</span>
              {sidebarCollapsed ? (
                // eslint-disable-next-line no-restricted-syntax
                <button
                  type="button"
                  className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  onClick={toggleSidebar}
                  title="展开预览"
                  aria-label="展开预览"
                  aria-expanded={false}
                >
                  <HugeiconsIcon icon={LayoutAlignRightIcon} size={16} />
                </button>
              ) : null}
            </div>
          </header>

          <FilterChipGroup
            value={showArchived ? "__archived" : filterCat}
            options={[
              ...chips.map(({ key, label }) => ({ value: key, label, count: catCounts[key] ?? 0 })),
              ...(archivedCount > 0 ? [{ value: "__archived", label: "已归档", count: archivedCount }] : []),
            ]}
            onValueChange={(value) => {
              if (value === "__archived") {
                setShowArchived(true);
                return;
              }
              setShowArchived(false);
              setFilterCat(value);
            }}
            ariaLabel="知识库分类"
          />

          <PageSearchBar
            open={searchOpen}
            onOpenChange={setSearchOpen}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              if (!value) { setResults(null); setSearchError(""); }
            }}
            onSubmit={() => void doSearch()}
            placeholder="搜索知识库…"
            label="搜索知识库"
          />

          {/* Doc grid / search results */}
          <div className="content-fade-top flex-1 overflow-y-auto">
            {isSearchMode ? (
              <SearchResults
                results={results}
                error={searchError}
                activeDocId={previewDocId}
                active={previewMode === "search"}
                onViewLine={viewSearchResult}
                onAddToChat={addToChat}
              />
            ) : (
              <>
              {docsError && docs.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-body text-muted-foreground">
                  <p>文档加载失败。</p>
                  <Button variant="outline" size="sm" onClick={() => void fetchDocs()}>重试</Button>
                </div>
              ) : null}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-3.5">
                {/* 上传卡:常驻网格首位,点击直接弹系统文件选择器 */}
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept={KB_SUPPORTED_EXTS.join(",")}
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    const ext = fileExt(f.name);
                    if (ext === ".xls") {
                      toast.error("不支持旧版 .xls 格式", { description: "请用 Excel/WPS 打开后『另存为 .xlsx』再上传。" });
                      return;
                    }
                    if (!KB_SUPPORTED_EXTS.includes(ext)) {
                      toast.error(`不支持的文件类型${ext ? " " + ext : ""}`, { description: `目前支持:${KB_SUPPORTED_LABEL}` });
                      return;
                    }
                    const cat = inferCategory(f.name);
                    setFile(f);
                    setUpCat(cat);
                    void doUpload(false, f, cat);
                  }}
                />
                {/* eslint-disable-next-line no-restricted-syntax */}
                <button
                  type="button"
                  title="上传文档"
                  onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
                  disabled={uploading}
                  className="flex flex-col items-center justify-center gap-1.5 min-h-[120px] border-2 border-dashed border-border rounded-xl text-muted-foreground cursor-pointer transition-colors hover:border-primary/50 hover:text-primary hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-muted-foreground disabled:hover:bg-transparent"
                >
                  <HugeiconsIcon icon={Add01Icon} size={24} />
                  <span className="text-body">{uploading || progress ? (progress || "上传中…") : "上传文档"}</span>
                </button>
                {filteredDocs.map(doc => {
                  const archived = doc.archived === 1;
                  const stale = !archived && isStaleDoc(doc);
                  return (
                    <ResourceCard
                      key={doc.id}
                      name={doc.title}
                      mimeType={doc.mime_type}
                      selected={previewDocId === doc.id && previewMode === "file"}
                      archived={archived}
                      meta={
                        <>
                          <span>{doc.hit_count > 0 ? `检索 ${doc.hit_count} 次` : "未被检索"}</span>
                          <span className="text-muted-foreground/50">·</span>
                          <span>{doc.last_hit_at ? `最近 ${fmtTime(doc.last_hit_at)}` : `更新于 ${fmtTime(doc.updated_at)}`}</span>
                          {archived && <Surface level="page" edge="none" shape="chip" className="px-1.5 py-0.5 bg-muted text-muted-foreground">已归档</Surface>}
                          {stale && <Surface level="page" edge="none" shape="chip" className="fa-toned px-1.5 py-0.5 text-caption" style={{ ["--tone" as string]: "var(--tone-warn)" }}>长期未使用</Surface>}
                        </>
                      }
                      onClick={() => viewFile(doc)}
                      onChat={!archived ? () => void addToChat(doc.id) : undefined}
                      onDownload={() => void handleDownload(doc)}
                      menuItems={buildMenuItems(doc)}
                    />
                  );
                })}
              </div>
              {filteredDocs.length === 0 && docs.length > 0 && (
                <div className="pb-4 text-center text-body text-muted-foreground">{showArchived ? "没有已归档文档" : "无匹配文档"}</div>
              )}
              </>
            )}
          </div>
          </>
        }
        preview={previewContent}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => { if (!open) setDeleteTarget(null); }}
        title="删除文档"
        description={deleteTarget ? <>确定要删除「{deleteTarget.title}」吗？</> : undefined}
        confirmLabel="确认"
        destructive
        onConfirm={confirmDelete}
      />

      {/* 内容哈希去重覆盖确认框(A 功能) */}
      <ConfirmDialog
        open={!!overwriteTarget}
        onOpenChange={open => { if (!open) setOverwriteTarget(null); }}
        title="库内已存在同文件"
        description={overwriteTarget ? (
          <>
            库内已存在同文件「{overwriteTarget.existingTitle}」（内容相同），是否覆盖？
            <br />
            <span className="text-muted-foreground text-body">取消则放弃本次上传。</span>
          </>
        ) : undefined}
        confirmLabel="覆盖更新"
        cancelLabel="取消"
        onConfirm={confirmOverwrite}
      />
    </div>
  );
}
