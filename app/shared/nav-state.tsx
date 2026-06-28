"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type ConversationSummary = {
  id: number;
  title: string;
  updatedAt: string;
  pinned: boolean;
};

type NavState = {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  pinnedOpen: boolean;
  setPinnedOpen: (v: boolean) => void;
  recentOpen: boolean;
  setRecentOpen: (v: boolean) => void;
  conversations: ConversationSummary[];
  hasMore: boolean;
  loaded: boolean;
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
  commitRename: (c: ConversationSummary) => void;
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
    } catch {
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
    await fetch("/api/chat/recent", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: c.id, action: "pin", pinned })
    });
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

  const commitRename = useCallback((c: ConversationSummary) => {
    setRenamingIdState(null);
    setRenameDraft("");
    setConversations((prev) => {
      const latest = renameDraft.trim();
      if (!latest || latest === c.title) return prev;
      fetch("/api/chat/recent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id, action: "rename", title: latest })
      });
      return prev.map((item) => (item.id === c.id ? { ...item, title: latest } : item));
    });
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
    await fetch(`/api/chat/recent?id=${id}`, { method: "DELETE" });
  }, [deleteTarget]);

  const contextValue = useMemo(() => ({
    collapsed, setCollapsed,
    searchOpen, setSearchOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    conversations, hasMore, loaded, fetchConversations, refreshConversations, updateConversationTitle,
    menuId, setMenuId,
    deleteTarget,
    renamingId, renameDraft,
    doPin, startRename, cancelRename, commitRename, setRenameDraft,
    startDelete, confirmDelete, cancelDelete
  }), [
    collapsed, setCollapsed,
    searchOpen, setSearchOpen,
    pinnedOpen, setPinnedOpen,
    recentOpen, setRecentOpen,
    conversations, hasMore, loaded, fetchConversations, refreshConversations, updateConversationTitle,
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
