"use client";

import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { trackFeature } from "@/lib/telemetry/track";
import {
  useNavState,
  conversationDeleteDestination,
  conversationIdFromRoute,
  DEFAULT_NAV_WIDTH,
  MIN_NAV_WIDTH,
  MAX_NAV_WIDTH,
} from "@/app/shared/nav-state";
import { useChatStream } from "@/app/shared/chat-stream";
import { ConfirmDialog } from "@/app/shared/confirm-dialog";
import { DragHandle } from "@/app/shared/window-controls";
import { NavTopControls } from "@/app/shared/nav-top-controls";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import { useIsMac } from "@/app/shared/use-is-mac";
import { useUserIdentity } from "@/app/shared/user-identity";
import { UserAvatar } from "@/app/shared/user-avatar";
import { formatShortcut } from "@/app/shared/shortcuts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { VerticalResizeDivider } from "@/app/shared/vertical-resize-divider";
import { ROLE_LABELS, ROLE_UI } from "@/lib/domain/role-ui";
import {
  ConversationStatusMark,
  resolveConversationStatus,
} from "@/app/shared/conversation-status-mark";
import { surfaceVariants } from "@/components/ui/surface";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  DashboardSquare02Icon,
  LibraryIcon,
  MoreVerticalIcon,
  Edit02Icon,
  PinIcon,
  PinOffIcon,
  ChatAddIcon,
  Settings02Icon,
  Delete02Icon,
  NoteIcon,
  User02Icon,
} from "@hugeicons/core-free-icons";

type ConversationSummary = {
  id: number;
  title: string;
  updatedAt: string;
  pinned: boolean;
  /** 专员会话的角色 id（E 刀）；null/缺省 = 主管会话。 */
  roleId?: string | null;
  /** 最新 trace 为 error 时 true；侧栏警告标（与「最近工作」同源）。 */
  hasError?: boolean;
};

type NavActive = "cockpit" | "chat" | "knowledge" | "config" | "agents" | "skills";
type ChatActive = "new" | "recent";

function NavActivePill({ reduce }: { reduce: boolean | null }) {
  return (
    <motion.span
      layoutId="nav-active-pill"
      initial={false}
      transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.5, bounce: 0.2 }}
      className="pointer-events-none absolute inset-0 z-[-1] rounded-md bg-primary/10"
    />
  );
}

function CollapsibleSectionMotion({
  open,
  reduce,
  children,
}: {
  open: boolean;
  reduce: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={reduce ? false : { opacity: 0, transform: "translateY(-4px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          exit={reduce ? undefined : { opacity: 0, transform: "translateY(-4px)" }}
          transition={{ duration: reduce ? 0 : 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="flex flex-col gap-0"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 侧栏可折叠分组标题：箭头贴标题，默认隐藏，hover / 键盘焦点时再显示。 */
function SectionFoldHeader({
  label,
  open,
  onToggle,
  trailing,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group/fold flex min-h-[30px] w-full items-center gap-1 pl-2 pr-2 text-meta font-normal text-muted-foreground transition-colors hover:text-foreground"
    >
      <span>{label}</span>
      <HugeiconsIcon
        icon={open ? ArrowDown01Icon : ArrowRight01Icon}
        size={12}
        className={cn(
          open ? "opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100" : "opacity-100",
          "transition-opacity motion-reduce:transition-none"
        )}
      />
      {trailing ? <span className="ml-auto flex items-center gap-1.5">{trailing}</span> : null}
    </button>
  );
}

/** 宽度由 navWidth(来自 NavStateProvider)驱动;useEffect 同步写回 --nav-width token,标签条 lead 自动跟随 */

/** 长条菜单项专用:hover 行时右侧纯文字显示快捷键(只读提示,不是按钮——无盒子/边框)。 */
function NavShortcut({ combo }: { combo: string }) {
  const isMac = useIsMac();
  // 挂载前不渲染文本:SSR 与水合首帧同为空,规避 isMac 在 Suspense 边界
  // 水合前翻转导致的文本不匹配(该 span 仅 hover 可见,空一帧无感知)。
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return (
    <span className="ml-auto shrink-0 text-meta text-muted-foreground tabular-nums opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      {mounted ? formatShortcut(combo, isMac) : null}
    </span>
  );
}

export function AppNav({ active, chatActive }: { active: NavActive; chatActive?: ChatActive }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    collapsed, setCollapsed,
    navWidth, setNavWidth,
    agentsOpen, setAgentsOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    agentRoster, agentPendingCount,
    conversations, hasMore, loaded, loadError, fetchConversations,
    deleteTarget,
    renamingId, renameDraft, setRenameDraft,
    doPin, startRename, cancelRename, commitRename,
    startDelete, confirmDelete, cancelDelete,
  } = useNavState();
  const [dragging, setDragging] = useState(false);
  const reduce = useReducedMotion();
  const pathname = usePathname();
  const currentRoleId = pathname.startsWith("/agents/")
    ? pathname.slice("/agents/".length).split("/")[0]
    : null;

  // Keep --nav-width token in sync with runtime navWidth so the tabbar lead tracks it.
  useEffect(() => {
    document.documentElement.style.setProperty("--nav-width", navWidth + "px");
  }, [navWidth]);
  const { statusByConversationId } = useChatStream();
  const { name: userName, avatar: userAvatar } = useUserIdentity();

  const renameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  // 「最近」默认策略：有置顶时收起，无置顶时展开。只在置顶有无变化时套用，不覆盖用户手势。
  const pinnedPresenceRef = useRef<boolean | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });

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

  useEffect(() => {
    if (!loaded) return;
    const hasPinnedNow = conversations.some((c) => c.pinned);
    if (pinnedPresenceRef.current === hasPinnedNow) return;
    pinnedPresenceRef.current = hasPinnedNow;
    setRecentOpen(!hasPinnedNow);
  }, [loaded, conversations, setRecentOpen]);

  const updateScrollEdges = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setScrollEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  const handleScroll = useCallback(() => {
    updateScrollEdges();
    const el = listRef.current;
    if (!el || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      fetchConversations(conversations.length);
    }
  }, [hasMore, conversations.length, fetchConversations, updateScrollEdges]);

  const pinnedConversations = conversations.filter((c) => c.pinned);
  const recentConversations = conversations.filter((c) => !c.pinned);
  const hasPinned = pinnedConversations.length > 0;

  // 内容高度变化后重算上下边缘渐隐（折叠开合、花名册加载等）。
  useEffect(() => {
    updateScrollEdges();
  }, [agentRoster.length, conversations.length, agentsOpen, pinnedOpen, recentOpen, hasPinned, updateScrollEdges]);

  async function handleConfirmDelete() {
    const result = await confirmDelete();
    if (!result) return;
    const currentConversationId = conversationIdFromRoute(window.location.pathname, window.location.search);
    const destination = conversationDeleteDestination(result, currentConversationId);
    if (destination) router.push(destination);
  }

  const navLinkClass = (isActive: boolean) =>
    cn(
      // pl-2 = gap-2：图标距左缘 = 图标距标题；20px 槽 + gap-2 = 28px 图形列。
      "relative isolate flex items-center gap-2 pl-2 pr-3 min-h-[30px] rounded-md text-body text-sidebar-foreground transition-[color,background-color,transform] duration-150 motion-safe:active:scale-[0.98]",
      isActive
        ? "text-foreground font-medium"
        : "hover:bg-foreground/10 hover:text-foreground"
    );

  function NavGlyph({ icon }: { icon: typeof ChatAddIcon }) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center">
        <HugeiconsIcon icon={icon} size={14} aria-hidden="true" />
      </span>
    );
  }

  function renderRoleRow(r: { roleId: string; name: string; available: boolean; userDisabled: boolean; status: string | null; blockedReason: string | null; reviewPending: boolean }) {
    const isActive = currentRoleId === r.roleId;
    const isRunning = r.status === "running";
    const isBlocked = (r.blockedReason != null && r.blockedReason !== "") || r.reviewPending;
    const disabled = !r.available || r.userDisabled;
    const roleTone = ROLE_UI[r.roleId as keyof typeof ROLE_UI]?.tone ?? "--tone-neutral";
    // 六个岗位统一使用用户图标；岗位差异由语义色背景表达，状态点只在进行中/待拍板时出现。
    const dotTone = isRunning ? "var(--color-primary)" : isBlocked ? "var(--tone-notice)" : null;
    const dotLabel = isRunning ? "在忙" : "待拍板";
    return (
      <Link
        key={r.roleId}
        href={`/agents/${r.roleId}`}
        title={r.name}
        className={cn(
          // 正文阶默认 400；悬停只换底色，不加深字色。选中态加 medium。
          "group relative flex items-center gap-2 rounded-md pl-2 pr-2 min-h-[30px] text-body transition-colors",
          isActive
              ? "bg-primary/10 text-foreground font-medium"
              : disabled
                ? "text-muted-foreground/50 hover:bg-foreground/10"
                : "text-sidebar-foreground hover:bg-foreground/10 hover:text-foreground"
        )}
      >
        <span className="relative shrink-0 flex size-5 items-center justify-center">
          <span
            className={cn("fa-toned flex size-5 items-center justify-center rounded-md", disabled && "opacity-50")}
            style={{ "--tone": `var(${roleTone})` } as CSSProperties}
          >
            <HugeiconsIcon icon={User02Icon} size={14} aria-hidden="true" />
          </span>
          {dotTone && (
            <span
              className={cn("fa-tone-dot absolute -right-0.5 -bottom-0.5 ring-2 ring-sidebar", isRunning && "fa-dot-pulse")}
              style={{ "--tone": dotTone } as CSSProperties}
              title={dotLabel}
              aria-label={dotLabel}
              role="status"
            />
          )}
        </span>
        <span className="flex-1 min-w-0 truncate">{r.name}</span>
      </Link>
    );
  }

  function renderConversationRow(c: ConversationSummary) {
    const isActive = activeConversationId === c.id;
    // 状态标统一走 ConversationStatusMark；无特殊态画灰色空心（idle），占位但不抢眼。
    const statusMark =
      renamingId === c.id
        ? null
        : resolveConversationStatus({
            live: statusByConversationId[c.id],
            hasError: c.hasError,
            isActive,
          });
    // 双轴：pl-2 = gap-2（图标距左缘 = 距标题）；20px 槽 + gap-2 = 28px 图形列。
    const graphicSlot = (
      <span className="relative shrink-0 flex size-5 items-center justify-center">
        <ConversationStatusMark status={statusMark} size={14} />
      </span>
    );
    const pinLabel = c.pinned ? "取消置顶" : "置顶";
    const pinIcon = c.pinned ? PinOffIcon : PinIcon;
    // 桌面 app：右键整行与悬停 ⋯ 共用同一套操作（置顶 / 重命名 / 删除）。
    return (
      <motion.div
        key={c.id}
        layout={!reduce && !dragging}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? undefined : { opacity: 0 }}
        // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
        className={cn(
          // 底色/边框作用在整行:标题 + 编辑按钮共用同一底,选中/悬停时是一个整体。
          // 注:不在此行叠 active:scale——本行是 layout 动画的 motion.div,transform 由 motion 逐帧驱动,
          // 再挂 CSS transition-transform 会盖掉 transition-colors 并与 layout 动画抢 transform。按压反馈只放导航链接。
          // 与智能体目录同阶：正文默认 400；悬停只换底色，不加深字色。选中态加 medium。
          "group relative flex items-center rounded-md text-body transition-colors",
          renamingId === c.id
            ? ""
            : isActive
              ? "bg-primary/10 text-foreground font-medium"
              : "text-sidebar-foreground hover:bg-foreground/10 hover:text-foreground"
        )}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild disabled={renamingId === c.id}>
            <div className="flex min-h-[30px] min-w-0 flex-1 items-center">
              {renamingId === c.id ? (
                <div className="flex min-h-[30px] flex-1 min-w-0 items-center gap-2 pl-2 pr-2">
                  {graphicSlot}
                  <Input
                    ref={renameInputRef}
                    className="sidebar-rename-input h-7 flex-1 pl-0 pr-2 py-1 text-body"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(c);
                      if (e.key === "Escape") cancelRename();
                    }}
                    onBlur={() => commitRename(c)}
                  />
                </div>
              ) : (
                <Link
                  href={`/chat/recent?id=${c.id}`}
                  title={c.roleId ? `${ROLE_LABELS[c.roleId] ?? c.roleId} · 专员会话 · ${c.title}` : c.title}
                    className="flex min-h-[30px] flex-1 min-w-0 items-center gap-2 pl-2 pr-2 py-1"
                >
                  {graphicSlot}
                  <span className="min-w-0 truncate">{c.title}</span>
                </Link>
              )}
              {renamingId !== c.id && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${c.title} 更多操作`}
                      // 共用整行底色;悬停到按钮本身时再叠一层略深的底,单独高亮。
                      // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                      className="opacity-0 group-hover:opacity-100 mr-1 p-1 rounded text-muted-foreground transition hover:bg-foreground/10"
                    >
                      <HugeiconsIcon icon={MoreVerticalIcon} size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-32">
                    <DropdownMenuItem onClick={() => doPin(c)}>
                      <HugeiconsIcon icon={pinIcon} size={13} />
                      {pinLabel}
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
          </ContextMenuTrigger>
          <ContextMenuContent className="w-32">
            <ContextMenuItem onSelect={() => doPin(c)}>
              <HugeiconsIcon icon={pinIcon} size={13} />
              {pinLabel}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => startRename(c)}>
              <HugeiconsIcon icon={Edit02Icon} size={13} />
              重命名
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onSelect={() => startDelete(c)}>
              <HugeiconsIcon icon={Delete02Icon} size={13} />
              删除
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </motion.div>
    );
  }

  return (
    <aside
      className={cn(
        // 宽度用内联 style 单一驱动(collapsed→0,否则 navWidth):唯一权威源,拖拽即时生效。
        // relative 是拖拽条绝对定位的上下文。
        "relative app-side flex flex-col shrink-0",
        collapsed ? "overflow-visible pointer-events-none" : "overflow-hidden",
        // 展开时做成浮起卡片:四周留 4px 缝 + 圆角 + 描边 + 1 档柔影;折叠(width→0)时全部去掉,避免露出碎片。
        // eslint-disable-next-line no-restricted-syntax -- 容器 Surface 收敛（WP8b），bg-sidebar 必须保留覆盖 Surface 默认底色
        !collapsed && cn(surfaceVariants({ level: "panel", edge: "hairline", shape: "panel" }), "bg-sidebar m-1")
      )}
      style={{ width: collapsed ? 0 : navWidth }}
    >
      <motion.div
        className="flex h-full flex-col overflow-hidden"
        style={{ width: navWidth }}
        initial={false}
        animate={{ opacity: collapsed ? 0 : 1, transform: reduce ? "none" : collapsed ? "translateX(-8px)" : "translateX(0px)" }}
        transition={{ duration: reduce || dragging ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }}
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
      {/* 顶栏:左侧为 macOS 红绿灯预留(DragHandle 拖拽区);右侧放收起按钮(展开态才在侧栏里)。
          Windows 无红绿灯,靠 .app-nav-topbar 的平台样式改为靠左,不留左上角空档(见 globals.css)。 */}
      <div className="app-nav-topbar relative h-[46px] shrink-0 flex items-center justify-end pr-2">
        <DragHandle />
        <NavTopControls />
      </div>

        <>
          <div className="flex flex-col gap-0 px-3 pb-5 shrink-0">
            <Link href="/chat/new" onClick={() => trackFeature("nav.chat")} className={cn(navLinkClass(active === "chat" && chatActive === "new"), "group")}>
              {active === "chat" && chatActive === "new" && <NavActivePill reduce={reduce} />}
              <NavGlyph icon={ChatAddIcon} />
              <span>新对话</span>
              <NavShortcut combo="mod+n" />
            </Link>
            <Link href="/cockpit" onClick={() => trackFeature("nav.cockpit")} className={navLinkClass(active === "cockpit")}>
              {active === "cockpit" && <NavActivePill reduce={reduce} />}
              <NavGlyph icon={DashboardSquare02Icon} />
              <span>总览</span>
            </Link>
            <Link href="/knowledge" onClick={() => trackFeature("nav.knowledge")} className={navLinkClass(active === "knowledge")}>
              {active === "knowledge" && <NavActivePill reduce={reduce} />}
              <NavGlyph icon={LibraryIcon} />
              <span>知识库</span>
            </Link>
            <Link href="/skills" onClick={() => trackFeature("nav.skills")} className={navLinkClass(active === "skills")}>
              {active === "skills" && <NavActivePill reduce={reduce} />}
              <NavGlyph icon={NoteIcon} />
              <span>技能</span>
            </Link>
          </div>

          {/* 一级导航以下共用一条滚动条；scrollbar-gutter 固定右槽，选中框左右恒为 12px。 */}
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            data-nav-scroll-top={scrollEdges.top ? "" : undefined}
            data-nav-scroll-bottom={scrollEdges.bottom ? "" : undefined}
          >
            <nav
              ref={listRef as React.RefObject<HTMLElement>}
              aria-label="主导航"
              onScroll={handleScroll}
              data-nav-scroll=""
              className="sidebar-nav-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pl-3"
            >
              {/* 智能体目录常驻侧栏（可折叠，默认展开）；徽标是唯一的“有事”信号。 */}
              <div data-nav-agent-directory="always" className="flex flex-col gap-1">
                <SectionFoldHeader
                  label="智能体"
                  open={agentsOpen}
                  onToggle={() => setAgentsOpen(!agentsOpen)}
                  trailing={
                    agentPendingCount > 0 ? (
                      <span
                        className="fa-toned text-meta font-medium px-1.5 tabular-nums"
                        style={{ "--tone": "var(--tone-notice)", borderRadius: "999px" } as CSSProperties}
                        title={`${agentPendingCount} 位专员等你拍板`}
                      >
                        {agentPendingCount}
                      </span>
                    ) : null
                  }
                />
                <CollapsibleSectionMotion open={agentsOpen} reduce={reduce}>
                  {agentRoster.length === 0 ? (
                    <span className="flex items-center gap-2 pl-2 pr-2 py-1 text-meta text-muted-foreground">
                      <span className="size-5 shrink-0" aria-hidden />
                      加载中…
                    </span>
                  ) : (
                    agentRoster.map(renderRoleRow)
                  )}
                </CollapsibleSectionMotion>
              </div>

              {hasPinned && (
                <div className="flex flex-col gap-1">
                  <SectionFoldHeader label="置顶" open={pinnedOpen} onToggle={() => setPinnedOpen(!pinnedOpen)} />
                  <CollapsibleSectionMotion open={pinnedOpen} reduce={reduce}>
                      <AnimatePresence initial={false}>
                        {pinnedConversations.map(renderConversationRow)}
                      </AnimatePresence>
                  </CollapsibleSectionMotion>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <SectionFoldHeader label="最近" open={recentOpen} onToggle={() => setRecentOpen(!recentOpen)} />
                <CollapsibleSectionMotion open={recentOpen} reduce={reduce}>
                    {recentConversations.length === 0 && loaded ? (
                      loadError ? (
                        <button
                          type="button"
                          onClick={() => void fetchConversations(0)}
                          className="pl-2 pr-2 py-2 text-meta text-muted-foreground hover:bg-muted rounded text-left"
                        >
                          加载失败，点此重试
                        </button>
                      ) : (
                        <span className="pl-2 pr-2 py-2 text-meta text-muted-foreground">还没有对话。点上方「新对话」开始</span>
                      )
                    ) : (
                      <AnimatePresence initial={false}>
                        {recentConversations.map(renderConversationRow)}
                      </AnimatePresence>
                    )}
                </CollapsibleSectionMotion>
              </div>
            </nav>
          </div>

          <div className="relative flex h-[46px] flex-col justify-center gap-0 px-3 py-0 shrink-0">
            {/* 与上方对话列表隔一条发丝线 */}
            <div className="absolute inset-x-0 top-0 border-t border-border" />
            {/* 用户头像行:左侧头像+名字,右侧保留「设置」齿轮图标;整行点击打开设置。
                hover 提示带上设置快捷键(mod+,),与顶部其它入口一致。 */}
            <ShortcutHint label="设置" combo="mod+," side="right">
              <Link
                href="/config"
                onClick={() => trackFeature("nav.config")}
                aria-current={active === "config" ? "page" : undefined}
                aria-label="设置"
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                className={cn(
                  "group flex h-[30px] min-h-[30px] items-center gap-2 rounded-md pl-1.5 pr-1 transition-colors",
                active === "config" ? "bg-primary/10" : "hover:bg-foreground/10"
                )}
              >
                <UserAvatar name={userName} avatar={userAvatar} size="sm" />
                <span className="flex-1 min-w-0 truncate text-small text-foreground">{userName || "用户"}</span>
                <span className="shrink-0 p-1 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden>
                  <HugeiconsIcon icon={Settings02Icon} size={14} />
                </span>
              </Link>
            </ShortcutHint>
          </div>
        </>
      </motion.div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) cancelDelete(); }}
        title="删除对话"
        description={deleteTarget ? <>确定要删除「{deleteTarget.title}」吗？对话和文件都会被永久删除</> : undefined}
        confirmLabel="确认"
        destructive
        onConfirm={handleConfirmDelete}
      />

      {/* 右边缘整高拖拽区：透明覆盖已有边界，不额外绘制手柄。 */}
      {!collapsed && (
        <VerticalResizeDivider
          className="absolute -right-0.5 top-0 bottom-0"
          aria-label="调整侧栏宽度"
          aria-valuenow={Math.round(navWidth)}
          aria-valuemin={MIN_NAV_WIDTH}
          aria-valuemax={MAX_NAV_WIDTH}
          tabIndex={0}
          // 键盘可操作(与鼠标拖拽等价):左右微调 16px,Home/End 到最小/最大,Enter 还原默认。
          onKeyDown={(e) => {
            const STEP = 16;
            switch (e.key) {
              case "ArrowLeft": setNavWidth(navWidth - STEP); break;
              case "ArrowRight": setNavWidth(navWidth + STEP); break;
              case "Home": setNavWidth(MIN_NAV_WIDTH); break;
              case "End": setNavWidth(MAX_NAV_WIDTH); break;
              case "Enter": setNavWidth(DEFAULT_NAV_WIDTH); break;
              default: return;
            }
            e.preventDefault();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = navWidth;
            let latestW = startW;
            setDragging(true);
            const onMove = (ev: MouseEvent) => {
              latestW = startW + (ev.clientX - startX);
              setNavWidth(latestW);
            };
            const onUp = () => {
              if (latestW < MIN_NAV_WIDTH) {
                setNavWidth(DEFAULT_NAV_WIDTH);
                setCollapsed(true);
              }
              setDragging(false);
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          }}
          onDoubleClick={() => setNavWidth(DEFAULT_NAV_WIDTH)}
        />
      )}
    </aside>
  );
}
