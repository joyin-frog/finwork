"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "@tauri-apps/api/core";
import { open as openShell } from "@tauri-apps/plugin-shell";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type ExcelJS from "exceljs";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowExpand01Icon, ArrowShrink01Icon, FileSearchIcon, Folder02Icon, LibraryIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import DocxPreviewWrapper from "@/app/shared/docx-preview-wrapper";
import { formatNumber, isNumericFormat } from "@/lib/preview/numfmt";
import { sanitizeXlsxForPreview } from "@/lib/preview/xlsx-sanitize";

export type ConversationPreviewFile = {
  kind: "conversation";
  conversationId: number;
  /** 会话附件 id;给定时预览页提供「加入知识库」(只有落库附件有 id)。 */
  attachmentId?: string;
  storagePath: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type LocalPreviewFile = {
  kind: "local";
  path: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type DraftPreviewFile = {
  kind: "draft";
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  dataUrl: string;
  text?: string;
};

export type KnowledgePreviewFile = {
  kind: "knowledge";
  documentId: number;
  name: string;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type PreviewFileSelection = ConversationPreviewFile | LocalPreviewFile | DraftPreviewFile | KnowledgePreviewFile;

type LoadedPreview =
  | { kind: "markdown"; text: string; meta: PreviewMeta }
  | { kind: "text"; text: string; meta: PreviewMeta }
  | { kind: "image"; src: string; meta: PreviewMeta & { width?: number; height?: number } }
  | { kind: "excel"; workbook: ExcelWorkbook; meta: PreviewMeta }
  | { kind: "docx"; bytes: Uint8Array; meta: PreviewMeta }
  | { kind: "pdf"; src: string; meta: PreviewMeta }
  | { kind: "download"; href: string; meta: PreviewMeta }
  | { kind: "unsupported"; meta: PreviewMeta; reason: string };

type PreviewMeta = {
  name: string;
  extension: string;
  mimeType: string;
  sizeBytes?: number;
  sourceLabel: string;
};

type ExcelWorkbook = {
  sheets: ExcelSheet[];
};

type ExcelSheet = {
  name: string;
  columnHeaders: string[];
  columnWidths: number[];
  rows: ExcelSheetRow[];
  focusCellLabel: string;
  /** 公式栏内容:含公式格用"=公式",普通格用展示值 */
  focusCellValue: string;
};

type ExcelSheetRow = {
  rowNumber: number;
  cells: ExcelCell[];
};

type ExcelCell = {
  key: string;
  columnIndex: number;
  /** 格式化后的展示文本(numFmt 已应用) */
  value: string;
  /** 原始公式字符串,如 "=SUM(A1:A4)";仅含公式的单元格有此字段 */
  formula?: string;
  colSpan: number;
  rowSpan: number;
  style?: {
    backgroundColor?: string;
    borderTop?: string;
    borderRight?: string;
    borderBottom?: string;
    borderLeft?: string;
    fontWeight?: string;
    textAlign?: string;
    color?: string;
  };
  /** true 表示数字类型,用于右对齐判定 */
  isNumeric?: boolean;
  /** 负数(用于红色渲染) */
  isNegative?: boolean;
};

type PdfComponents = {
  Document: any;
  Page: any;
} | null;

type OpenWithApp = {
  name: string;
  path: string;
  iconUrl?: string;
};

export function FilePreviewPage({
  selection,
  onSelectionChange,
  title = "",
  description = "选择本地文件或点击对话文件，在这里预览内容。",
  jumpTo,
  onMaximize,
  isMaximized,
  docked,
}: {
  selection: PreviewFileSelection | null;
  onSelectionChange?: (selection: PreviewFileSelection | null) => void;
  title?: string;
  description?: string;
  /** 搜索命中→跳转目标(独立于 selection:换命中行只滚动/高亮,不触发文件重载)。
   *  xlsx={sheet,row}、pdf={page}。 */
  jumpTo?: { sheet: string; row: number } | { page: number };
  /** 放大:由父级(可调宽面板)提供;给定时头部显示放大按钮,点击把预览铺满内容区。 */
  onMaximize?: () => void;
  /** 当前是否已放大(铺满):控制按钮图标在 放大⤢ / 还原⤡ 间切换。 */
  isMaximized?: boolean;
  /** 停靠在内容右侧时(对话页 / 资料页)做成浮起卡片:顶部脱离标题栏 + 上方圆角 + 描边 + 柔影;
   *  全屏(isMaximized)时自动铺满。独立 /preview 整页不传,保持满铺。 */
  docked?: boolean;
}) {
  const [currentSelection, setCurrentSelection] = useState<PreviewFileSelection | null>(selection);
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [focusCell, setFocusCell] = useState<{ label: string; barValue: string } | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfComponents, setPdfComponents] = useState<PdfComponents>(null);
  const [pdfLoadError, setPdfLoadError] = useState<string | null>(null);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openWithApps, setOpenWithApps] = useState<OpenWithApp[] | null>(null);
  const [loadingOpenWithApps, setLoadingOpenWithApps] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const runningInTauri = useMemo(() => isTauri(), []);
  const needsPdfViewer = currentSelection ? getExtension(currentSelection.name) === "pdf" : false;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentSelection(selection);
  }, [selection]);

  useEffect(() => {
    let cancelled = false;
    async function loadPdfJs() {
      try {
        ensurePromiseWithResolvers();
        // Wrap import in a safety layer — webpack chunk loading can throw synchronously
        const pdfModule = await new Promise<typeof import("react-pdf")>((resolve, reject) => {
          import("react-pdf").then(resolve, reject);
        }).catch((err) => {
          console.warn("react-pdf import failed, using native viewer", err);
          return null;
        });
        if (cancelled || !pdfModule) return;
        const { Document, Page, pdfjs } = pdfModule;
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
        setPdfLoadError(null);
        setPdfComponents({ Document, Page });
      } catch (loadError) {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : "未知错误";
        console.error("Failed to load react-pdf", loadError);
        setPdfLoadError(`PDF 高级预览器加载失败，已回退为原生预览。${message}`);
      }
    }

    if (typeof window !== "undefined" && needsPdfViewer && !pdfComponents) {
      void loadPdfJs();
    }

    return () => {
      cancelled = true;
    };
  }, [needsPdfViewer, pdfComponents]);

  useEffect(() => {
    let cancelled = false;
    let urlToRevoke: string | null = null;

    async function load() {
      if (!currentSelection) {
        setPreview(null);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      setPdfLoadError(null);
      setActiveSheet(0);
      setPdfPage(1);
      setPdfPages(0);

      try {
        const loaded = await loadPreview(currentSelection);
        if (cancelled) {
          if ("src" in loaded && loaded.src.startsWith("blob:")) URL.revokeObjectURL(loaded.src);
          return;
        }
        if ("src" in loaded && loaded.src.startsWith("blob:")) urlToRevoke = loaded.src;
        setPreview(loaded);
      } catch (loadError) {
        if (!cancelled) {
          setPreview(null);
          setError(loadError instanceof Error ? loadError.message : "文件预览失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
    };
  }, [currentSelection]);

  async function pickLocalFile() {
    const result = await openDialog({
      multiple: false,
      filters: [
        { name: "预览文件", extensions: ["md", "txt", "png", "jpg", "jpeg", "gif", "webp", "xlsx", "xls", "csv", "docx", "pdf", "pptx", "ppt"] }
      ]
    });
    if (!result || Array.isArray(result)) return;
    const nextSelection: LocalPreviewFile = {
      kind: "local",
      path: result,
      name: getNameFromPath(result),
      mimeType: inferMimeType(result)
    };
    setCurrentSelection(nextSelection);
    onSelectionChange?.(nextSelection);
  }

  async function toggleOpenWithMenu() {
    if (!currentSelection) return;
    if (openMenuOpen) {
      setOpenMenuOpen(false);
      return;
    }
    setOpenMenuOpen(true);
    if (openWithApps || loadingOpenWithApps) return;
    setLoadingOpenWithApps(true);
    try {
      const params = new URLSearchParams({
        name: currentSelection.name,
        mimeType: currentSelection.mimeType ?? inferMimeType(currentSelection.name)
      });
      const response = await fetch(`/api/open-with/apps?${params.toString()}`);
      const payload = (await response.json()) as { ok: boolean; data?: { apps: OpenWithApp[] } };
      setOpenWithApps(payload.ok ? payload.data?.apps ?? [] : []);
    } catch {
      setOpenWithApps([]);
    } finally {
      setLoadingOpenWithApps(false);
    }
  }

  async function openCurrentFile(openWith?: string) {
    if (!currentSelection) return;
    setOpenMenuOpen(false);
    if (currentSelection.kind === "conversation") {
      await openConversationSelection(currentSelection, openWith);
      return;
    }
    if (currentSelection.kind === "draft") return;
    if (currentSelection.kind === "knowledge") return;
    if (!runningInTauri) return;
    const targetApp = openWith && openWith.length ? openWith : undefined;
    await openShell(currentSelection.path, targetApp);
  }

  async function revealCurrentFile() {
    if (!currentSelection) return;
    setOpenMenuOpen(false);
    if (currentSelection.kind === "conversation") {
      await revealConversationSelection(currentSelection);
      return;
    }
    if (currentSelection.kind === "draft") return;
    if (!runningInTauri) return;
    await openShell(getParentPath(currentSelection.path));
  }

  // 加入知识库:重操作,放在预览之后(用户看过内容再决定)。复用文件库 promote(attach:<id>),
  // 红线 7(全本地不外发)/ 红线 8(落审计)已在该路由内覆盖;只对有 id 的会话附件可用。
  async function addCurrentToKnowledge() {
    if (currentSelection?.kind !== "conversation" || !currentSelection.attachmentId || promoting) return;
    setPromoting(true);
    try {
      const res = await fetch("/api/files-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote", fileId: `attach:${currentSelection.attachmentId}` }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string; alreadyExists?: boolean };
      if (!payload.ok) throw new Error(payload.error ?? "加入失败");
      if (payload.alreadyExists) toast.info("该文件已在知识库中（内容相同）");
      else toast.success("已加入知识库");
    } catch (err) {
      toast.error(`加入知识库失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPromoting(false);
    }
  }

  useEffect(() => {
    if (!openMenuOpen) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [openMenuOpen]);

  const excelSheets = preview?.kind === "excel" ? preview.workbook.sheets : [];
  const activeExcelSheet = excelSheets[activeSheet];

  // ── 搜索命中→跳到表格对应行(行级,不做单元格级高亮:稳)。jumpTo 由知识库搜索侧传入。 ──
  const jumpSheet = jumpTo && "sheet" in jumpTo ? jumpTo.sheet : undefined;
  const jumpRow = jumpTo && "row" in jumpTo ? jumpTo.row : undefined;
  const jumpPage = jumpTo && "page" in jumpTo ? jumpTo.page : undefined;
  const [flashRow, setFlashRow] = useState<number | null>(null);
  const excelGridRef = useRef<HTMLDivElement>(null);
  const [excelFillerRows, setExcelFillerRows] = useState(0);
  // xlsx:切到目标工作表并标记要闪烁的行;对不上(工作表名找不到/无 jumpTo)就不跳,绝不乱跳
  useEffect(() => {
    if (preview?.kind !== "excel" || jumpSheet == null || jumpRow == null) { setFlashRow(null); return; }
    const idx = preview.workbook.sheets.findIndex((s) => s.name === jumpSheet);
    if (idx >= 0) setActiveSheet(idx);
    setFlashRow(jumpRow);
  }, [preview, jumpSheet, jumpRow]);
  // pdf:翻到命中所在页(越界则钳到有效范围;无 jumpPage 不动)
  useEffect(() => {
    if (preview?.kind !== "pdf" || jumpPage == null) return;
    setPdfPage(pdfPages > 0 ? Math.min(Math.max(jumpPage, 1), pdfPages) : Math.max(jumpPage, 1));
  }, [preview, jumpPage, pdfPages]);
  // 滚动到命中行(持续高亮、不自动撤,直到换命中行/换文档)。表格行由 exceljs 解析后才渲染,
  // rAF 之外再补一次延时滚动,避免首跳时行尚未挂载导致没滚到。
  useEffect(() => {
    if (flashRow == null) return;
    const scrollToRow = () =>
      excelGridRef.current?.querySelector(`tr[data-rownum="${flashRow}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    const raf = requestAnimationFrame(scrollToRow);
    const t = window.setTimeout(scrollToRow, 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [flashRow, activeSheet]);
  // xlsx:数据行不足以填满视口时,在下方补「空网格行」铺满(像真 Excel,中间空网格、sheet 标签置底)。
  // 按滚动视口高 ÷ 行高算需补几行;ResizeObserver 跟随侧栏拖宽 / 放大 / 窗口变化重算。
  useEffect(() => {
    const scrollEl = excelGridRef.current;
    const sheet = preview?.kind === "excel" ? preview.workbook.sheets[activeSheet] : undefined;
    if (!scrollEl || !sheet) { setExcelFillerRows(0); return; }
    const recompute = () => {
      const el = excelGridRef.current;
      if (!el) return;
      const headH = (el.querySelector("thead tr") as HTMLElement | null)?.getBoundingClientRect().height ?? 28;
      const rowH = (el.querySelector("tbody tr") as HTMLElement | null)?.getBoundingClientRect().height ?? 24;
      if (rowH <= 0) return;
      const fit = Math.floor((el.clientHeight - headH) / rowH);
      setExcelFillerRows(Math.max(0, fit - sheet.rows.length));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [preview, activeSheet]);

  // 公式栏显示:优先用用户点击的格;否则用 sheet 初始焦点
  const formulaBarLabel = focusCell?.label ?? activeExcelSheet?.focusCellLabel ?? "";
  const formulaBarValue = focusCell?.barValue ?? activeExcelSheet?.focusCellValue ?? "";
  // 当前选中单元格的行号/列号:给所在行号格 + 列头加激活态(Excel 真实感)
  const activeCellPos = parseA1Address(formulaBarLabel);
  // 预览强调色:按文件类型走文件图标色(Excel 绿 / Word 蓝 / PDF 红…),回落主色
  const previewAccent = currentSelection ? fileAccentColor(currentSelection.name) : "var(--primary)";
  const emptyTitle = title || "右侧现在是文件预览页";
  const emptyDescription = description || "点击顶部面板中的文件，或者用系统文件选择器打开本地文件。";

  return (
    <section className={`preview-page-shell${docked ? " is-docked" : ""}${isMaximized ? " is-maximized" : ""}`}>
      <div className="preview-page-head">
        <div className="preview-head-card">
          <span className="preview-head-title">{currentSelection?.name ?? "未选择文件"}</span>
          <div className="flex items-center gap-2 shrink-0">
          {currentSelection && currentSelection.kind !== "draft" ? (
            <div className="relative shrink-0" ref={menuRef}>
              <button
                className="preview-open-button"
                type="button"
                onClick={() => void toggleOpenWithMenu()}
                aria-expanded={openMenuOpen}
                aria-haspopup="menu"
              >
                <span>打开方式</span>
                <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
              </button>
              {openMenuOpen ? (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg bg-popover border border-border shadow-[var(--elevation-2)] p-1 text-popover-foreground" role="menu">
                  {loadingOpenWithApps ? <span className="block px-2 py-1.5 text-xs text-muted-foreground">正在查找可打开的应用...</span> : null}
                  {!loadingOpenWithApps && !openWithApps?.length ? <span className="block px-2 py-1.5 text-xs text-muted-foreground">未找到匹配应用，可用默认应用打开</span> : null}
                  {(openWithApps ?? []).map((app) => (
                    <button key={`${app.name}-${app.path}`} type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground" onClick={() => void openCurrentFile(app.path)}>
                      {app.iconUrl ? <img className="size-4 rounded-sm object-contain shrink-0" src={app.iconUrl} alt="" loading="lazy" /> : <span className="size-4 rounded-sm bg-muted flex items-center justify-center text-[10px] font-medium shrink-0">{getAppGlyph(app.name)}</span>}
                      <span>{app.name}</span>
                    </button>
                  ))}
                  <div className="h-px bg-border my-1" />
                  <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground" onClick={() => void openCurrentFile()}>
                    <HugeiconsIcon icon={Folder02Icon} size={16} />
                    <span>默认应用打开</span>
                  </button>
                  <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground" onClick={() => void revealCurrentFile()}>
                    <HugeiconsIcon icon={Folder02Icon} size={16} />
                    <span>在文件夹中显示</span>
                  </button>
                  {runningInTauri ? (
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground" onClick={() => void pickLocalFile()}>
                      <HugeiconsIcon icon={Folder02Icon} size={16} />
                      <span>重新选择文件</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : currentSelection?.kind === "draft" ? (
            <button className="preview-open-button" type="button" disabled title="草稿文件当前仅支持右侧预览">
              <span>仅预览</span>
            </button>
          ) : (
            <button
              className="preview-open-button"
              type="button"
              onClick={() => void pickLocalFile()}
              disabled={!runningInTauri}
              title={runningInTauri ? "打开本地文件" : "仅 Tauri 桌面端支持系统文件选择器"}
            >
              <HugeiconsIcon icon={Folder02Icon} size={16} />
              <span>打开文件</span>
            </button>
          )}
          {currentSelection?.kind === "conversation" && currentSelection.attachmentId ? (
            <>
              <button
                className="preview-open-button"
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={promoting}
                aria-label="加入知识库"
                title="加入知识库"
              >
                <HugeiconsIcon icon={LibraryIcon} size={16} />
              </button>
              <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="加入知识库?"
                description={`将「${currentSelection.name}」加入知识库,之后它的内容可被检索到。`}
                confirmLabel="加入"
                onConfirm={() => void addCurrentToKnowledge()}
              />
            </>
          ) : null}
          {onMaximize ? (
            <button
              className="preview-open-button"
              type="button"
              onClick={onMaximize}
              aria-label={isMaximized ? "还原预览" : "放大预览"}
              title={isMaximized ? "还原" : "放大"}
            >
              <HugeiconsIcon icon={isMaximized ? ArrowShrink01Icon : ArrowExpand01Icon} size={16} />
            </button>
          ) : null}
          </div>
        </div>
      </div>

      {preview?.kind === "image" && preview.meta?.width && preview.meta?.height ? (
        <div className="preview-meta-row">
          <span>{preview.meta.width} × {preview.meta.height}</span>
        </div>
      ) : null}

      <div className="preview-page-body">
        {!currentSelection && !loading ? (
          <div className="preview-empty-state">
            <HugeiconsIcon icon={FileSearchIcon} size={22} />
            <strong>{emptyTitle}</strong>
            <p>{emptyDescription}</p>
          </div>
        ) : null}

        {loading ? <div className="preview-status">正在加载文件内容...</div> : null}
        {error ? <div className="preview-status error">{error}</div> : null}

        {!loading && !error && preview?.kind === "markdown" ? (
          <div className="md-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {preview.text}
            </ReactMarkdown>
          </div>
        ) : null}

        {!loading && !error && preview?.kind === "text" ? (
          <div className="preview-text-stage">
            <div className="preview-text-page">
              <pre className="preview-text-block">{preview.text}</pre>
            </div>
          </div>
        ) : null}

        {!loading && !error && preview?.kind === "image" ? (
          <div className="preview-image-stage">
            <img
              src={preview.src}
              alt={preview.meta.name}
              onLoad={(event) => {
                const target = event.currentTarget;
                setPreview((current) => {
                  if (!current || current.kind !== "image") return current;
                  return {
                    ...current,
                    meta: { ...current.meta, width: target.naturalWidth, height: target.naturalHeight }
                  };
                });
              }}
            />
          </div>
        ) : null}

        {!loading && !error && preview?.kind === "excel" ? (
          <div className="preview-excel" style={{ ["--preview-accent"]: previewAccent } as React.CSSProperties}>
            {/* 公式栏 (AC1) */}
            <div className="preview-excel-formula-bar" aria-label="公式栏">
              <span className="preview-excel-name-box" aria-label="单元格地址">{formulaBarLabel || "–"}</span>
              <span className="preview-excel-fx" aria-hidden>fx</span>
              <span className="preview-excel-formula-value" title={formulaBarValue}>{formulaBarValue || " "}</span>
            </div>
            <div className="preview-excel-stage">
              <div className="preview-excel-page">
                <div className="preview-excel-grid-scroll" ref={excelGridRef}>
                  <table className="preview-excel-grid">
                    <colgroup>
                      <col className="preview-excel-row-index-col" />
                      {(activeExcelSheet?.columnWidths ?? []).map((width, index) => (
                        <col key={`col-${index}`} style={{ width: `${width}px` }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="preview-excel-corner" />
                        {(activeExcelSheet?.columnHeaders ?? []).map((label, index) => (
                          <th
                            key={label}
                            className={`preview-excel-column-header${activeCellPos?.col === index ? " is-active" : ""}`}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(activeExcelSheet?.rows ?? []).map((row) => (
                        <tr
                          key={`${activeExcelSheet?.name ?? "sheet"}-${row.rowNumber}`}
                          data-rownum={row.rowNumber}
                          className={row.rowNumber === flashRow ? "preview-excel-row-flash" : undefined}
                        >
                          <th className={`preview-excel-row-header${activeCellPos?.row === row.rowNumber ? " is-active" : ""}`}>{row.rowNumber}</th>
                          {row.cells.map((cell) => {
                            // 构造内联样式:背景色 + 边框(AC4) + 字重 + 对齐 + 字色
                            const s = cell.style;
                            const inlineStyle: React.CSSProperties = {};
                            if (s?.backgroundColor) inlineStyle.backgroundColor = s.backgroundColor;
                            if (s?.borderTop) inlineStyle.borderTop = s.borderTop;
                            if (s?.borderRight) inlineStyle.borderRight = s.borderRight;
                            if (s?.borderBottom) inlineStyle.borderBottom = s.borderBottom;
                            if (s?.borderLeft) inlineStyle.borderLeft = s.borderLeft;
                            if (s?.fontWeight) inlineStyle.fontWeight = s.fontWeight;
                            if (s?.textAlign) inlineStyle.textAlign = s.textAlign as React.CSSProperties["textAlign"];
                            else if (cell.isNumeric) inlineStyle.textAlign = "right";
                            if (s?.color) inlineStyle.color = s.color;
                            if (cell.isNegative && !s?.color) inlineStyle.color = "var(--doc-negative, #c0392b)";

                            return (
                              <td
                                key={cell.key}
                                className={cell.key === focusCell?.label ? "preview-excel-cell is-selected" : "preview-excel-cell"}
                                colSpan={cell.colSpan}
                                rowSpan={cell.rowSpan}
                                data-column-index={cell.columnIndex}
                                data-numeric={cell.isNumeric ? "true" : undefined}
                                style={Object.keys(inlineStyle).length > 0 ? inlineStyle : undefined}
                                title={cell.value || undefined}
                                onClick={() => setFocusCell({
                                  label: cell.key,
                                  barValue: cell.formula ? "=" + cell.formula : cell.value
                                })}
                              >
                                <span>{cell.value || " "}</span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {activeExcelSheet && excelFillerRows > 0
                        ? Array.from({ length: excelFillerRows }, (_, i) => {
                            const lastNum = activeExcelSheet.rows.length
                              ? activeExcelSheet.rows[activeExcelSheet.rows.length - 1].rowNumber
                              : 0;
                            const rowNum = lastNum + i + 1;
                            return (
                              <tr key={`filler-${rowNum}`} className="preview-excel-filler-row">
                                <th className="preview-excel-row-header">{rowNum}</th>
                                {activeExcelSheet.columnHeaders.map((_, c) => (
                                  <td key={c} className="preview-excel-cell"><span /></td>
                                ))}
                              </tr>
                            );
                          })
                        : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            {/* 工作表标签:置于表格底部(Office 式) */}
            <div className="preview-excel-sheet-tabs" role="tablist" aria-label="工作表列表">
              {excelSheets.map((sheet, index) => (
                <button
                  key={sheet.name}
                  type="button"
                  className={index === activeSheet ? "active" : ""}
                  onClick={() => { setActiveSheet(index); setFocusCell(null); }}
                  role="tab"
                  aria-selected={index === activeSheet}
                >
                  {sheet.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {!loading && !error && preview?.kind === "docx" ? (
          <DocxPreviewWrapper data={preview.bytes} />
        ) : null}

        {!loading && !error && preview?.kind === "pdf" ? (
          <div className="preview-pdf">
            {pdfLoadError ? (
              <>
                <div className="preview-status warning">{pdfLoadError}</div>
                <div className="preview-pdf-native">
                  <iframe src={preview.src} title={preview.meta.name} className="preview-pdf-iframe" />
                </div>
              </>
            ) : !pdfComponents ? (
              <div className="preview-status">正在加载 PDF 阅读器...</div>
            ) : (
              <>
                <div className="preview-pdf-toolbar">
                  <button type="button" onClick={() => setPdfPage((page) => Math.max(1, page - 1))} disabled={pdfPage <= 1}>
                    <HugeiconsIcon icon={ArrowLeft01Icon} size={15} />
                  </button>
                  <span>第 {pdfPage} / {pdfPages || "?"} 页</span>
                  <button type="button" onClick={() => setPdfPage((page) => Math.min(pdfPages || page, page + 1))} disabled={pdfPages > 0 && pdfPage >= pdfPages}>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={15} />
                  </button>
                </div>
                <div className="preview-pdf-canvas">
                  <pdfComponents.Document file={preview.src} onLoadSuccess={(params: { numPages: number }) => setPdfPages(params.numPages)}>
                    <pdfComponents.Page pageNumber={pdfPage} width={720} renderAnnotationLayer={false} renderTextLayer={false} />
                  </pdfComponents.Document>
                </div>
              </>
            )}
          </div>
        ) : null}

        {!loading && !error && preview?.kind === "download" ? (
          <div className="preview-download-card">
            <span className="preview-download-name">{preview.meta.name}</span>
            <a
              href={preview.href}
              download={preview.meta.name}
              className="preview-download-btn"
            >
              下载查看
            </a>
          </div>
        ) : null}

        {!loading && !error && preview?.kind === "unsupported" ? (
          <div className="preview-status">{preview.reason}</div>
        ) : null}
      </div>
    </section>
  );
}

async function loadPreview(selection: PreviewFileSelection): Promise<LoadedPreview> {
  const extension = getExtension(selection.name);
  const mimeType = selection.mimeType || inferMimeType(selection.name);
  const meta: PreviewMeta = {
    name: selection.name,
    extension,
    mimeType,
    sizeBytes: selection.sizeBytes,
    sourceLabel: selection.kind === "local" ? "本地文件" : selection.kind === "draft" ? "草稿文件" : selection.kind === "knowledge" ? "知识库" : "对话文件"
  };

  if (extension === "md") {
    return { kind: "markdown", text: await loadText(selection), meta };
  }
  if (extension === "txt") {
    return { kind: "text", text: await loadText(selection), meta };
  }
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) {
    if (selection.kind === "conversation") {
      return { kind: "image", src: getConversationPreviewUrl(selection.conversationId, selection.storagePath), meta };
    }
    if (selection.kind === "knowledge") {
      return { kind: "image", src: getKnowledgeFileUrl(selection.documentId), meta };
    }
    if (selection.kind === "draft") {
      return { kind: "image", src: selection.dataUrl, meta };
    }
    const bytes = await loadBytes(selection);
    const src = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    return { kind: "image", src, meta: { ...meta, sizeBytes: meta.sizeBytes ?? bytes.byteLength } };
  }
  if (extension === "csv") {
    const bytes = await loadBytes(selection);
    const text = new TextDecoder("utf-8").decode(bytes);
    return {
      kind: "excel",
      workbook: { sheets: [buildCsvSheet(text)] },
      meta: { ...meta, sizeBytes: meta.sizeBytes ?? bytes.byteLength }
    };
  }
  if (extension === "xlsx") {
    const bytes = await loadBytes(selection);
    const wb = await loadExcelWorkbookResilient(bytes);
    return {
      kind: "excel",
      workbook: { sheets: wb.worksheets.filter(Boolean).map((ws) => buildExcelSheet(ws)) },
      meta: { ...meta, sizeBytes: meta.sizeBytes ?? bytes.byteLength }
    };
  }
  if (extension === "xls") {
    // 旧版二进制 .xls 不再用有漏洞的解析库;提示另存(与知识库入库一致)
    return { kind: "unsupported", meta, reason: "暂不支持预览旧版 .xls，请用 Excel/WPS 另存为 .xlsx 后再查看。" };
  }
  if (extension === "docx") {
    const bytes = await loadBytes(selection);
    return {
      kind: "docx",
      bytes,
      meta: { ...meta, sizeBytes: meta.sizeBytes ?? bytes.byteLength }
    };
  }
  if (extension === "pdf") {
    if (selection.kind === "conversation") {
      return { kind: "pdf", src: getConversationPreviewUrl(selection.conversationId, selection.storagePath), meta };
    }
    if (selection.kind === "knowledge") {
      return { kind: "pdf", src: getKnowledgeFileUrl(selection.documentId), meta };
    }
    if (selection.kind === "draft") {
      return { kind: "pdf", src: selection.dataUrl, meta };
    }
    const bytes = await loadBytes(selection);
    const src = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    return { kind: "pdf", src, meta: { ...meta, sizeBytes: meta.sizeBytes ?? bytes.byteLength } };
  }

  if (extension === "pptx" || extension === "ppt") {
    const href = selection.kind === "conversation"
      ? getConversationPreviewUrl(selection.conversationId, selection.storagePath)
      : selection.kind === "knowledge"
        ? getKnowledgeFileUrl(selection.documentId)
        : selection.kind === "draft"
          ? selection.dataUrl
          : "";
    return { kind: "download", href, meta };
  }

  return { kind: "unsupported", meta, reason: `暂不支持预览 ${extension || "该"} 格式。` };
}

async function loadText(selection: PreviewFileSelection) {
  if (selection.kind === "local") return readTextFile(selection.path);
  if (selection.kind === "draft") return selection.text ?? decodeDataUrlToText(selection.dataUrl);
  if (selection.kind === "knowledge") {
    const res = await fetch(getKnowledgeFileUrl(selection.documentId));
    if (!res.ok) throw new Error("读取文本文件失败");
    return res.text();
  }
  const response = await fetch(getConversationPreviewUrl(selection.conversationId, selection.storagePath));
  if (!response.ok) throw new Error("读取文本文件失败");
  return response.text();
}

async function loadBytes(selection: PreviewFileSelection) {
  if (selection.kind === "local") return readFile(selection.path);
  if (selection.kind === "draft") return decodeDataUrlToBytes(selection.dataUrl);
  if (selection.kind === "knowledge") {
    const res = await fetch(getKnowledgeFileUrl(selection.documentId));
    if (!res.ok) throw new Error("读取二进制文件失败");
    return new Uint8Array(await res.arrayBuffer());
  }
  const response = await fetch(getConversationPreviewUrl(selection.conversationId, selection.storagePath));
  if (!response.ok) throw new Error("读取二进制文件失败");
  return new Uint8Array(await response.arrayBuffer());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 解析 xlsx 工作簿,带容错。exceljs 读 openpyxl 生成的某些部件会抛错(数据本身没问题):
 * - "Excel 表格(Table)":value.tables 混入 undefined,set model 的 reduce 访问 .name 崩;
 * - "批注(comments)":t.comments[n.Target].comments 访问 undefined 崩。
 * 这些都只是单元格的附加层,剥掉不影响数据——故首次加载失败时,用 jszip 去掉这些部件再重试。
 */
async function loadExcelWorkbookResilient(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import("exceljs");
  try {
    const wb = new ExcelJSRuntime.Workbook();
    await wb.xlsx.load(toArrayBuffer(bytes));
    return wb;
  } catch {
    const sanitized = await sanitizeXlsxForPreview(bytes);
    const wb = new ExcelJSRuntime.Workbook();
    await wb.xlsx.load(sanitized);
    return wb;
  }
}

/** CSV 预览:无样式,按逗号/换行切分成单 sheet。 */
function buildCsvSheet(text: string): ExcelSheet {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  const grid = lines.map((l) => l.split(","));
  const colCount = grid.reduce((m, r) => Math.max(m, r.length), 1);
  const rows: ExcelSheetRow[] = grid.map((cols, r) => ({
    rowNumber: r + 1,
    cells: Array.from({ length: colCount }, (_, c) => ({
      key: `${toExcelColumnLabel(c)}${r + 1}`,
      columnIndex: c,
      value: cols[c] ?? "",
      colSpan: 1,
      rowSpan: 1
    }))
  }));
  const firstNonEmpty = grid.findIndex((r) => r.some((c) => c.trim()));
  return {
    name: "Sheet1",
    columnHeaders: Array.from({ length: colCount }, (_, i) => toExcelColumnLabel(i)),
    columnWidths: Array.from({ length: colCount }, () => 140),
    rows,
    focusCellLabel: "A1",
    focusCellValue: firstNonEmpty >= 0 ? (grid[firstNonEmpty].find((c) => c.trim()) ?? "") : ""
  };
}

/** 把 "C12" 解析为 0 基的行列下标。 */
function parseCellAddress(addr: string): { r: number; c: number } {
  const m = addr.match(/^([A-Z]+)(\d+)$/);
  if (!m) return { r: 0, c: 0 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: col - 1 };
}

/** "A24" → {row: 1基行号, col: 0基列号};非法地址返回 null。 */
function parseA1Address(addr: string): { row: number; col: number } | null {
  if (!/^[A-Z]+\d+$/.test(addr)) return null;
  const { r, c } = parseCellAddress(addr);
  return { row: r + 1, col: c };
}

function buildExcelSheet(ws: ExcelJS.Worksheet): ExcelSheet {
  const rowCount = Math.max(ws.rowCount, 1);
  const colCount = Math.max(ws.columnCount, 1);

  // 合并单元格:ws.model.merges 形如 ["A1:C1", ...]
  const merges = ((ws.model as { merges?: string[] }).merges ?? []) as string[];
  const mergeStarts = new Map<string, { colSpan: number; rowSpan: number }>();
  const covered = new Set<string>();
  for (const range of merges) {
    const [a, b] = range.split(":");
    const s = parseCellAddress(a);
    const e = parseCellAddress(b ?? a);
    mergeStarts.set(`${s.r}:${s.c}`, { colSpan: e.c - s.c + 1, rowSpan: e.r - s.r + 1 });
    for (let r = s.r; r <= e.r; r += 1) {
      for (let c = s.c; c <= e.c; c += 1) {
        if (r === s.r && c === s.c) continue;
        covered.add(`${r}:${c}`);
      }
    }
  }

  const rows: ExcelSheetRow[] = [];
  let focusCellLabel = "A1";
  let focusCellValue = "";
  let focusResolved = false;

  for (let r = 0; r < rowCount; r += 1) {
    const cells: ExcelCell[] = [];
    for (let c = 0; c < colCount; c += 1) {
      const key = `${r}:${c}`;
      if (covered.has(key)) continue;
      const cell = ws.getRow(r + 1).getCell(c + 1);
      const merge = mergeStarts.get(key) ?? { colSpan: 1, rowSpan: 1 };
      const address = `${toExcelColumnLabel(c)}${r + 1}`;

      // 提取公式(AC1)
      const formula = isFormulaValue(cell.value) ? (cell.value as { formula: string }).formula : undefined;

      // 提取原始数字结果用于 numFmt 格式化(AC2)
      const rawValue = isFormulaValue(cell.value) ? (cell.value as { result?: unknown }).result : cell.value;
      const numFmt = (cell.numFmt ?? "") as string;
      const fmtResult = typeof rawValue === "number"
        ? formatNumber(rawValue, numFmt)
        : null;
      const displayValue = fmtResult
        ? fmtResult.text
        : formatExcelCellValue(cell.value);

      // 对齐判定:文件有明确 horizontal 时优先;否则数字类型右对齐(AC3)
      const hAlign = (cell.alignment as { horizontal?: string } | undefined)?.horizontal;
      const fileAlignSet = hAlign && hAlign !== "general";
      const isNumeric = !fileAlignSet && (fmtResult?.isNumeric ?? isNumericFormat(numFmt));

      if (!focusResolved && displayValue.trim()) {
        focusCellLabel = address;
        focusCellValue = formula ? `=${formula}` : displayValue;
        focusResolved = true;
      }
      cells.push({
        key: address,
        columnIndex: c,
        value: displayValue,
        formula,
        colSpan: merge.colSpan,
        rowSpan: merge.rowSpan,
        style: extractCellStyle(cell),
        isNumeric,
        isNegative: fmtResult?.negative ?? false,
      });
    }
    rows.push({ rowNumber: r + 1, cells });
  }

  return {
    name: ws.name,
    columnHeaders: Array.from({ length: colCount }, (_, i) => toExcelColumnLabel(i)),
    columnWidths: buildExcelColumnWidths(ws, rowCount, colCount),
    rows,
    focusCellLabel,
    focusCellValue
  };
}

function buildExcelColumnWidths(ws: ExcelJS.Worksheet, rowCount: number, colCount: number): number[] {
  const result: number[] = [];
  for (let c = 0; c < colCount; c += 1) {
    const explicitChars = ws.getColumn(c + 1).width;
    const explicitWidth = typeof explicitChars === "number" ? explicitChars * 8 + 16 : 0;
    let contentWidth = 120;
    for (let r = 0; r < Math.min(rowCount, 100); r += 1) {
      const text = formatExcelCellValue(ws.getRow(r + 1).getCell(c + 1).value);
      if (!text) continue;
      const charWidth = /[一-鿿　-〿＀-￯]/.test(text) ? 14 : 11;
      const longestLine = text.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length * charWidth + 48), 0);
      contentWidth = Math.max(contentWidth, Math.min(560, longestLine));
    }
    result.push(Math.max(120, Math.min(600, explicitWidth || contentWidth)));
  }
  return result;
}

function isFormulaValue(value: unknown): value is { formula: string; result?: unknown } {
  return typeof value === "object" && value !== null && "formula" in value;
}

function formatExcelCellValue(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: Array<{ text?: string }>; formula?: string };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? "").join("");
    // 公式结果:可能是对象(如金蝶 Acct() 非 Excel 函数 → {error:'#NAME?'},或嵌套 richText)。
    // 决不 String(object)(会渲染成 "[object Object]"),对象一律优雅降级。
    if (v.result != null) {
      const r = v.result as { error?: string; richText?: Array<{ text?: string }>; text?: unknown };
      if (typeof v.result !== "object") return String(v.result);
      if (Array.isArray(r.richText)) return r.richText.map((t) => t.text ?? "").join("");
      if (r.text != null && typeof r.text !== "object") return String(r.text);
      return ""; // 错误/无法计算的公式结果 → 留空(红线4:不显垃圾近似)
    }
    if (v.text != null && typeof v.text !== "object") return String(v.text);
    return "";
  }
  return String(value);
}

// Office 默认主题色板(<color theme="N">);多数 xlsx(含金蝶模板)的表头/合计用主题色而非直接 ARGB。
const OFFICE_THEME_COLORS = [
  "FFFFFF", "000000", "E7E6E6", "44546A", "4472C4",
  "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47",
  "0563C1", "954F72",
];

/** OOXML tint:负=变暗(×(1+tint)),正=向白提亮(×(1-tint)+255×tint)。近似但视觉够用。 */
function applyTint(hex6: string, tint?: number): string {
  if (!tint) return hex6;
  const f = (x: number) => {
    const v = tint < 0 ? x * (1 + tint) : x * (1 - tint) + 255 * tint;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  const r = f(parseInt(hex6.slice(0, 2), 16));
  const g = f(parseInt(hex6.slice(2, 4), 16));
  const b = f(parseInt(hex6.slice(4, 6), 16));
  return [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

type ExcelColor = { argb?: string; theme?: number; tint?: number; indexed?: number };

/** 解析 exceljs 颜色:优先 ARGB,其次主题色+tint(忠实还原原表配色);indexed 暂不处理。 */
function resolveExcelColor(color?: ExcelColor): string | undefined {
  if (!color) return undefined;
  if (color.argb && color.argb.length === 8) return "#" + color.argb.slice(2);
  if (typeof color.theme === "number" && OFFICE_THEME_COLORS[color.theme]) {
    return "#" + applyTint(OFFICE_THEME_COLORS[color.theme], color.tint);
  }
  return undefined;
}

function extractCellStyle(cell: ExcelJS.Cell): ExcelCell["style"] {
  const result: NonNullable<ExcelCell["style"]> = {};

  // 背景色 (fill):支持 ARGB + 主题色(忠实还原原表底色)
  const fill = cell.fill as { type?: string; fgColor?: ExcelColor } | undefined;
  const bg = fill?.type === "pattern" ? resolveExcelColor(fill.fgColor) : undefined;
  if (bg && bg.toUpperCase() !== "#FFFFFF") result.backgroundColor = bg;

  // 边框:不渲染文件自带单元格边框——它颜色偏深、与默认网格线叠加会显得"描边"很粗;
  // 统一用 .preview-excel-cell 的浅细网格线,与表头区一致、干净。

  // 加粗 (AC4)
  if (cell.font?.bold) result.fontWeight = "600";

  // 文件自定义对齐
  const hAlign = (cell.alignment as { horizontal?: string } | undefined)?.horizontal;
  if (hAlign && hAlign !== "general") {
    result.textAlign = hAlign === "center" ? "center" : hAlign === "right" ? "right" : "left";
  }

  // 字体颜色:支持 ARGB + 主题色;纯黑当默认不写(走 CSS 默认色)
  const fontColor = resolveExcelColor((cell.font as { color?: ExcelColor } | undefined)?.color);
  if (fontColor && fontColor.toUpperCase() !== "#000000") {
    result.color = fontColor;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Excel 边框样式 → CSS border 字符串 */
function toExcelColumnLabel(index: number) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function decodeDataUrlToText(dataUrl: string) {
  const bytes = decodeDataUrlToBytes(dataUrl);
  return new TextDecoder().decode(bytes);
}

function decodeDataUrlToBytes(dataUrl: string) {
  const [, data = ""] = dataUrl.split(",", 2);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function getKnowledgeFileUrl(documentId: number): string {
  return `/api/knowledge/documents/${documentId}/file`;
}

function getExtension(name: string) {
  return name.toLowerCase().split(".").pop() ?? "";
}

// 文件类型强调色:与 file-type-icon.tsx 的图标配色一致(Excel 绿 / Word 蓝 / PDF 红 / PPT 橙 / md·txt 灰)。
const FILE_ACCENT_COLORS: Record<string, string> = {
  xls: "#43AE74", xlsx: "#43AE74", csv: "#43AE74",
  doc: "#5193DC", docx: "#5193DC",
  pdf: "#F06A66",
  ppt: "#EC7A4D", pptx: "#EC7A4D",
  md: "#728195", txt: "#828FA3",
};

/** 按文件名扩展名取强调色(选中/激活/跳转高亮用);未知类型回落主色。 */
function fileAccentColor(name: string): string {
  return FILE_ACCENT_COLORS[getExtension(name)] ?? "var(--primary)";
}

function getNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function inferMimeType(name: string) {
  const extension = getExtension(name);
  const mapping: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    webp: "image/webp",
    csv: "text/csv",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint"
  };
  return mapping[extension] ?? "application/octet-stream";
}

function ensurePromiseWithResolvers() {
  try {
    if (typeof (Promise as unknown as Record<string, unknown>).withResolvers === "function") return;
    Object.defineProperty(Promise, "withResolvers", {
      value: function withResolvers<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      },
      writable: true,
      configurable: true,
    });
  } catch {
    // Polyfill not needed or not possible — continue without it
  }
}

function getAppGlyph(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("code")) return "C";
  if (lower.includes("excel") || lower.includes("numbers")) return "X";
  if (lower.includes("word")) return "W";
  if (lower.includes("powerpoint")) return "P";
  if (lower.includes("terminal")) return ">";
  if (lower.includes("finder") || lower.includes("default")) return "D";
  return name.slice(0, 1).toUpperCase();
}

function getConversationPreviewUrl(conversationId: number, storagePath: string) {
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  return `/api/files/${conversationId}/${encoded}`;
}

async function openConversationSelection(selection: ConversationPreviewFile, appPath?: string) {
  const fileUrl = getConversationPreviewUrl(selection.conversationId, selection.storagePath);
  try {
    const appQuery = appPath !== undefined ? `&app=${encodeURIComponent(appPath)}` : "";
    const response = await fetch(`${fileUrl}?action=open${appQuery}`);
    if (!response.ok) throw new Error("open failed");
  } catch {
    window.open(fileUrl, "_blank");
  }
}

async function revealConversationSelection(selection: ConversationPreviewFile) {
  const fileUrl = getConversationPreviewUrl(selection.conversationId, selection.storagePath);
  try {
    const response = await fetch(`${fileUrl}?action=reveal`);
    if (!response.ok) throw new Error("reveal failed");
  } catch {
    window.open(fileUrl, "_blank");
  }
}

function getParentPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
