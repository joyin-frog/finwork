"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { trackFeature } from "@/lib/telemetry/track";
import { motion } from "motion/react";
import { useNavState } from "@/app/shared/nav-state";
import { useChatStream } from "@/app/shared/chat-stream";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import { DragHandle } from "@/app/shared/window-controls";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import { useIsMac } from "@/app/shared/use-is-mac";
import { formatShortcut } from "@/app/shared/shortcuts";
import { SPRING_DEFAULT } from "@/app/shared/motion-presets";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  DashboardSquare02Icon,
  LibraryIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  Edit02Icon,
  PinIcon,
  PinOffIcon,
  ChatAddIcon,
  Settings02Icon,
  Delete02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";

type ConversationSummary = {
  id: number;
  title: string;
  updatedAt: string;
  pinned: boolean;
};

type NavActive = "cockpit" | "chat" | "knowledge" | "config" | "files";
type ChatActive = "new" | "recent";

/** 长条菜单项专用:hover 行时右侧纯文字显示快捷键(只读提示,不是按钮——无盒子/边框)。 */
function NavShortcut({ combo }: { combo: string }) {
  const isMac = useIsMac();
  return (
    <span className="ml-auto shrink-0 text-meta text-muted-foreground tabular-nums opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      {formatShortcut(combo, isMac)}
    </span>
  );
}

export function AppNav({ active, chatActive }: { active: NavActive; chatActive?: ChatActive }) {
  const searchParams = useSearchParams();
  const {
    collapsed, setCollapsed,
    setSearchOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    conversations, hasMore, loaded, fetchConversations,
    deleteTarget,
    renamingId, renameDraft, setRenameDraft,
    doPin, startRename, cancelRename, commitRename,
    startDelete, confirmDelete, cancelDelete,
  } = useNavState();
  const { statusByConversationId } = useChatStream();

  const renameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const activeConversationId = (() => {
    if (chatActive !== "recent") return null;
    const rawId = searchParams.get("id");
    return rawId ? Number(rawId) : null;
  })();

  useEffect(() => {
    if (renamingId !== null) {
      requestAnimationFrame(() => renameInputRef.current?.focus());
    }
  }, [renamingId]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      fetchConversations(conversations.length);
    }
  }, [hasMore, conversations.length, fetchConversations]);

  const pinnedConversations = conversations.filter((c) => c.pinned);
  const recentConversations = conversations.filter((c) => !c.pinned);

  const navLinkClass = (isActive: boolean) =>
    cn(
      "flex items-center gap-2 px-3 min-h-[36px] rounded-md text-body transition-all duration-150",
      isActive
        ? "bg-primary/10 text-primary font-medium"
        : "text-foreground hover:bg-accent hover:text-accent-foreground"
    );

  function renderConversationRow(c: ConversationSummary) {
    const isActive = activeConversationId === c.id;
    // 状态点:仅在"非当前查看"的会话上显示(点是离开后的提醒);统一走 --tone-* token:
    // 进行中=主色(呼吸,与对话内运行指示同色)、完成=ok 绿、未正常完成=alarm 红。
    const status = isActive ? undefined : statusByConversationId[c.id];
    const dot = status === "streaming"
      ? { tone: "var(--primary)", pulse: true, label: "正在生成" }
      : status === "done"
        ? { tone: "var(--tone-ok)", pulse: false, label: "已完成，点击查看" }
        : status === "error" || status === "stopped"
          ? { tone: "var(--tone-alarm)", pulse: false, label: "未正常完成，点击查看" }
          : null;
    return (
      <div
        key={c.id}
        className={cn(
          // 底色/边框作用在整行:标题 + 编辑按钮共用同一底,选中/悬停时是一个整体。
          "group relative flex items-center rounded-md transition-colors",
          renamingId === c.id
            ? ""
            : isActive
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
      >
        {dot && renamingId !== c.id && (
          <span
            className={cn("pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 size-1.5 rounded-full", dot.pulse && "animate-pulse")}
            style={{ backgroundColor: dot.tone }}
            title={dot.label}
            aria-label={dot.label}
            role="status"
          />
        )}
        {renamingId === c.id ? (
          <input
            ref={renameInputRef}
            className="flex-1 mx-2 px-2 py-1 text-body bg-background border border-border rounded-md outline-none focus:ring-1 focus:ring-ring"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(c);
              if (e.key === "Escape") cancelRename();
            }}
            onBlur={() => commitRename(c)}
          />
        ) : (
          <Link
            href={`/chat/recent?id=${c.id}`}
            title={c.title}
            className="flex-1 min-w-0 pl-4 pr-3 py-1.5 text-small truncate"
          >
            {c.title}
          </Link>
        )}
        {renamingId !== c.id && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${c.title} 更多操作`}
              // 共用整行底色;悬停到按钮本身时再叠一层略深的底,单独高亮。
              className="opacity-0 group-hover:opacity-100 mr-1 p-1 rounded text-muted-foreground transition hover:bg-foreground/10"
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuItem onClick={() => doPin(c)}>
              {c.pinned ? <HugeiconsIcon icon={PinOffIcon} size={13} /> : <HugeiconsIcon icon={PinIcon} size={13} />}
              {c.pinned ? "取消置顶" : "置顶"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startRename(c)}>
              <HugeiconsIcon icon={Edit02Icon} size={13} />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => startDelete(c)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={13} />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
    );
  }

  return (
    <motion.aside
      className="flex flex-col h-full bg-sidebar overflow-hidden shrink-0"
      animate={{ width: collapsed ? 0 : 240 }}
      transition={SPRING_DEFAULT}
    >
      {/* 顶栏:左侧为 macOS 红绿灯预留(DragHandle 拖拽区);右侧放收起按钮(展开态才在侧栏里)。 */}
      <div className="relative h-11 shrink-0 flex items-center justify-end pr-2">
        <DragHandle />
        <ShortcutHint label="搜索" combo="mod+g" side="right">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="搜索"
            className="relative size-8 inline-flex items-center justify-center rounded-lg text-foreground/60 cursor-pointer transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Search01Icon} size={16} />
          </button>
        </ShortcutHint>
        <ShortcutHint label="收起菜单" combo="mod+b" side="right">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="收起菜单"
            className="relative size-8 inline-flex items-center justify-center rounded-lg text-foreground/60 cursor-pointer transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={PanelLeftIcon} size={16} />
          </button>
        </ShortcutHint>
      </div>

      {!collapsed && (
        <>
          <div className="flex flex-col gap-1 px-2 pb-4 shrink-0">
            <Link href="/chat/new" onClick={() => trackFeature("nav.chat")} className={cn(navLinkClass(active === "chat" && chatActive === "new"), "group")}>
              <HugeiconsIcon icon={ChatAddIcon} size={16} />
              <span>新对话</span>
              <NavShortcut combo="mod+n" />
            </Link>
            <Link href="/cockpit" onClick={() => trackFeature("nav.cockpit")} className={navLinkClass(active === "cockpit")}>
              <HugeiconsIcon icon={DashboardSquare02Icon} size={16} />
              <span>总览</span>
            </Link>
            <Link href="/files" onClick={() => trackFeature("nav.knowledge")} className={navLinkClass(active === "files" || active === "knowledge")}>
              <HugeiconsIcon icon={LibraryIcon} size={16} />
              <span>资料</span>
            </Link>
          </div>

          <nav
            ref={listRef as React.RefObject<HTMLElement>}
            aria-label="主导航"
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-2 flex flex-col gap-4"
          >
            {pinnedConversations.length > 0 && (
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setPinnedOpen(!pinnedOpen)}
                  className="flex items-center justify-between px-3 py-1 text-meta font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>置顶</span>
                  <HugeiconsIcon icon={ArrowDown01Icon} size={12} className={cn("transition-transform", pinnedOpen && "rotate-180")} />
                </button>
                {pinnedOpen && (
                  <div className="flex flex-col gap-1">
                    {pinnedConversations.map(renderConversationRow)}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setRecentOpen(!recentOpen)}
                className="flex items-center justify-between px-3 py-1 text-meta font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>最近</span>
                <HugeiconsIcon icon={ArrowDown01Icon} size={12} className={cn("transition-transform", recentOpen && "rotate-180")} />
              </button>
              {recentOpen && (
                <div className="flex flex-col gap-1">
                  {recentConversations.length === 0 && loaded ? (
                    <span className="px-3 py-2 text-meta text-muted-foreground">暂无对话</span>
                  ) : (
                    recentConversations.map(renderConversationRow)
                  )}
                </div>
              )}
            </div>
          </nav>

          <div className="flex items-center gap-1 px-2 py-2 shrink-0">
            <Link href="/config" onClick={() => trackFeature("nav.config")} className={cn(navLinkClass(active === "config"), "flex-1 group")}>
              <HugeiconsIcon icon={Settings02Icon} size={16} />
              <span>设置</span>
              <NavShortcut combo="mod+," />
            </Link>

          </div>
        </>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) cancelDelete(); }}
        title="删除对话"
        description={deleteTarget ? <>确定要删除「{deleteTarget.title}」吗？对话和文件都会被永久删除</> : undefined}
        confirmLabel="确认"
        destructive
        onConfirm={confirmDelete}
      />
    </motion.aside>
  );
}
