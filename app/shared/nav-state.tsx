"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

export const MIN_NAV_WIDTH = 180;
export const MAX_NAV_WIDTH = 360;
export const DEFAULT_NAV_WIDTH = 216;

type ConversationSummary = {
  id: number;
  title: string;
  updatedAt: string;
  pinned: boolean;
};

/** 侧栏「智能体」子列表用的精简角色项（来自 /api/agents 的 roster，只取导航所需字段）。 */
export type AgentRosterLite = {
  roleId: string;
  name: string;
  available: boolean;
  userDisabled: boolean;
  status: string | null;
  blockedReason: string | null;
  /** 该角色近 7 天内是否有 review_status='pending' 的派发——与 blockedReason 一样算「待拍板」 */
  reviewPending: boolean;
};

export type PageKind = "cockpit" | "chat-new" | "agents" | "knowledge" | "files" | "skills" | "config";

export type PageTab = {
  kind: "page";
  key: `page:${PageKind}`;
  pageKind: PageKind;
  title: string;
  href: string;
};

export type AppConversationTab = {
  kind: "conversation";
  key: `conversation:${number}`;
  conversationId: number;
  title: string;
  href: string;
};

export type AppTab = PageTab | AppConversationTab;

export type AppTabsState = {
  tabs: AppTab[];
  activeKey: string | null;
  latestTitlesById: Record<number, string>;
};

export type AppTabsAction =
  | { type: "openPage"; tab: PageTab }
  | { type: "openConversation"; tab: AppConversationTab }
  | { type: "upgradeChatNew"; tab: AppConversationTab }
  | { type: "activate"; key: string }
  | { type: "close"; key: string }
  | { type: "closeAll" }
  | { type: "removeDeleted"; id: number }
  | { type: "updateTitle"; id: number; title: string };

export const COCKPIT_TAB: PageTab = {
  kind: "page",
  key: "page:cockpit",
  pageKind: "cockpit",
  title: "总览",
  href: "/cockpit",
};

const PAGE_ROUTE_META: Array<{ prefix: string; pageKind: PageKind; title: string }> = [
  { prefix: "/chat/new", pageKind: "chat-new", title: "新对话" },
  { prefix: "/cockpit", pageKind: "cockpit", title: "总览" },
  { prefix: "/agents", pageKind: "agents", title: "智能体" },
  { prefix: "/knowledge", pageKind: "knowledge", title: "知识库" },
  { prefix: "/files", pageKind: "files", title: "文件" },
  { prefix: "/skills", pageKind: "skills", title: "技能" },
  { prefix: "/config", pageKind: "config", title: "设置" },
];

export function pageTabFromRoute(pathname: string, search: string): PageTab | null {
  if (pathname === "/chat/recent" || pathname.startsWith("/chat/recent/")) return null;
  const match = PAGE_ROUTE_META.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!match) return null;
  const suffix = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  return {
    kind: "page",
    key: `page:${match.pageKind}`,
    pageKind: match.pageKind,
    title: match.title,
    href: `${pathname}${suffix}`,
  };
}

export function appTabKeyFromRoute(pathname: string, search: string): string | null {
  const conversationId = conversationIdFromRoute(pathname, search);
  if (conversationId) return `conversation:${conversationId}`;
  return pageTabFromRoute(pathname, search)?.key ?? null;
}

export function resolveSelectedAppTabKey(
  routeKey: string | null,
  activeKey: string | null,
  tabs: AppTab[]
): string | null {
  if (routeKey && tabs.some((tab) => tab.key === routeKey)) return routeKey;
  if (
    routeKey === "page:chat-new"
    && activeKey?.startsWith("conversation:")
    && tabs.some((tab) => tab.key === activeKey)
  ) return activeKey;
  return null;
}

function removeAppTab(state: AppTabsState, key: string): AppTabsState {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return state;
  const removed = state.tabs[index];
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  const fallbackTabs = tabs.length ? tabs : [COCKPIT_TAB];
  const activeKey = state.activeKey === key
    ? (state.tabs[index + 1]?.key ?? state.tabs[index - 1]?.key ?? COCKPIT_TAB.key)
    : state.activeKey;
  const latestTitlesById = { ...state.latestTitlesById };
  if (removed.kind === "conversation") delete latestTitlesById[removed.conversationId];
  return { tabs: fallbackTabs, activeKey, latestTitlesById };
}

export function appTabsReducer(state: AppTabsState, action: AppTabsAction): AppTabsState {
  switch (action.type) {
    case "openPage": {
      const existing = state.tabs.findIndex((tab) => tab.key === action.tab.key);
      if (existing === -1) return { ...state, tabs: [...state.tabs, action.tab], activeKey: action.tab.key };
      const tabs = [...state.tabs];
      tabs[existing] = action.tab;
      return { ...state, tabs, activeKey: action.tab.key };
    }
    case "openConversation": {
      const existing = state.tabs.findIndex((tab) => tab.key === action.tab.key);
      const title = existing === -1
        ? state.latestTitlesById[action.tab.conversationId] ?? action.tab.title
        : action.tab.title;
      const tab = { ...action.tab, title };
      const latestTitlesById = { ...state.latestTitlesById, [tab.conversationId]: title };
      if (existing === -1) return { ...state, tabs: [...state.tabs, tab], activeKey: tab.key, latestTitlesById };
      const tabs = [...state.tabs];
      tabs[existing] = tab;
      return { ...state, tabs, activeKey: tab.key, latestTitlesById };
    }
    case "upgradeChatNew": {
      const newIndex = state.tabs.findIndex((tab) => tab.key === "page:chat-new");
      const existingIndex = state.tabs.findIndex((tab) => tab.key === action.tab.key);
      const title = existingIndex === -1
        ? state.latestTitlesById[action.tab.conversationId] ?? action.tab.title
        : action.tab.title;
      const tab = { ...action.tab, title };
      const tabs = [...state.tabs];
      if (existingIndex !== -1) {
        tabs[existingIndex] = tab;
        if (newIndex !== -1) tabs.splice(newIndex, 1);
      } else if (newIndex !== -1) {
        tabs[newIndex] = tab;
      } else {
        tabs.push(tab);
      }
      return {
        tabs,
        activeKey: tab.key,
        latestTitlesById: { ...state.latestTitlesById, [tab.conversationId]: title },
      };
    }
    case "activate":
      return state.tabs.some((tab) => tab.key === action.key) ? { ...state, activeKey: action.key } : state;
    case "close":
      return removeAppTab(state, action.key);
    case "closeAll":
      return { tabs: [COCKPIT_TAB], activeKey: COCKPIT_TAB.key, latestTitlesById: {} };
    case "removeDeleted":
      return removeAppTab(state, `conversation:${action.id}`);
    case "updateTitle": {
      const tabs = state.tabs.map((tab) => tab.kind === "conversation" && tab.conversationId === action.id
        ? { ...tab, title: action.title }
        : tab);
      return { ...state, tabs, latestTitlesById: { ...state.latestTitlesById, [action.id]: action.title } };
    }
  }
}

export type ConversationTab = {
  id: number;
  title: string;
};

export type ConversationTabsState = {
  tabs: ConversationTab[];
  activeId: number | null;
  latestTitlesById: Record<number, string>;
};

export type ConversationTabsAction =
  | { type: "open"; tab: ConversationTab }
  | { type: "activate"; id: number }
  | { type: "close"; id: number }
  | { type: "closeAll" }
  | { type: "removeDeleted"; id: number }
  | { type: "updateTitle"; id: number; title: string };

function removeConversationTab(state: ConversationTabsState, id: number): ConversationTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { ...state, tabs };
  return { ...state, tabs, activeId: state.tabs[index + 1]?.id ?? state.tabs[index - 1]?.id ?? null };
}

export function conversationTabsReducer(
  state: ConversationTabsState,
  action: ConversationTabsAction
): ConversationTabsState {
  switch (action.type) {
    case "open": {
      const existing = state.tabs.findIndex((tab) => tab.id === action.tab.id);
      const title = existing === -1
        ? state.latestTitlesById[action.tab.id] ?? action.tab.title
        : action.tab.title;
      const tab = { ...action.tab, title };
      const latestTitlesById = { ...state.latestTitlesById, [tab.id]: title };
      if (existing === -1) return { ...state, tabs: [...state.tabs, tab], activeId: tab.id, latestTitlesById };
      const tabs = [...state.tabs];
      tabs[existing] = tab;
      return { ...state, tabs, activeId: tab.id, latestTitlesById };
    }
    case "activate":
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, activeId: action.id } : state;
    case "close":
    case "removeDeleted":
      {
        const next = removeConversationTab(state, action.id);
        const latestTitlesById = { ...next.latestTitlesById };
        delete latestTitlesById[action.id];
        return { ...next, latestTitlesById };
      }
    case "closeAll":
      return { ...state, tabs: [], activeId: null };
    case "updateTitle": {
      const tabs = state.tabs.map((tab) => (tab.id === action.id ? { ...tab, title: action.title } : tab));
      return {
        ...state,
        tabs,
        latestTitlesById: { ...state.latestTitlesById, [action.id]: action.title },
      };
    }
  }
}

export type ConversationDeleteResult = {
  deletedId: number;
  activeId: number | null;
  activeHref?: string | null;
};

export function conversationDeleteResultForState(
  deletedId: number,
  state: ConversationTabsState | AppTabsState
): ConversationDeleteResult {
  if ("activeKey" in state) {
    const activeTab = state.tabs.find((tab) => tab.key === state.activeKey);
    return {
      deletedId,
      activeId: activeTab?.kind === "conversation" ? activeTab.conversationId : null,
      activeHref: activeTab?.href ?? COCKPIT_TAB.href,
    };
  }
  return { deletedId, activeId: state.activeId };
}

export function conversationIdFromRoute(pathname: string, search: string): number | null {
  if (pathname !== "/chat/recent") return null;
  const id = Number(new URLSearchParams(search).get("id"));
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function conversationDeleteDestination(
  result: ConversationDeleteResult,
  currentConversationId: number | null
): string | null {
  if (currentConversationId !== result.deletedId) return null;
  return result.activeHref ?? (result.activeId ? `/chat/recent?id=${result.activeId}` : "/cockpit");
}

export function syncCompletedConversationTitle(
  input: { status: string; conversationId: number | null; finalTitle: string | null | undefined },
  sinks: { setLocalTitle: (title: string) => void; updateNavTitle: (id: number, title: string) => void }
): boolean {
  if ((input.status !== "done" && input.status !== "incomplete") || !input.finalTitle) return false;
  sinks.setLocalTitle(input.finalTitle);
  if (input.conversationId) sinks.updateNavTitle(input.conversationId, input.finalTitle);
  return true;
}

type NavState = {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  navWidth: number;
  setNavWidth: (v: number) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  pinnedOpen: boolean;
  setPinnedOpen: (v: boolean) => void;
  recentOpen: boolean;
  setRecentOpen: (v: boolean) => void;
  /** 「智能体」子列表展开态（默认展开，同 pinnedOpen 语义）。 */
  agentsOpen: boolean;
  setAgentsOpen: (v: boolean) => void;
  /** 角色花名册（导航子列表 + 状态点用）；挂载时取一次。 */
  agentRoster: AgentRosterLite[];
  /** 待拍板专员数（blockedReason 非空或 reviewPending 为真的角色数）——父项徽标用。 */
  agentPendingCount: number;
  fetchAgentRoster: () => Promise<void>;
  conversations: ConversationSummary[];
  appTabs: AppTab[];
  activeAppTabKey: string | null;
  openPageTab: (tab: PageTab) => void;
  openConversationTab: (id: number, title: string) => void;
  upgradeNewConversationTab: (id: number, title: string) => void;
  activateAppTab: (key: string) => void;
  closeAppTab: (key: string) => AppTab;
  closeAllAppTabs: () => void;
  hasMore: boolean;
  loaded: boolean;
  loadError: boolean;
  fetchConversations: (offset: number) => Promise<void>;
  refreshConversations: () => Promise<void>;
  /** 就地更新某条对话标题(标题单一源):agent 提炼标题经 SSE title 事件推来时调,侧栏与 header 同步。 */
  updateConversationTitle: (id: number, title: string) => void;
  menuId: number | null;
  setMenuId: (id: number | null) => void;
  deleteTarget: ConversationSummary | null;
  renamingId: number | null;
  renameDraft: string;
  doPin: (c: ConversationSummary) => Promise<void>;
  startRename: (c: ConversationSummary) => void;
  cancelRename: () => void;
  commitRename: (c: ConversationSummary) => Promise<void>;
  setRenameDraft: (v: string) => void;
  startDelete: (c: ConversationSummary) => void;
  confirmDelete: () => Promise<ConversationDeleteResult | null>;
  cancelDelete: () => void;
};

const NavContext = createContext<NavState | null>(null);

export function useNavState() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNavState must be used within NavStateProvider");
  return ctx;
}

export function NavStateProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [navWidth, setNavWidthState] = useState(DEFAULT_NAV_WIDTH);

  // Mount-only: restore persisted width from localStorage.
  // Initial state is DEFAULT to keep SSR / client first-frame consistent (no hydration mismatch).
  useEffect(() => {
    try {
      const stored = localStorage.getItem("nav:width");
      if (stored) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) {
          setNavWidthState(Math.max(MIN_NAV_WIDTH, Math.min(MAX_NAV_WIDTH, parsed)));
        }
      }
    } catch {
      // SSR / private-mode: silently ignore
    }
  }, []);

  const setNavWidth = useCallback((v: number) => {
    const clamped = Math.max(MIN_NAV_WIDTH, Math.min(MAX_NAV_WIDTH, v));
    setNavWidthState(clamped);
    try {
      localStorage.setItem("nav:width", String(clamped));
    } catch {
      // SSR / private-mode: silently ignore
    }
  }, []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [agentRoster, setAgentRoster] = useState<AgentRosterLite[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [appTabsState, dispatchAppTabs] = useReducer(appTabsReducer, {
    tabs: [],
    activeKey: null,
    latestTitlesById: {},
  });
  const appTabsStateRef = useRef(appTabsState);
  appTabsStateRef.current = appTabsState;
  const applyAppTabsAction = useCallback((action: AppTabsAction) => {
    const next = appTabsReducer(appTabsStateRef.current, action);
    appTabsStateRef.current = next;
    dispatchAppTabs(action);
    return next;
  }, []);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [renamingId, setRenamingIdState] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const loadingRef = useRef(false);

  const fetchConversations = useCallback(async (offset: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await fetch(`/api/chat/recent?mode=summaries&limit=20&offset=${offset}`);
      const payload = (await res.json()) as {
        data: { summaries: ConversationSummary[]; total: number; hasMore: boolean };
      };
      setConversations((prev) => (offset === 0 ? payload.data.summaries : [...prev, ...payload.data.summaries]));
      setHasMore(payload.data.hasMore);
      setLoadError(false);
      setLoaded(true);
    } catch {
      setLoadError(true);
      setLoaded(true);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const refreshConversations = useCallback(() => fetchConversations(0), [fetchConversations]);

  const fetchAgentRoster = useCallback(async () => {
    try {
      const res = await fetch("/api/agents", { cache: "no-store" });
      const payload = (await res.json()) as {
        ok: boolean;
        data?: { roster: AgentRosterLite[] };
      };
      if (payload.ok && payload.data) {
        setAgentRoster(
          payload.data.roster.map((r) => ({
            roleId: r.roleId,
            name: r.name,
            available: r.available,
            userDisabled: r.userDisabled,
            status: r.status ?? null,
            blockedReason: r.blockedReason ?? null,
            reviewPending: r.reviewPending ?? false,
          }))
        );
      }
    } catch {
      // 侧栏花名册取不到不阻塞导航：保持空列表，父项仍可点开
    }
  }, []);

  // 挂载取一次角色花名册（状态点 + 徽标）。轮询留待后续刀。
  useEffect(() => {
    void fetchAgentRoster();
  }, [fetchAgentRoster]);

  const agentPendingCount = agentRoster.filter(
    (r) => (r.blockedReason != null && r.blockedReason !== "") || r.reviewPending
  ).length;

  const openPageTab = useCallback((tab: PageTab) => {
    applyAppTabsAction({ type: "openPage", tab });
  }, [applyAppTabsAction]);

  const openConversationTab = useCallback((id: number, title: string) => {
    applyAppTabsAction({
      type: "openConversation",
      tab: { kind: "conversation", key: `conversation:${id}`, conversationId: id, title, href: `/chat/recent?id=${id}` },
    });
  }, [applyAppTabsAction]);

  const upgradeNewConversationTab = useCallback((id: number, title: string) => {
    applyAppTabsAction({
      type: "upgradeChatNew",
      tab: { kind: "conversation", key: `conversation:${id}`, conversationId: id, title, href: `/chat/recent?id=${id}` },
    });
  }, [applyAppTabsAction]);

  const activateAppTab = useCallback((key: string) => {
    applyAppTabsAction({ type: "activate", key });
  }, [applyAppTabsAction]);

  const closeAppTab = useCallback((key: string) => {
    const next = applyAppTabsAction({ type: "close", key });
    return next.tabs.find((tab) => tab.key === next.activeKey) ?? COCKPIT_TAB;
  }, [applyAppTabsAction]);

  const closeAllAppTabs = useCallback(() => {
    applyAppTabsAction({ type: "closeAll" });
  }, [applyAppTabsAction]);

  const updateConversationTitle = useCallback((id: number, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    applyAppTabsAction({ type: "updateTitle", id, title });
  }, [applyAppTabsAction]);

  useEffect(() => {
    if ((recentOpen || pinnedOpen) && !loaded) {
      fetchConversations(0);
    }
  }, [pinnedOpen, recentOpen, loaded, fetchConversations]);

  const doPin = useCallback(async (c: ConversationSummary) => {
    const pinned = !c.pinned;
    setConversations((prev) =>
      prev
        .map((item) => (item.id === c.id ? { ...item, pinned } : item))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    );
    setMenuId(null);
    try {
      const res = await fetch("/api/chat/recent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id, action: "pin", pinned })
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setConversations((prev) =>
        prev
          .map((item) => (item.id === c.id ? { ...item, pinned: !pinned } : item))
          .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
      );
      toast.error(pinned ? "置顶失败，已还原。检查网络后重试" : "取消置顶失败，已还原。检查网络后重试");
    }
  }, []);

  const startRename = useCallback((c: ConversationSummary) => {
    setMenuId(null);
    setRenamingIdState(c.id);
    setRenameDraft(c.title);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingIdState(null);
    setRenameDraft("");
  }, []);

  const commitRename = useCallback(async (c: ConversationSummary) => {
    const latest = renameDraft.trim();
    setRenamingIdState(null);
    setRenameDraft("");
    if (!latest || latest === c.title) return;
    const prevTitle = c.title;
    setConversations((prev) => prev.map((item) => (item.id === c.id ? { ...item, title: latest } : item)));
    applyAppTabsAction({ type: "updateTitle", id: c.id, title: latest });
    try {
      const res = await fetch("/api/chat/recent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id, action: "rename", title: latest })
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setConversations((prev) => prev.map((item) => (item.id === c.id ? { ...item, title: prevTitle } : item)));
      applyAppTabsAction({ type: "updateTitle", id: c.id, title: prevTitle });
      toast.error(`重命名失败，已还原为「${prevTitle}」`);
    }
  }, [renameDraft, applyAppTabsAction]);

  const startDelete = useCallback((c: ConversationSummary) => {
    setMenuId(null);
    setDeleteTarget(c);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return null;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/chat/recent?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      await fetchConversations(0);
      toast.error("删除失败：对话已还原。检查网络后重试");
      return null;
    }
    applyAppTabsAction({ type: "removeDeleted", id });
    return conversationDeleteResultForState(id, appTabsStateRef.current);
  }, [deleteTarget, fetchConversations, applyAppTabsAction]);

  const contextValue = useMemo(() => ({
    collapsed, setCollapsed,
    navWidth, setNavWidth,
    searchOpen, setSearchOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    agentsOpen, setAgentsOpen,
    agentRoster, agentPendingCount, fetchAgentRoster,
    conversations,
    appTabs: appTabsState.tabs,
    activeAppTabKey: appTabsState.activeKey,
    openPageTab, openConversationTab, upgradeNewConversationTab, activateAppTab, closeAppTab, closeAllAppTabs,
    hasMore, loaded, loadError, fetchConversations, refreshConversations, updateConversationTitle,
    menuId, setMenuId,
    deleteTarget,
    renamingId, renameDraft,
    doPin, startRename, cancelRename, commitRename, setRenameDraft,
    startDelete, confirmDelete, cancelDelete
  }), [
    collapsed, setCollapsed,
    navWidth, setNavWidth,
    searchOpen, setSearchOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    agentsOpen, setAgentsOpen,
    agentRoster, agentPendingCount, fetchAgentRoster,
    conversations, appTabsState,
    openPageTab, openConversationTab, upgradeNewConversationTab, activateAppTab, closeAppTab, closeAllAppTabs,
    hasMore, loaded, loadError, fetchConversations, refreshConversations, updateConversationTitle,
    menuId, setMenuId,
    deleteTarget,
    renamingId, renameDraft,
    doPin, startRename, cancelRename, commitRename, setRenameDraft,
    startDelete, confirmDelete, cancelDelete
  ]);

  return (
    <NavContext.Provider value={contextValue}>
      {children}
    </NavContext.Provider>
  );
}
