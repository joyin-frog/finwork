"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  conversations: ConversationSummary[];
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
  confirmDelete: () => Promise<void>;
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
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
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

  const updateConversationTitle = useCallback((id: number, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

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
    try {
      const res = await fetch("/api/chat/recent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id, action: "rename", title: latest })
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setConversations((prev) => prev.map((item) => (item.id === c.id ? { ...item, title: prevTitle } : item)));
      toast.error(`重命名失败，已还原为「${prevTitle}」`);
    }
  }, [renameDraft]);

  const startDelete = useCallback((c: ConversationSummary) => {
    setMenuId(null);
    setDeleteTarget(c);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/chat/recent?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      await fetchConversations(0);
      toast.error("删除失败：对话已还原。检查网络后重试");
    }
  }, [deleteTarget, fetchConversations]);

  const contextValue = useMemo(() => ({
    collapsed, setCollapsed,
    navWidth, setNavWidth,
    searchOpen, setSearchOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    conversations, hasMore, loaded, loadError, fetchConversations, refreshConversations, updateConversationTitle,
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
    conversations, hasMore, loaded, loadError, fetchConversations, refreshConversations, updateConversationTitle,
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
