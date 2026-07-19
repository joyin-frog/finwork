"use client";

import type { CSSProperties } from "react";
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
import { cn } from "@/lib/utils";
import { VerticalResizeDivider } from "@/app/shared/vertical-resize-divider";
import { ROLE_LABELS, ROLE_UI } from "@/lib/domain/role-ui";
import { roleNavIcon } from "@/lib/domain/role-icons";
import { surfaceVariants } from "@/components/ui/surface";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  DashboardSquare02Icon,
  LibraryIcon,
  MoreHorizontalIcon,
  Edit02Icon,
  PinIcon,
  PinOffIcon,
  ChatAddIcon,
  Settings02Icon,
  Delete02Icon,
  NoteIcon,
} from "@hugeicons/core-free-icons";

type ConversationSummary = {
  id: number;
  title: string;
  updatedAt: string;
  pinned: boolean;
  /** 专员会话的角色 id（E 刀）；null/缺省 = 主管会话。 */
  roleId?: string | null;
};

type NavActive = "cockpit" | "chat" | "knowledge" | "config" | "files" | "agents" | "skills";
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
          className="flex flex-col gap-1"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
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
    collapsed,
    navWidth, setNavWidth,
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
  }, [agentRoster.length, conversations.length, pinnedOpen, recentOpen, hasPinned, updateScrollEdges]);

  async function handleConfirmDelete() {
    const result = await confirmDelete();
    if (!result) return;
    const currentConversationId = conversationIdFromRoute(window.location.pathname, window.location.search);
    const destination = conversationDeleteDestination(result, currentConversationId);
    if (destination) router.push(destination);
  }

  const navLinkClass = (isActive: boolean) =>
    cn(
      "relative isolate flex items-center gap-3 px-3 min-h-[36px] rounded-md text-body transition-[color,background-color,transform] duration-150 motion-safe:active:scale-[0.98]",
      isActive
        ? "text-primary font-medium"
        : "text-foreground hover:bg-accent hover:text-accent-foreground"
    );

  function renderRoleRow(r: { roleId: string; name: string; available: boolean; userDisabled: boolean; status: string | null; blockedReason: string | null; reviewPending: boolean }) {
    const isActive = currentRoleId === r.roleId;
    const isRunning = r.status === "running";
    const isBlocked = (r.blockedReason != null && r.blockedReason !== "") || r.reviewPending;
    const disabled = !r.available || r.userDisabled;
    const roleTone = ROLE_UI[r.roleId as keyof typeof ROLE_UI]?.tone ?? "--tone-neutral";
    const roleIcon = roleNavIcon(r.roleId);
    // 方形语义图标负责岗位识别；状态点只在进行中/待拍板时出现，避免空闲圆点常驻造成噪声。
    const dotTone = isRunning ? "var(--color-primary)" : isBlocked ? "var(--tone-notice)" : null;
    const dotLabel = isRunning ? "在忙" : "待拍板";
    return (
      <Link
        key={r.roleId}
        href={`/agents/${r.roleId}`}
        title={r.name}
        className={cn(
          "group relative flex items-center gap-2 rounded-[var(--radius)] pl-3 pr-2 min-h-[32px] text-small transition-colors",
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : disabled
              ? "text-muted-foreground/50 hover:bg-accent hover:text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
      >
        <span
          className="fa-toned relative shrink-0 flex size-5 items-center justify-center rounded select-none"
          style={{ "--tone": `var(${roleTone})` } as CSSProperties}
        >
          <HugeiconsIcon icon={roleIcon} size={14} aria-hidden="true" />
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
      <motion.div
        key={c.id}
        layout={!reduce}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? undefined : { opacity: 0 }}
        // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
        className={cn(
          // 底色/边框作用在整行:标题 + 编辑按钮共用同一底,选中/悬停时是一个整体。
          // 注:不在此行叠 active:scale——本行是 layout 动画的 motion.div,transform 由 motion 逐帧驱动,
          // 再挂 CSS transition-transform 会盖掉 transition-colors 并与 layout 动画抢 transform。按压反馈只放导航链接。
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
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
          className={cn("pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 size-1.5 rounded-full", dot.pulse && "animate-pulse")}
            style={{ backgroundColor: dot.tone }}
            title={dot.label}
            aria-label={dot.label}
            role="status"
          />
        )}
        {renamingId === c.id ? (
          <Input
            ref={renameInputRef}
            className="mx-2 h-7 flex-1 px-2 py-1 text-body"
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
            title={c.roleId ? `${ROLE_LABELS[c.roleId] ?? c.roleId} · 专员会话 · ${c.title}` : c.title}
            className="flex-1 min-w-0 pl-4 pr-3 py-1 text-small truncate flex items-center gap-1.5"
          >
            {c.roleId && (
              // 专员会话（E 刀）：15px 角色小头像区分直聊会话
              <span
                className="fa-toned shrink-0 flex items-center justify-center w-[15px] h-[15px] text-[9px] font-semibold select-none"
                style={{ "--tone": `var(${ROLE_UI[c.roleId as keyof typeof ROLE_UI]?.tone ?? "--tone-neutral"})`, borderRadius: "50%" } as CSSProperties}
                aria-hidden="true"
              >
                {(ROLE_LABELS[c.roleId] ?? c.roleId).slice(0, 1)}
              </span>
            )}
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
      <div className="app-nav-topbar relative h-11 shrink-0 flex items-center justify-end pr-2">
        <DragHandle />
        <NavTopControls />
      </div>

        <>
          <div className="flex flex-col gap-0 px-2 pb-5 shrink-0">
            <Link href="/chat/new" onClick={() => trackFeature("nav.chat")} className={cn(navLinkClass(active === "chat" && chatActive === "new"), "group")}>
              {active === "chat" && chatActive === "new" && <NavActivePill reduce={reduce} />}
              <HugeiconsIcon icon={ChatAddIcon} size={16} />
              <span>新对话</span>
              <NavShortcut combo="mod+n" />
            </Link>
            <Link href="/cockpit" onClick={() => trackFeature("nav.cockpit")} className={navLinkClass(active === "cockpit")}>
              {active === "cockpit" && <NavActivePill reduce={reduce} />}
              <HugeiconsIcon icon={DashboardSquare02Icon} size={16} />
              <span>总览</span>
            </Link>
            <Link href="/knowledge" onClick={() => trackFeature("nav.knowledge")} className={navLinkClass(active === "files" || active === "knowledge")}>
              {(active === "files" || active === "knowledge") && <NavActivePill reduce={reduce} />}
              <HugeiconsIcon icon={LibraryIcon} size={16} />
              <span>知识库</span>
            </Link>
            <Link href="/skills" onClick={() => trackFeature("nav.skills")} className={navLinkClass(active === "skills")}>
              {active === "skills" && <NavActivePill reduce={reduce} />}
              <HugeiconsIcon icon={NoteIcon} size={16} />
              <span>技能</span>
            </Link>
          </div>

          {/* 一级导航以下共用一条滚动条；上下边缘在可滚时渐隐模糊，避免内容硬切。 */}
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
              className="sidebar-nav-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2"
            >
              {/* 智能体是短而稳定的核心目录，始终渲染；徽标是唯一的“有事”信号。 */}
              <div data-nav-agent-directory="always" className="flex flex-col gap-1">
                <div className="flex min-h-8 items-center justify-between px-3 text-meta font-medium text-muted-foreground">
                  <span>智能体</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {agentPendingCount > 0 && (
                      <span
                        className="fa-toned text-meta font-medium px-1.5 tabular-nums"
                        style={{ "--tone": "var(--tone-notice)", borderRadius: "999px" } as CSSProperties}
                        title={`${agentPendingCount} 位专员等你拍板`}
                      >
                        {agentPendingCount}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {agentRoster.length === 0 ? (
                    <span className="pl-8 pr-2 py-1 text-meta text-muted-foreground">加载中…</span>
                  ) : (
                    agentRoster.map(renderRoleRow)
                  )}
                </div>
              </div>

              {hasPinned && (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => setPinnedOpen(!pinnedOpen)}
                    className="flex min-h-8 items-center justify-between px-3 text-meta font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span>置顶</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} size={12} className={cn("transition-transform motion-reduce:transition-none", pinnedOpen && "rotate-180")} />
                  </button>
                  <CollapsibleSectionMotion open={pinnedOpen} reduce={reduce}>
                      <AnimatePresence initial={false}>
                        {pinnedConversations.map(renderConversationRow)}
                      </AnimatePresence>
                  </CollapsibleSectionMotion>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setRecentOpen(!recentOpen)}
                  className="flex min-h-8 items-center justify-between px-3 text-meta font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>最近</span>
                  <HugeiconsIcon icon={ArrowDown01Icon} size={12} className={cn("transition-transform motion-reduce:transition-none", recentOpen && "rotate-180")} />
                </button>
                <CollapsibleSectionMotion open={recentOpen} reduce={reduce}>
                    {recentConversations.length === 0 && loaded ? (
                      loadError ? (
                        <button
                          type="button"
                          onClick={() => void fetchConversations(0)}
                          className="px-3 py-2 text-meta text-muted-foreground hover:bg-muted rounded text-left"
                        >
                          加载失败，点此重试
                        </button>
                      ) : (
                        <span className="px-3 py-2 text-meta text-muted-foreground">还没有对话。点上方「新对话」开始</span>
                      )
                    ) : (
                      <AnimatePresence initial={false}>
                        {recentConversations.map(renderConversationRow)}
                      </AnimatePresence>
                    )}
                </CollapsibleSectionMotion>
              </div>
            </nav>
            <div aria-hidden className="sidebar-nav-edge sidebar-nav-edge-top" />
            <div aria-hidden className="sidebar-nav-edge sidebar-nav-edge-bottom" />
          </div>

          <div className="flex flex-col gap-0.5 px-2 py-2 shrink-0">
            {/* 与上方对话列表隔一条发丝线 */}
            <div className="mx-1 mb-1 border-t border-border" />
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
                  "group flex items-center gap-2 rounded-md pl-1.5 pr-1 min-h-[40px] transition-colors",
                  active === "config" ? "bg-primary/10" : "hover:bg-accent"
                )}
              >
                <UserAvatar name={userName} avatar={userAvatar} size="default" />
                <span className="flex-1 min-w-0 truncate text-small text-foreground">{userName || "用户"}</span>
                <span className="shrink-0 p-1 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden>
                  <HugeiconsIcon icon={Settings02Icon} size={16} />
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
            setDragging(true);
            const onMove = (ev: MouseEvent) => {
              setNavWidth(startW + (ev.clientX - startX));
            };
            const onUp = () => {
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
