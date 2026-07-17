"use client";

/**
 * 角色工作台「工作」页签 — 任务流水 + 右侧三态预览（B2/B3）。
 *
 * 见 docs/spec/design-agents-ia.md 三·五节：
 *   - 左列 = 任务流水（等你拍板 → 进行中 → 已交付，疑点在前），行可选中。
 *   - 右列 = ResizablePreviewPanel 三态：待拍板→疑点/去处理；进行中→动态+查看会话；
 *     已交付→文件产物内嵌 FilePreviewPage。均标注来源会话可跳回。
 *   - usePreviewResize(460)、列表 min-w-[420px]、?task=<id> 深链、默认选中首条并展开、
 *     收起后顶栏「展开预览」图标按钮。
 *   - 操作一律 hugeicon + hover 提示（TipButton）。
 */

import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  BubbleChatIcon,
  CheckmarkCircle02Icon,
  FileSearchIcon,
  PanelRightIcon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ResizablePreviewPanel } from "@/app/shared/resizable-preview-panel";
import { usePreviewResize } from "@/app/shared/use-preview-resize";
import { FilePreviewPage, type LocalPreviewFile } from "@/app/shared/file-preview-page";
import { relativeTime } from "@/lib/utils/relative-time";
import type { DispatchRow } from "@/lib/db/dispatch-store";

type TaskGroupKey = "pending" | "running" | "failed" | "done";
const TASK_GROUPS: { key: TaskGroupKey; label: string }[] = [
  { key: "pending", label: "等你拍板" },
  { key: "running", label: "进行中" },
  { key: "failed", label: "失败" },
  { key: "done", label: "已交付" },
];

function isPending(row: DispatchRow) {
  return (row.blockedReason != null && row.blockedReason !== "") || row.reviewStatus === "pending";
}
function groupOf(row: DispatchRow): TaskGroupKey {
  if (isPending(row)) return "pending";
  if (row.status === "running") return "running";
  if (row.status === "failed") return "failed";
  return "done";
}
function fileList(row: DispatchRow): string[] {
  if (row.files && row.files.length > 0) return row.files;
  if (row.label && /\.(xlsx|pdf|docx|csv|txt|md)$/i.test(row.label)) return [row.label];
  return [];
}

/** 图标按钮 + hover 提示。href 存在则包一层 Link（如跳会话）。 */
function TipButton({
  icon,
  label,
  onClick,
  href,
  primary,
}: {
  icon: typeof ArrowRight01Icon;
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
}) {
  const btn = (
    <Button variant={primary ? "default" : "ghost"} size="icon" onClick={onClick} aria-label={label}>
      <HugeiconsIcon icon={icon} size={16} />
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{href ? <Link href={href}>{btn}</Link> : btn}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceWorkTab({ roleId }: { roleId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskParam = searchParams.get("task");

  const [dispatches, setDispatches] = useState<DispatchRow[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const initializedRef = useRef(false);
  // 请求令牌：切角色时递增，过期响应到达时丢弃——避免快速切角色时旧请求覆盖新角色的数据。
  const requestTokenRef = useRef(0);

  const { collapsed, previewW, dragging, maximized, mainRef, beginResize, open, toggle, maximize, resetWidth } =
    usePreviewResize(460);

  const fetchDispatches = useCallback(async () => {
    const token = ++requestTokenRef.current;
    setError(false);
    setDispatches(null);
    try {
      const res = await fetch(`/api/agents/dispatches?roleId=${encodeURIComponent(roleId)}&limit=30`);
      const json = await res.json();
      if (token !== requestTokenRef.current) return;
      if (json.ok) setDispatches(json.data.rows);
      else { setError(true); setDispatches([]); }
    } catch {
      if (token !== requestTokenRef.current) return;
      setError(true); setDispatches([]);
    }
  }, [roleId]);

  // roleId 变化：重置初始化态与选中项，避免切角色时残留上一角色的选中/展开态。
  useEffect(() => {
    initializedRef.current = false;
    setSelectedId(null);
  }, [roleId]);

  useEffect(() => { void fetchDispatches(); }, [fetchDispatches]);

  // 排序后的分组流水（疑点在前）
  const grouped = useMemo(() => {
    const out: { key: TaskGroupKey; label: string; rows: DispatchRow[] }[] = [];
    if (!dispatches) return out;
    for (const g of TASK_GROUPS) {
      const rows = dispatches.filter((d) => groupOf(d) === g.key);
      if (rows.length) out.push({ ...g, rows });
    }
    return out;
  }, [dispatches]);

  const orderedIds = useMemo(() => grouped.flatMap((g) => g.rows.map((r) => r.id)), [grouped]);

  // 首次加载：?task 命中则选它，否则选首条（疑点在前），并展开预览。
  useEffect(() => {
    if (initializedRef.current || dispatches == null || orderedIds.length === 0) return;
    initializedRef.current = true;
    const fromUrl = taskParam ? Number(taskParam) : NaN;
    const initial = orderedIds.includes(fromUrl) ? fromUrl : orderedIds[0];
    setSelectedId(initial);
    open();
  }, [dispatches, orderedIds, taskParam, open]);

  const selectTask = useCallback(
    (id: number) => {
      setSelectedId(id);
      open();
      // ?task 深链（replace 不刷历史）
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("task", String(id));
      router.replace(`/agents/${roleId}?${sp.toString()}`, { scroll: false });
    },
    [open, router, roleId, searchParams]
  );

  const selected = dispatches?.find((d) => d.id === selectedId) ?? null;

  // ── 左列：任务流水 ──────────────────────────────────────────────────────
  const list: ReactNode = (
    <div className="flex flex-col h-full min-h-0">
      {collapsed && selectedId != null && (
        <div className="flex items-center justify-end px-page pt-2 shrink-0">
          <TipButton icon={PanelRightIcon} label="展开预览" onClick={open} />
        </div>
      )}
      <div className="flex-1 overflow-auto p-page">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-12 text-body text-muted-foreground">
            <p>任务记录加载失败</p>
            <Button variant="outline" size="sm" onClick={fetchDispatches}>重试</Button>
          </div>
        ) : dispatches == null ? (
          <div className="py-12 text-center text-body text-muted-foreground">加载中…</div>
        ) : dispatches.length === 0 ? (
          <div className="py-12 text-center text-body text-muted-foreground">本月还没有任务。点右上角「派任务」发起</div>
        ) : (
          <div className="flex flex-col gap-6 max-w-3xl">
            {grouped.map((g) => (
              <section key={g.key} className="flex flex-col gap-1.5">
                <h2 className="text-meta font-semibold text-muted-foreground">{g.label} · {g.rows.length}</h2>
                {g.rows.map((row) => (
                  <TaskRow key={row.id} row={row} selected={row.id === selectedId} onSelect={() => selectTask(row.id)} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // ── 右列：三态预览 ──────────────────────────────────────────────────────
  const preview: ReactNode = !collapsed && selected ? (
    <TaskPreview
      key={selected.id}
      row={selected}
      maximized={maximized}
      onMaximize={maximize}
      onCollapse={toggle}
    />
  ) : null;

  return (
    <ResizablePreviewPanel
      mainRef={mainRef}
      previewW={previewW}
      maximized={maximized}
      collapsed={collapsed}
      dragging={dragging}
      onBeginResize={beginResize}
      onResetWidth={resetWidth}
      listMinWidthClass="min-w-[420px]"
      list={list}
      preview={preview}
    />
  );
}

function TaskRow({ row, selected, onSelect }: { row: DispatchRow; selected: boolean; onSelect: () => void }) {
  const pending = isPending(row);
  const running = row.status === "running" && !pending;
  const failed = row.status === "failed" && !pending;
  const tone = pending ? "var(--tone-notice)" : running ? "var(--tone-analysis)" : failed ? "var(--tone-alarm)" : "var(--tone-ok)";
  const tag = pending ? "等你拍板" : running ? "进行中" : failed ? "失败" : "已交付";
  return (
    <button type="button" onClick={onSelect} className="text-left w-full">
      <Surface
        level="page"
        edge="hairline"
        shape="control"
        className={
          "flex items-center gap-2 px-3 py-2 transition-colors " +
          (selected ? "bg-accent/60 ring-1 ring-primary" : "hover:bg-accent/40")
        }
      >
        <span className="fa-tone-pill text-meta shrink-0" style={{ "--tone": tone } as CSSProperties}>{tag}</span>
        <span className="flex-1 min-w-0 truncate text-body">{row.label ?? row.summary ?? `#${row.id}`}</span>
        {row.period && (
          <span className="shrink-0 text-meta text-muted-foreground bg-muted/60 rounded-[var(--radius)] px-1">{row.period}</span>
        )}
        <span className="shrink-0 text-meta text-muted-foreground whitespace-nowrap tabular-nums">{relativeTime(row.startedAt)}</span>
      </Surface>
    </button>
  );
}

function TaskPreview({
  row,
  maximized,
  onMaximize,
  onCollapse,
}: {
  row: DispatchRow;
  maximized: boolean;
  onMaximize: () => void;
  onCollapse: () => void;
}) {
  const [filePreview, setFilePreview] = useState<LocalPreviewFile | null>(null);
  const [locking, setLocking] = useState(false);
  const [locked, setLocked] = useState(false);

  const pending = isPending(row);
  const running = row.status === "running" && !pending;
  const failed = row.status === "failed" && !pending;
  const files = fileList(row);
  const convHref = row.conversationId ? `/chat/recent?id=${row.conversationId}` : undefined;

  const handleLock = useCallback(async () => {
    setLocking(true);
    try {
      const res = await fetch(`/api/agents/dispatches/${row.id}/lock`, { method: "POST" });
      if (res.ok) { setLocked(true); toast.success("已确认，任务已锁定"); }
      else toast.error("锁定失败，请检查网络后重试");
    } catch {
      toast.error("锁定失败，请检查网络后重试");
    } finally {
      setLocking(false);
    }
  }, [row.id]);

  const title = row.label ?? row.summary ?? `#${row.id}`;

  return (
    <Surface level="card" edge="none" shape="none" className="flex flex-col overflow-hidden h-full">
      {/* 预览头：标题 + 来源会话 + 放大/收起 */}
      <div className="flex items-center gap-2 px-4 pt-px pb-1.5 border-b border-border shrink-0">
        <span className="flex-1 min-w-0 truncate text-body font-semibold">{title}</span>
        <TipButton icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} label={maximized ? "还原" : "放大"} onClick={onMaximize} />
        {!maximized && <TipButton icon={PanelRightIcon} label="收起预览" onClick={onCollapse} />}
      </div>

      {filePreview ? (
        <div className="flex-1 overflow-hidden">
          <FilePreviewPage
            selection={filePreview}
            onSelectionChange={(s) => { if (!s) setFilePreview(null); }}
            docked
            isMaximized={maximized}
            onMaximize={onMaximize}
            onCollapse={() => setFilePreview(null)}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          {convHref && (
            <div className="text-meta text-muted-foreground">
              来源会话：
              <Link href={convHref} className="text-primary hover:underline">{title}</Link>
            </div>
          )}

          {/* 待拍板：疑点/停在确认门 + 去处理 + 确认 */}
          {pending && (
            <section
              className="fa-toned rounded-[var(--radius)] px-3 py-2.5 flex flex-col gap-2"
              style={{ "--tone": "var(--tone-notice)", borderLeft: "2px solid var(--tone-notice)" } as CSSProperties}
            >
              <p className="text-meta font-semibold" style={{ color: "var(--tone-notice)" }}>
                {row.blockedReason ? "停在确认门" : "等待复核确认"}
              </p>
              <p className="text-body">{row.blockedReason || row.summary || "该任务已完成，等你确认后归档。"}</p>
              <div className="flex items-center gap-1 pt-1">
                {convHref && <TipButton icon={ArrowRight01Icon} label="去处理（回对话拍板）" href={convHref} primary />}
                {row.reviewStatus === "pending" && !locked && (
                  <TipButton icon={CheckmarkCircle02Icon} label={locking ? "确认中…" : "确认通过"} onClick={handleLock} />
                )}
                {(locked || row.reviewStatus === "locked") && (
                  <span className="fa-tone-pill text-meta" style={{ "--tone": "var(--tone-ok)" } as CSSProperties}>已确认</span>
                )}
              </div>
              <p className="text-meta text-muted-foreground">拍板动作在对话里完成，这里只做入口与预览。</p>
            </section>
          )}

          {/* 进行中：动态 + 查看会话 */}
          {running && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="fa-tone-dot fa-dot-pulse shrink-0" style={{ "--tone": "var(--tone-analysis)" } as CSSProperties} />
                <span className="text-body">正在执行</span>
                {convHref && <span className="ml-auto"><TipButton icon={BubbleChatIcon} label="查看会话" href={convHref} /></span>}
              </div>
              {row.summary && <p className="text-meta text-muted-foreground">{row.summary.split("\n")[0]}</p>}
            </section>
          )}

          {/* 失败：摘要 + 查看会话（不写「已完成」） */}
          {failed && (
            <section
              className="fa-toned rounded-[var(--radius)] px-3 py-2.5 flex flex-col gap-2"
              style={{ "--tone": "var(--tone-alarm)", borderLeft: "2px solid var(--tone-alarm)" } as CSSProperties}
            >
              <p className="text-meta font-semibold" style={{ color: "var(--tone-alarm)" }}>任务失败</p>
              <p className="text-body">{row.summary || "执行失败，未生成产物。"}</p>
              {convHref && (
                <div className="pt-1">
                  <TipButton icon={BubbleChatIcon} label="查看会话" href={convHref} />
                </div>
              )}
            </section>
          )}

          {/* 文件产物（已交付常见；任何态有文件都展示） */}
          {files.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <p className="text-meta font-semibold text-muted-foreground">文件产物</p>
              {files.map((path) => {
                const name = path.split("/").pop() ?? path;
                return (
                  <Surface
                    key={path}
                    level="page"
                    edge="hairline"
                    shape="control"
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <span className="flex-1 min-w-0 truncate text-body">{name}</span>
                    <TipButton
                      icon={FileSearchIcon}
                      label="打开预览"
                      onClick={() => setFilePreview({ kind: "local", path, name })}
                    />
                  </Surface>
                );
              })}
            </section>
          )}

          {/* 已交付且无文件：摘要 + 查看会话 */}
          {!pending && !running && !failed && files.length === 0 && (
            <section className="flex flex-col gap-2">
              <p className="text-body">{row.summary || "已完成。"}</p>
              {convHref && <div><TipButton icon={BubbleChatIcon} label="查看会话" href={convHref} /></div>}
            </section>
          )}
        </div>
      )}
    </Surface>
  );
}
