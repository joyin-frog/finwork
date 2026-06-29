"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  Clock01Icon,
  Attachment01Icon,
  Add01Icon,
  StopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Loading03Icon,
  InternetIcon,
  ChevronRightIcon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import type { StoredAgentEvent, StoredChatAttachment } from "@/lib/db/sqlite";
import { ToolStepList } from "@/app/components/tool-call-step";
import { RoleModeProvider, type RoleMode } from "@/app/chat/role-mode";
import { AskAnsweredSummary } from "@/app/components/ask-user-card";
import { AskUserPanel } from "@/app/components/ask-user-panel";
import { ChatFilePanel } from "@/app/chat/chat-file-panel";
import { TurnError } from "@/app/chat/turn-error";
import { ComposerTip } from "@/app/chat/composer-tips";
import { FindInChat } from "@/app/chat/find-in-chat";
import { useShortcutEvent } from "@/app/shared/global-shortcuts";
import { useNavState } from "@/app/shared/nav-state";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import {
  buildUserContent,
  readAttachment,
  shouldReadAsText,
  getClipboardFiles,
  readAsDataUrl,
  readAsText,
  dataUrlToFile,
} from "@/app/chat/chat-request";
import type { AgentEvent } from "@/app/chat/chat-types";
import {
  stripAttachmentSummary,
  getMessageFiles,
  getPersistedTimeline,
} from "@/app/chat/chat-types";
import { useChatStream, activeAssistantContent, mergeFinalMessages, overlayMessages } from "@/app/shared/chat-stream";
import type {
  Message,
  DisplayFile,
  ChatAttachment,
  ReferencedFile,
  GeneratedAttachment,
  Conversation,
} from "@/app/chat/chat-types";
import { buildTurnSegments } from "@/app/chat/turn-segments";
import type { ProcessSegment } from "@/app/chat/turn-segments";
import { buildReimbursementProvenance } from "@/app/chat/provenance";
import { ProvenancePanel } from "@/app/chat/provenance-panel";
import type { ChatQuickPrompt } from "@/lib/domain/tax-calendar";
import { ChatPreviewSidebar } from "@/app/chat/chat-preview-sidebar";
import {
  previewSelectionFromConversationFile,
  previewSelectionFromDisplayFile,
  previewSelectionFromDraftAttachment,
  previewSelectionFromReferencedFile,
  shouldShowScrollToBottom,
  parseFileLinkHref,
  normalizeModelFileLinks
} from "@/app/chat/chat-preview-selection";
import {
  getDefaultSidebarWidth,
  getMaxSidebarWidth,
  getPanelRightOffset,
  shouldAutoOpenOutputPanel,
  shouldDefaultOpenFilePanel
} from "@/app/chat/file-workspace-state";
import {
  formatBytes,
  getConversationFileUrl,
  getFileIcon,
  isImageFile,
  OpenableFileRow,
  type PreviewableConversationFile
} from "@/app/chat/chat-file-browser";
import { type PreviewFileSelection } from "@/app/shared/file-preview-page";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { ThinkingSpark } from "@/app/shared/thinking-spark";
import { remarkFinanceFileLinks } from "@/lib/remark/finance-file-links";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { PluggableList } from "unified";

const REHYPE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
  },
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), "finance-file"] },
};

const REHYPE_PLUGINS: PluggableList = [rehypeHighlight, [rehypeSanitize, REHYPE_SANITIZE_SCHEMA]];

type ChatMode = "new" | "recent";

// Local TimelineItem keeps AgentEvent for strict narrowing (ask_user, etc.);
// cast with "as TimelineItem[]" where component props require the looser tool-call-step type.
type TimelineItem = {
  id: string;
  event: AgentEvent;
  createdAt: number;
};

const emptyConversationTitle = "新对话";
const EMPTY_TIMELINE: TimelineItem[] = [];

export default function ChatPage({
  mode,
  initialConversationId = null,
  initialDraft,
  quickPrompts,
  roleMode = "daily",
}: {
  mode: ChatMode;
  initialConversationId?: number | null;
  initialDraft?: string;
  quickPrompts?: ChatQuickPrompt[];
  roleMode?: RoleMode;
}) {
  const { refreshConversations, conversations: navConversations, updateConversationTitle } = useNavState();
  const router = useRouter();
  const [conversationId, setConversationId] = useState<number | null>(initialConversationId);
  const urlUpdatedRef = useRef(false);

  // 读取 URL ?find= 参数:自动打开对话内查找(供 Plan 037 全局搜索跳转复用)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const findQ = params.get("find");
    if (findQ) {
      setFindInitial(findQ);
      setFindOpen(true);
      setFilePanelOpen(false); // 折叠文件面板,避免盖住右上角查找浮窗
      // 清掉 find 参数,避免刷新重复触发
      params.delete("find");
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
      window.history.replaceState(null, "", newUrl);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Consume pending attachments from knowledge page (sessionStorage)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("pendingChatAttachments");
      if (!raw) return;
      const pending = JSON.parse(raw) as ChatAttachment[];
      if (pending.length) {
        setAttachments(prev => [...prev, ...pending]);
      }
      sessionStorage.removeItem("pendingChatAttachments");
    } catch { /* ignore */ }
  }, []);

  // Focus textarea on mount when pre-filled via initialDraft
  useEffect(() => {
    if (initialDraft) textareaRef.current?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [referencedAttachments, setReferencedAttachments] = useState<ReferencedFile[]>([]);
  const [conversationFiles, setConversationFiles] = useState<StoredChatAttachment[]>([]);
  const [conversationFilesLoaded, setConversationFilesLoaded] = useState(false);
  const [generatedFiles, setGeneratedFiles] = useState<Record<number, GeneratedAttachment[]>>({});
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [conversationTitle, setConversationTitle] = useState(emptyConversationTitle);
  // 进行中回合的流式态全部托管在跨页存活的 chat-stream store 里(切走切回可继续渲染)。
  // chat-page 只持有"当前正在消费的回合 key",其余字段都从 store 派生。
  const stream = useChatStream();
  const [turnKey, setTurnKey] = useState<string | null>(null);
  const turn = stream.getTurn(turnKey);
  const loading = turn?.status === "streaming";
  const activeTimeline: TimelineItem[] = turn?.timeline ?? [];
  // 待答的 ask_user → 吸附在输入框上方的浮层;已答的在时间线里以紧凑摘要呈现
  const pendingAsk = useMemo(() => {
    if (!loading) return null;
    const answered = new Set<string>();
    for (const t of activeTimeline) if (t.event.type === "ask_user_answered") answered.add(t.event.questionId);
    for (let i = activeTimeline.length - 1; i >= 0; i--) {
      const e = activeTimeline[i].event;
      if (e.type === "ask_user" && !answered.has(e.questionId)) return e;
    }
    return null;
  }, [loading, activeTimeline]);
  const lastOutgoingRef = useRef<{ attachments: ChatAttachment[]; referencedAttachments: ReferencedFile[]; text: string } | null>(null);

  // 渲染用消息 = 已落库/已加载的历史;若本会话有进行中(或刚结束待收尾)的回合,
  // 在其上叠加"用户消息 + 助手流式气泡"(收尾 effect 会把最终消息写回本地 messages 后清掉回合)。
  const displayMessages: Message[] = useMemo(() => {
    if (turn) {
      // done / incomplete 都用 store 的最终(已落库)消息叠加,避免"收尾 effect 写回前"那一帧闪没;
      // incomplete 同样已落库(出错也保留已完成的部分),所以一并走最终消息,中间叙述/文件不丢。
      if (turn.status === "done" || turn.status === "incomplete") return mergeFinalMessages(turn);
      return [...turn.baseMessages, turn.userMessage, { role: "assistant", content: activeAssistantContent(turn) }];
    }
    return messages;
  // messages 与 turn 变化时重算即可(turn 每次流式更新都是新对象)
  }, [turn, messages]);
  // 持久化时间线按 messages 缓存:draft 等无关 state 变化不再重算每条消息的时间线。
  const persistedTimelines = useMemo(() => {
    const m = new Map<number, TimelineItem[]>();
    for (const msg of messages) {
      if (msg.id != null) m.set(msg.id, getPersistedTimeline(msg) as TimelineItem[]);
    }
    return m;
  }, [messages]);
  const [previewSelection, setPreviewSelection] = useState<PreviewFileSelection | null>(null);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionAtPos, setMentionAtPos] = useState(-1);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sidebarMaximized, setSidebarMaximized] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [feedbackMap, setFeedbackMap] = useState<Record<number, { rating: "up" | "down"; reason: string | null }>>({});
  const [findOpen, setFindOpen] = useState(false);
  const [findInitial, setFindInitial] = useState("");
  const draggingRef = useRef(false);
  const sidebarTouchedRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const startXRef = useRef(0);
  const startSidebarRef = useRef(0);
  const outputCountRef = useRef(0);
  const panelDefaultResolvedRef = useRef(false);
  const userClosedPanelRef = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);

  function handleSidebarDividerDown(e: React.MouseEvent) {
    e.preventDefault();
    sidebarTouchedRef.current = true;
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startSidebarRef.current = sidebarWidth;
    setDragging(true);
    setSidebarMaximized(false);

    function onMove(ev: MouseEvent) {
      // 上限留够 MIN_CHAT_COLUMN_WIDTH 给聊天列:拖拽不能把预览拉到几乎全覆盖、挤塌输入框;真要全屏走「放大」按钮。
      const containerW = mainRef.current?.clientWidth ?? 1400;
      const max = getMaxSidebarWidth(containerW);
      setSidebarWidth(Math.max(200, Math.min(max, startSidebarRef.current - (ev.clientX - startXRef.current))));
    }

    function onUp() {
      setDragging(false);
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /** 放大:预览铺满内容区(盖住对话列+输入框,只剩左侧菜单);已满则还原默认宽。切换式。 */
  function maximizeSidebar() {
    sidebarTouchedRef.current = true;
    setSidebarCollapsed(false);
    setFilePanelOpen(false); // 放大时收起文件面板
    const containerW = mainRef.current?.clientWidth ?? 1400;
    const max = Math.max(0, containerW - 4);
    setSidebarMaximized((wasMax) => {
      setSidebarWidth(wasMax ? getDefaultSidebarWidth(containerW) : max);
      return !wasMax;
    });
  }

  useEffect(() => {
    if (mode === "recent" && initialConversationId !== conversationId) {
      setConversationId(initialConversationId);
    }
  }, [conversationId, initialConversationId, mode]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof ResizeObserver === "undefined") return;
    const syncWidth = () => {
      if (!sidebarTouchedRef.current) setSidebarWidth(getDefaultSidebarWidth(main.clientWidth));
    };
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollToBottom(false);
  }, [displayMessages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 180;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, attachments, referencedAttachments]);

  useEffect(() => {
    if (conversationId) void fetchConversationFiles(conversationId);
  }, [conversationId]);

  useEffect(() => {
    panelDefaultResolvedRef.current = false;
    outputCountRef.current = 0;
    userClosedPanelRef.current = false;
    setConversationFiles([]);
    setConversationFilesLoaded(false);
    setPreviewSelection(null);
    setFilePanelOpen(false);
    setSidebarMaximized(false);
    setSidebarCollapsed(true);
  }, [conversationId]);

  // 切到某会话(或挂载)时,若 store 里该会话已有进行中回合,则接管继续渲染;
  // 否则清掉可能残留的、属于其他会话的 turnKey(避免叠加渲染串台)。
  useEffect(() => {
    const key = conversationId != null ? `c:${conversationId}` : null;
    if (key && stream.getTurn(key)) {
      setTurnKey(key);
      return;
    }
    setTurnKey((prev) => (prev && prev.startsWith("c:") ? null : prev));
  }, [conversationId, stream]);

  // 新会话:服务端一创建好就早早拿到 conversationId(meta 事件)→ 立刻进侧栏「最近」+ 改 URL,
  // 避免"流式中切走,这条记录就丢了"。done 收尾里仍会再做一次(幂等)。
  useEffect(() => {
    const cid = turn?.conversationId;
    if (!cid || cid === conversationId) return;
    setConversationId(cid);
    if (mode === "new" && !urlUpdatedRef.current) {
      urlUpdatedRef.current = true;
      window.history.replaceState(null, "", `/chat/recent?id=${cid}`);
    }
    void refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn?.conversationId]);

  // 回合收尾:done → 落最终消息 / 改 URL / 刷新会话列表;error/stopped → 定格已流式内容并恢复输入框附件。
  useEffect(() => {
    if (!turn || !turnKey) return;
    if (turn.status === "streaming") return;

    if (turn.status === "done" || turn.status === "incomplete") {
      // incomplete(出错但已保留已完成部分)也走这里:把落库的最终消息/文件写回本地,中间叙述与产物不丢。
      const realId = turn.conversationId ?? conversationId;
      if (realId && realId !== conversationId) setConversationId(realId);
      if (mode === "new" && turn.conversationId && !urlUpdatedRef.current) {
        urlUpdatedRef.current = true;
        window.history.replaceState(null, "", `/chat/recent?id=${turn.conversationId}`);
      }
      if (turn.finalConversation?.title) setConversationTitle(turn.finalConversation.title);
      const finalMessages = mergeFinalMessages(turn);
      setMessages(finalMessages);
      if (turn.generatedAttachments?.length) {
        setGeneratedFiles((prev) => ({ ...prev, [finalMessages.length - 1]: turn.generatedAttachments! }));
      }
      if (turn.conversationId) void fetchConversationFiles(turn.conversationId);
      void refreshConversations();
      if (turn.status === "incomplete") {
        toast.warning(turn.errorMessage ?? "这次没一次跑完", {
          description: "已完成的部分已保留,发「继续」我就接着把剩下的做完。",
        });
      }
    } else {
      // error / stopped:把已流式内容定格进本地消息,并把草稿文本+附件还回输入框便于一键重试
      setMessages(overlayMessages(turn));
      const out = lastOutgoingRef.current;
      if (out) {
        setAttachments(out.attachments);
        setReferencedAttachments(out.referencedAttachments);
        if (turn.status === "error" && out.text) setDraft(out.text);
      }
      // 失败时给一个明确的恢复动作:配置类→去配置;瞬时类→已还原输入,提示重试
      if (turn.status === "error") {
        if (turn.errorAction === "config") {
          toast.error(turn.errorMessage ?? "配置有误", {
            action: { label: "去配置", onClick: () => router.push("/config") },
          });
        } else if (turn.errorAction === "continue") {
          // 步数超限:不是崩溃,已完成的部分已留存(见 persistAgentTurn 出错收尾);引导用户接着做。
          toast.warning(turn.errorMessage ?? "这次没一次跑完", {
            description: "已完成的部分已保留,发「继续」我就接着把剩下的做完。",
          });
        } else {
          toast.error(turn.errorMessage ?? "处理出错,请重试", {
            description: "已为你还原刚才的输入,按回车即可重试。",
          });
        }
      }
    }

    const finishedKey = turnKey;
    setTurnKey(null);
    stream.consumeTurn(finishedKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn?.status, turnKey]);

  useEffect(() => {
    if (!conversationFilesLoaded) return;
    if (panelDefaultResolvedRef.current) return;
    setFilePanelOpen(shouldDefaultOpenFilePanel(conversationFiles.length));
    panelDefaultResolvedRef.current = true;
  }, [conversationFiles, conversationFilesLoaded]);

  useEffect(() => {
    const outputs = conversationFiles.filter((file) => file.role === "assistant");
    if (!userClosedPanelRef.current && shouldAutoOpenOutputPanel(outputCountRef.current, outputs.length)) {
      setFilePanelOpen(true);
    }
    outputCountRef.current = outputs.length;
  }, [conversationFiles]);

  useEffect(() => {
    if (mode !== "recent" || !conversationId) return;
    let cancelled = false;
    void loadConversation(conversationId, () => cancelled);
    return () => { cancelled = true; };
  }, [conversationId, mode]);

  const placeholder = useMemo(
    () => "随心输入",
    []
  );

  async function loadConversation(id: number, isCancelled: () => boolean = () => false) {
    const response = await fetch(`/api/chat/recent?id=${id}`);
    if (isCancelled()) return;
    if (!response.ok) {
      setConversationTitle("对话不存在");
      setMessages([]);
      toast.error("对话不存在");
      return;
    }
    const payload = (await response.json()) as { data: { conversation: Conversation } };
    if (isCancelled()) return;
    const conversation = payload.data.conversation;
    setConversationTitle(conversation.title);
    // 喂回 nav-state(标题单一源):打开会话时用 DB 权威标题校正侧栏,避免旧摘要标题反盖 header。
    updateConversationTitle(conversation.id, conversation.title);
    setMessages(conversation.messages);
    await Promise.all([
      fetchConversationFiles(conversation.id),
      fetchFeedback(conversation.id),
    ]);
  }

  // header 标题单一源:优先 nav-state 里该会话标题(被 SSE title 事件实时更新),本地 conversationTitle 兜底(新会话/未入列表)。
  const displayTitle = (conversationId != null && navConversations.find((c) => c.id === conversationId)?.title) || conversationTitle;

  async function fetchFeedback(id: number) {
    try {
      const res = await fetch(`/api/chat/feedback?conversationId=${id}`);
      const payload = (await res.json()) as { ok: boolean; data: { feedback: Record<string, { rating: "up" | "down"; reason: string | null }> } };
      if (payload.ok) {
        const mapped: Record<number, { rating: "up" | "down"; reason: string | null }> = {};
        for (const [k, v] of Object.entries(payload.data.feedback)) mapped[Number(k)] = v;
        setFeedbackMap(mapped);
      }
    } catch { /* best-effort */ }
  }

  async function submitFeedback(messageId: number, rating: "up" | "down", reason?: string) {
    try {
      await fetch("/api/chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, rating, reason: reason ?? null }),
      });
      setFeedbackMap((prev) => ({ ...prev, [messageId]: { rating, reason: reason ?? null } }));
    } catch { /* best-effort */ }
  }

  async function fetchConversationFiles(id: number) {
    try {
      const res = await fetch(`/api/chat/attachments?conversationId=${id}`);
      const payload = (await res.json()) as { ok: boolean; data: { attachments: StoredChatAttachment[] } };
      if (payload.ok) setConversationFiles(payload.data.attachments);
    } catch {
      // File panel is helpful, not critical for chatting.
    } finally {
      setConversationFilesLoaded(true);
    }
  }

  function ensureSidebarWidth() {
    if (!sidebarTouchedRef.current && mainRef.current) {
      setSidebarWidth(getDefaultSidebarWidth(mainRef.current.clientWidth));
    }
  }

  function openPreview(selection: PreviewFileSelection | null) {
    if (!selection) return;
    ensureSidebarWidth();
    setSidebarCollapsed(false);
    setPreviewSelection(selection);
  }

  function previewConversationFile(file: PreviewableConversationFile) {
    if (!conversationId) return;
    openPreview(previewSelectionFromConversationFile(conversationId, file));
  }

  function previewDraftAttachment(file: ChatAttachment) {
    openPreview(previewSelectionFromDraftAttachment(file));
  }

  function previewReferencedAttachment(file: ReferencedFile) {
    if (!conversationId) return;
    openPreview(previewSelectionFromReferencedFile(conversationId, file));
  }

  function previewDisplayFile(file: DisplayFile) {
    openPreview(previewSelectionFromDisplayFile(file, conversationId));
  }

  function previewDataUrlFile(name: string, dataUrl: string, mimeType: string, sizeBytes?: number) {
    openPreview({
      kind: "draft",
      name,
      mimeType,
      sizeBytes,
      dataUrl
    });
  }

  function handleThreadScroll() {
    const node = threadRef.current;
    if (!node) return;
    const nextShowScrollToBottom = shouldShowScrollToBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
    shouldStickToBottomRef.current = !nextShowScrollToBottom;
    setShowScrollToBottom(nextShowScrollToBottom);
  }

  function scrollThreadToBottom() {
    shouldStickToBottomRef.current = true;
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollToBottom(false);
  }

  function toggleFilePanel() {
    setFilePanelOpen((current) => {
      const next = !current;
      // 用户手动收起就记住:本会话内别再因新产物自动弹开(产物在消息里也能看到)。
      userClosedPanelRef.current = !next;
      return next;
    });
  }

  useShortcutEvent("toggle-file-panel", toggleFilePanel);

  function toggleSidebar() {
    if (!sidebarCollapsed) setSidebarMaximized(false); // 即将收起 → 复位放大,否则主内容仍 hidden 致白屏
    setSidebarCollapsed((current) => {
      const next = !current;
      if (!current) return next;
      ensureSidebarWidth();
      return next;
    });
  }

  useShortcutEvent("toggle-right-sidebar", toggleSidebar);

  useShortcutEvent("find-in-chat", () => { setFindInitial(""); setFindOpen(true); setFilePanelOpen(false); });

  async function addFiles(files: FileList | File[]) {
    const nextFiles = Array.from(files).filter((file) => {
      if (file.size > 50 * 1024 * 1024) {
        toast.error("文件超过 50MB 限制", { description: file.name });
        return false;
      }
      return true;
    });
    if (!nextFiles.length) return;
    const prepared = await Promise.all(nextFiles.map(readAttachment));
    setAttachments((current) => [...current, ...prepared]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  const getFilteredMentionFiles = useCallback(() => {
    return mentionFilter
      ? conversationFiles.filter((file) => file.fileName.toLowerCase().includes(mentionFilter.toLowerCase()))
      : conversationFiles;
  }, [conversationFiles, mentionFilter]);

  function selectMentionFile(file: StoredChatAttachment) {
    const cursorPos = textareaRef.current?.selectionStart ?? mentionAtPos + 1 + mentionFilter.length;
    const before = draft.slice(0, mentionAtPos);
    const after = draft.slice(cursorPos);
    setDraft(`${before}${file.fileName} ${after}`);
    setReferencedAttachments((prev) => {
      if (prev.some((ref) => ref.storagePath === file.storagePath)) return prev;
      return [...prev, {
        name: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        storagePath: file.storagePath
      }];
    });
    setMentionActive(false);
    textareaRef.current?.focus();
  }

  function handleDraftChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    const cursorPos = event.target.selectionStart ?? value.length;
    setDraft(value);

    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);

    if (atMatch && conversationId) {
      const atPos = atMatch.index! + atMatch[0].indexOf("@");
      setMentionFilter(atMatch[1]);
      setMentionAtPos(atPos);
      setMentionSelectedIdx(0);
      setMentionActive(true);
      void fetchConversationFiles(conversationId);
    } else if (mentionActive) {
      setMentionActive(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionActive) {
      const filtered = getFilteredMentionFiles();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionSelectedIdx((prev) => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionSelectedIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (filtered[mentionSelectedIdx]) selectMentionFile(filtered[mentionSelectedIdx]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionActive(false);
      }
      return;
    }

    if (event.key === "/" && !draft.trim()) {
      event.preventDefault();
      fileInputRef.current?.click();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      void sendMessage(draft);
    }
  }

  async function sendMessage(text: string) {
    const value = text.trim();
    const hasContent = value || attachments.length || referencedAttachments.length;
    if (!hasContent || loading) return;

    const outgoingAttachments = attachments;
    const outgoingRefAttachments = referencedAttachments;
    const userContent = buildUserContent(value, outgoingAttachments, outgoingRefAttachments);
    const imageDataUrls = outgoingAttachments.filter((a) => a.mimeType.startsWith("image/")).map((a) => a.dataUrl);
    const displayFiles: DisplayFile[] = [
      ...outgoingAttachments.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.size,
        dataUrl: file.dataUrl,
        text: file.text
      })),
      ...outgoingRefAttachments.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        storagePath: file.storagePath
      }))
    ];
    const userMsg: Message = { role: "user", content: userContent, imageDataUrls, displayFiles };
    const nextMessages: Message[] = [...messages, userMsg];

    // 把发送 + 流式读取交给跨页存活的 store:流式态由它按会话 key 持有,
    // 切到别的页面再切回来,本回合仍在渲染(不再随组件卸载丢失)。
    const key = conversationId != null ? `c:${conversationId}` : `new:${crypto.randomUUID()}`;
    lastOutgoingRef.current = { attachments: outgoingAttachments, referencedAttachments: outgoingRefAttachments, text: value };
    setTurnKey(key);
    setDraft("");
    setAttachments([]);
    setReferencedAttachments([]);
    setMentionActive(false);

    stream.startTurn({
      key,
      conversationId,
      userMessage: userMsg,
      baseMessages: messages,
      requestMessages: nextMessages,
      attachments: outgoingAttachments,
      referencedAttachments: outgoingRefAttachments
    });
  }

  function stopGeneration() {
    if (turnKey) stream.stopTurn(turnKey);
  }

  const filteredMentionFiles = getFilteredMentionFiles();
  const latestAssistantIndex = displayMessages.map((msg, index) => ({ msg, index })).reverse().find((item) => item.msg.role === "assistant")?.index;
  const panelRightOffset = getPanelRightOffset(sidebarCollapsed, sidebarWidth);

  return (
    <RoleModeProvider value={roleMode}>
      <section className="flex flex-col h-full min-w-0 overflow-hidden">
        <div className="flex flex-1 overflow-hidden min-h-0" ref={mainRef}>
          <section
            className={cn("flex-1 min-w-0 flex flex-col min-h-0", sidebarMaximized && !sidebarCollapsed && "hidden")}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
            }}
          >
            {/* 标题栏只跨聊天列,不再横跨预览:预览开时这两个按钮正好落在卡片左缘,预览关时回到最右。 */}
            <header className="relative flex items-center justify-between gap-3 pr-5 h-11 shrink-0">
              <DragHandle />
              <SidebarToggle />
              <h1 data-tauri-drag-region className="flex-1 min-w-0 text-title truncate">{displayTitle}</h1>
              <ChatFilePanel
                conversationId={conversationId}
                files={conversationFiles}
                filePanelOpen={filePanelOpen}
                onToggleFilePanel={toggleFilePanel}
                openMenuKey={openMenuKey}
                setOpenMenuKey={setOpenMenuKey}
                sidebarCollapsed={sidebarCollapsed}
                panelRightOffset={panelRightOffset}
                onToggleSidebar={toggleSidebar}
                onPreviewFile={previewConversationFile}
              />
            </header>
            <div className={cn(
              // 外层吃满整列宽,让滚动条落在窗口右缘;内容与输入框各自 max-w 居中。
              "flex flex-col flex-1 min-h-0 relative",
              // 新对话(空状态)时让"问候 + 输入框"作为一组垂直居中,输入框不再贴底
              !displayMessages.length && "justify-center"
            )}>
              {findOpen ? (
                <FindInChat
                  open
                  initialQuery={findInitial}
                  threadRef={threadRef}
                  onClose={() => setFindOpen(false)}
                  contentNonce={displayMessages.length}
                />
              ) : null}
              {displayMessages.length ? (
                <section
                  // both-edges:滚动条出现时在两侧各留同宽留白,内容中心不偏 → 与下方(不滚动的)输入框 mx-auto 对齐。
                  className="flex-1 min-h-0 overflow-y-auto pt-10 pb-4 [scrollbar-gutter:stable_both-edges]"
                  ref={threadRef}
                  onScroll={handleThreadScroll}
                >
                 <div className="w-full max-w-[800px] mx-auto px-6">
                  {displayMessages.map((message, index) => (
                    <article
                      className={cn("py-3", message.role === "user" && "flex justify-end")}
                      key={`${message.role}-${message.id ?? index}`}
                    >
                      {message.role === "user" ? (
                        <UserBubble
                          message={message}
                          files={getMessageFiles(message, conversationFiles)}
                          conversationId={conversationId}
                          onPreviewDataUrlFile={previewDataUrlFile}
                          onPreviewDisplayFile={previewDisplayFile}
                          onPreviewFile={previewConversationFile}
                        />
                      ) : (
                        <AssistantTurn
                          message={message}
                          generatedFiles={generatedFiles[index] ?? []}
                          files={getMessageFiles(message, conversationFiles)}
                          openMenuKey={openMenuKey}
                          setOpenMenuKey={setOpenMenuKey}
                          isActive={loading && index === latestAssistantIndex}
                          isLatest={index === latestAssistantIndex}
                          timeline={(loading && index === latestAssistantIndex) ? activeTimeline : (message.id != null ? (persistedTimelines.get(message.id) ?? EMPTY_TIMELINE) : getPersistedTimeline(message) as TimelineItem[])}
                          conversationId={conversationId}
                          onPreviewFile={previewConversationFile}
                          onContinue={() => void sendMessage("继续")}
                          feedback={message.id != null ? feedbackMap[message.id] : undefined}
                          onFeedback={submitFeedback}
                        />
                      )}
                    </article>
                  ))}
                  <div ref={threadEndRef} />
                 </div>
                </section>
              ) : (
                <div className="w-full max-w-[800px] mx-auto px-6 flex flex-col items-center gap-3 text-center mb-8">
                  <h2 className="text-display">今天要处理什么?</h2>
                  <ComposerTip />
                  {quickPrompts?.length ? (
                    <div className="flex flex-col gap-2 w-full max-w-[380px] mt-2 text-left">
                      {quickPrompts.map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-body hover:bg-accent transition-colors cursor-pointer"
                          onClick={() => void sendMessage(item.prompt)}
                        >
                          <span>{item.label}</span>
                          {item.hint ? <span className="text-meta text-muted-foreground shrink-0">{item.hint}</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}

              <section className="relative w-full max-w-[800px] mx-auto px-6 pb-6">
                {showScrollToBottom ? (
                  <button className="scroll-to-bottom-button" type="button" onClick={scrollThreadToBottom} aria-label="滚动到最新消息">
                    <HugeiconsIcon icon={ArrowDown02Icon} size={16} />
                  </button>
                ) : null}
                {pendingAsk ? (
                  <AskUserPanel
                    key={pendingAsk.questionId}
                    questionId={pendingAsk.questionId}
                    question={pendingAsk.question}
                  />
                ) : (
                <form
                  className="rounded-2xl border border-border bg-card px-4 pt-3 pb-2 flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendMessage(draft);
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden-file-input"
                    aria-label="添加照片和文件"
                    onChange={(event) => {
                      if (event.target.files) void addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <div className="flex flex-col gap-2 relative">
                    <FileTray
                      attachments={attachments}
                      referencedAttachments={referencedAttachments}
                      onPreviewAttachment={previewDraftAttachment}
                      onPreviewReference={previewReferencedAttachment}
                      removeAttachment={removeAttachment}
                      removeReference={(storagePath) => setReferencedAttachments((prev) => prev.filter((item) => item.storagePath !== storagePath))}
                    />
                    <textarea
                      ref={textareaRef}
                      className="w-full resize-none bg-transparent text-body outline-none placeholder:text-muted-foreground py-1 min-h-[24px]"
                      aria-label="输入消息"
                      onChange={handleDraftChange}
                      onKeyDown={handleKeyDown}
                      onPaste={(event) => {
                        const files = getClipboardFiles(event.clipboardData);
                        if (files.length) {
                          event.preventDefault();
                          void addFiles(files);
                        }
                      }}
                      placeholder={placeholder}
                      rows={1}
                      value={draft}
                      disabled={loading}
                    />
                    {mentionActive ? (
                      <MentionPopup
                        files={filteredMentionFiles}
                        selectedIndex={mentionSelectedIdx}
                        selectFile={selectMentionFile}
                        setSelectedIndex={setMentionSelectedIdx}
                      />
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <DropdownMenu>
                      <ShortcutHint label="添加文件" combo="/" side="top">
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-10 rounded-full text-muted-foreground"
                            aria-label="添加文件"
                          >
                            <HugeiconsIcon icon={Add01Icon} size={20} />
                          </Button>
                        </DropdownMenuTrigger>
                      </ShortcutHint>
                      <DropdownMenuContent align="start" side="top" className="w-44">
                        <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                          <HugeiconsIcon icon={Attachment01Icon} size={16} />
                          添加照片和文件
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {loading ? (
                      <button className="composer-send-button stop" type="button" aria-label="停止生成" onClick={stopGeneration}>
                        <HugeiconsIcon icon={StopIcon} size={16} />
                      </button>
                    ) : (
                      <ShortcutHint label="发送" combo="enter" side="top">
                        {/* span 承接 hover:disabled 按钮不发指针事件,穿透到外层后 tooltip 仍可见 */}
                        <span className="inline-flex">
                          <button
                            className="composer-send-button disabled:pointer-events-none"
                            disabled={!draft.trim() && !attachments.length && !referencedAttachments.length}
                            type="submit"
                            aria-label="发送"
                          >
                            <HugeiconsIcon icon={ArrowUp02Icon} size={18} />
                          </button>
                        </span>
                      </ShortcutHint>
                    )}
                  </div>
                </form>
                )}
              </section>
            </div>
          </section>
          <div
            className={cn("w-1 shrink-0 cursor-col-resize hover:bg-primary/30 transition-colors", dragging && "bg-primary/30", sidebarMaximized && "hidden")}
            onMouseDown={handleSidebarDividerDown}
          />
          <ChatPreviewSidebar collapsed={sidebarCollapsed} width={sidebarWidth} previewSelection={previewSelection} onMaximize={maximizeSidebar} isMaximized={sidebarMaximized} />
        </div>
      </section>
    </RoleModeProvider>
  );
}

function UserBubble({
  message,
  files,
  conversationId,
  onPreviewDataUrlFile,
  onPreviewDisplayFile,
  onPreviewFile
}: {
  message: Message;
  files: DisplayFile[];
  conversationId: number | null;
  onPreviewDataUrlFile: (name: string, dataUrl: string, mimeType: string, sizeBytes?: number) => void;
  onPreviewDisplayFile: (file: DisplayFile) => void;
  onPreviewFile: (file: PreviewableConversationFile) => void;
}) {
  const imageFiles = files.filter((file) => isImageFile(file.mimeType));
  const documentFiles = files.filter((file) => !isImageFile(file.mimeType));
  return (
    <div className="flex flex-col items-end gap-2 max-w-[85%]">
      {documentFiles.length ? (
        <div className="flex flex-wrap gap-2 justify-end">
          {documentFiles.map((file) => (
            <button
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted border border-border text-meta cursor-pointer hover:bg-accent transition-colors max-w-[200px]"
              key={`${file.name}-${file.sizeBytes}-${file.storagePath ?? file.id ?? ""}`}
              type="button"
              onClick={() => onPreviewDisplayFile(file)}
              title={file.name}
            >
              {getFileIcon(file.mimeType, file.name)}
              <span className="truncate">{file.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      {message.content.trim() ? (
        <div className="md-content bg-primary/8 rounded-2xl px-4 py-2">
          <MarkdownMessage content={getDisplayContent(message)} conversationId={conversationId} files={files} onPreviewFile={onPreviewFile} />
        </div>
      ) : null}
      {imageFiles.length || message.imageDataUrls?.length ? (
        <div className="flex flex-wrap gap-2 justify-end">
          {imageFiles.map((file) => {
            const src = file.dataUrl ?? (file.storagePath && conversationId ? getConversationFileUrl(conversationId, file.storagePath) : "");
            if (!src) return null;
            return (
              <button className="cursor-pointer rounded-lg overflow-hidden" key={`${file.name}-${file.storagePath ?? file.id ?? ""}`} type="button" onClick={() => onPreviewDisplayFile(file)}>
                <img src={src} alt={file.name} className="max-h-32 max-w-[200px] object-cover block" loading="lazy" />
              </button>
            );
          })}
          {!imageFiles.length ? message.imageDataUrls?.map((url, index) => (
            <button className="cursor-pointer rounded-lg overflow-hidden" key={url} type="button" onClick={() => onPreviewDataUrlFile(`附件图片 ${index + 1}`, url, "image/png")}>
              <img src={url} alt={`附件图片 ${index + 1}`} className="max-h-32 max-w-[200px] object-cover block" loading="lazy" />
            </button>
          )) : null}
        </div>
      ) : null}
    </div>
  );
}

function AssistantTurn({
  message,
  generatedFiles,
  files,
  openMenuKey,
  setOpenMenuKey,
  isActive,
  isLatest,
  timeline,
  conversationId,
  onPreviewFile,
  onContinue,
  feedback,
  onFeedback,
}: {
  message: Message;
  generatedFiles: GeneratedAttachment[];
  files: DisplayFile[];
  openMenuKey: string | null;
  setOpenMenuKey: (key: string | null) => void;
  isActive: boolean;
  isLatest?: boolean;
  timeline: TimelineItem[];
  conversationId: number | null;
  onPreviewFile: (file: PreviewableConversationFile) => void;
  onContinue?: () => void;
  feedback?: { rating: "up" | "down"; reason: string | null };
  onFeedback?: (messageId: number, rating: "up" | "down", reason?: string) => void;
}) {
  // 同一生成文件可能同时来自 DB 会话附件(files)和 done 回合产物(generatedFiles),
  // 两者 storagePath 都是 `generate/<名>`,直接拼接会出现重复行 + React 重复 key 报错。按 storagePath 去重。
  const outputFiles = (() => {
    const merged = [
      ...files,
      ...generatedFiles.map((file) => ({ name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes, storagePath: `generate/${file.name}` }))
    ];
    const seen = new Set<string>();
    return merged.filter((file) => {
      const id = file.storagePath ?? file.name;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  })();
  const { processSegments, answerText } = useMemo(() => buildTurnSegments(timeline), [timeline]);
  const askUserItems = useMemo(() => timeline.filter(
    (t): t is TimelineItem & { event: Extract<AgentEvent, { type: "ask_user" }> } => t.event.type === "ask_user"
  ), [timeline]);
  const askAnswers = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of timeline) {
      if (item.event.type === "ask_user_answered") m.set(item.event.questionId, item.event.answer);
    }
    return m;
  }, [timeline]);
  const toolStepCount = useMemo(() => timeline.filter((t) => t.event.type === "tool_use").length, [timeline]);
  // 当前是否有工具在跑(tool_use 多于 tool_result = 有未配对的在执行)。决定「还活着」星芒落在工具行还是底部。
  const anyToolRunning = useMemo(() => {
    let u = 0, r = 0;
    for (const t of timeline) { if (t.event.type === "tool_use") u++; else if (t.event.type === "tool_result") r++; }
    return u > r;
  }, [timeline]);
  // 回合实际处理时长(墙钟):持久化在 agentEvents 的 turn_duration 里(见 query/route 持久化),
  // 直播收尾与重载都能取到;旧数据没有则回退到"N 步"。
  const turnDurationMs = useMemo(() => {
    const ev = (message.agentEvents ?? []).find(
      (e) => (e.payload as { subtype?: string } | undefined)?.subtype === "turn_duration"
    );
    const v = ev ? Number((ev.payload as { message?: string }).message) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [message]);
  const processedLabel = `已处理 ${toolStepCount} 步${turnDurationMs != null ? ` · 用时 ${formatDuration(turnDurationMs)}` : ""}`;
  // 本回合是否未完成(出错收尾落库时标的 turn_incomplete):仅在最新一条且非进行中时给「继续」入口。
  const isIncomplete = useMemo(
    () => (message.agentEvents ?? []).some((e) => (e.payload as { subtype?: string } | undefined)?.subtype === "turn_incomplete"),
    [message]
  );
  // 出错收尾时 turn_incomplete 事件携带的原始错误:用于气泡内常驻展示「友好提示 + 可展开详情」,
  // 不再只靠转瞬即逝的 toast(过了就没、也看不到原始报错)。
  const incompleteError = useMemo(() => {
    const ev = (message.agentEvents ?? []).find((e) => (e.payload as { subtype?: string } | undefined)?.subtype === "turn_incomplete");
    const raw = ev ? (ev.payload as { message?: string }).message : undefined;
    return raw && raw.trim() ? raw.trim().slice(0, 2000) : null;
  }, [message]);
  // C3 溯源:仅报销流程返回非空;机械事实打底,口径叙述仍由模型写在正文。
  const reimbursementProvenance = useMemo(() => buildReimbursementProvenance(timeline), [timeline]);
  const lastSegIdx = processSegments.length - 1;

  // F2: 反馈状态
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false);
  const [customReason, setCustomReason] = useState("");

  // 过程块展开偏好:流式期间强制展开看实时进度;结束后默认折叠成一行摘要,
  // 用户手动切换才持久化(对所有模式一致,roleMode 不再影响展示)。
  const processedKey = message.id ? `processed-${message.id}` : null;
  const [processedOpen, setProcessedOpen] = useState(() => {
    if (processedKey && typeof window !== "undefined") {
      const stored = localStorage.getItem(processedKey);
      if (stored != null) return stored !== "0";
    }
    return false;
  });
  // 流式期间默认展开看实时进度,但允许用户手动折叠并保持折叠(不被新 token 强制重开)。
  const [activeOpen, setActiveOpen] = useState(true);
  // 每次折叠 +1,作为过程段容器的 remount key:再展开时所有展开过的工具回到折叠态。
  const [collapseSeq, setCollapseSeq] = useState(0);
  const processOpen = isActive ? activeOpen : processedOpen;

  return (
    <div className="flex flex-col gap-2">
      {/* 过程块只在有工具步骤时显示(纯文字回合不显示空块);块内只列动作步骤,不含中间叙述文字。 */}
      {toolStepCount > 0 ? (
        <>
        <details
          className="overflow-hidden text-small"
          open={processOpen}
          onToggle={(e) => {
            const open = (e.target as HTMLDetailsElement).open;
            // 折叠时让下级工具重置(remount key +1),再展开全部回到折叠态。
            if (!open) setCollapseSeq((s) => s + 1);
            // 流式期间手动折叠是临时态,不写入偏好;结束后用户切换才持久化。
            if (isActive) {
              setActiveOpen(open);
              return;
            }
            setProcessedOpen(open);
            if (processedKey) localStorage.setItem(processedKey, open ? "1" : "0");
          }}
        >
          {/* 无边框、不缩进:摘要左缘与正文对齐。结束显示实际处理时长(已处理 7m / 1h7m1s)。
              标题与正文同字号同色;流式中叠走光(思考→处理两段式由 isActive 决定文案)。 */}
          <summary className="flex items-center gap-2 cursor-pointer py-1 list-none">
            <span className={cn("min-w-0 flex-1 truncate", isActive ? "fa-shimmer-text" : "text-muted-foreground")}>
              {isActive ? "正在处理" : processedLabel}
            </span>
            <HugeiconsIcon icon={ChevronRightIcon} size={15} className="details-chevron transition-transform shrink-0" />
          </summary>
          {/* 折叠态不挂载过程段子元素:<details open=false> 只视觉隐藏、React 仍会 mount 全部,
              重会话(数千事件)由此一次性渲染卡顿。改为展开时才渲染,打开会话瞬时、点开再挂载。
              key=collapseSeq:每次折叠后重新展开都是全新挂载,工具步骤回到折叠态。 */}
          {processOpen && (
          <div key={collapseSeq} className="pt-1 flex flex-col gap-1">
            {processSegments.map((seg, segIdx) => {
              const segActive = isActive && segIdx === lastSegIdx;
              // 中间叙述文字按真实时序保留在过程块里(夹在动作步骤之间);与最终答案同字体同色同号(.md-content),
              // 靠折叠区 + 分隔线与正文区分。最终回答(最后一段 text)由 buildTurnSegments 摘出走答案气泡,不在此重复。
              if (seg.kind === "text") {
                const text = seg.content.trim();
                if (!text) return null;
                return (
                  // .md-content 自带字号/字重(双类规则,优先级压过外层 text-small 级联),与最终回答完全一致。
                  <div key={`text-${seg.id}`} className="md-content">
                    <MarkdownMessage content={text} conversationId={conversationId} files={outputFiles} onPreviewFile={onPreviewFile} />
                  </div>
                );
              }
              return (
                <div key={`tools-${segIdx}`}>
                  <ToolStepList timeline={seg.items as TimelineItem[]} isActive={segActive} />
                  {(seg.items as TimelineItem[]).filter((t) => t.event.type === "system").map((item) => (
                    <TimelineRow key={item.id} item={item} />
                  ))}
                </div>
              );
            })}
          </div>
          )}
        </details>
        {/* 过程块与正文之间的分隔线(markdown 风格横线) */}
        <hr className="my-1 border-border" />
        </>
      ) : null}
      {askUserItems.map((item) => {
        const ans = askAnswers.get(item.event.questionId);
        // 待答且本回合进行中 → 交给输入框上方的浮层,时间线不重复渲染
        if (ans === undefined && isActive) return null;
        return (
          <AskAnsweredSummary
            key={item.event.questionId}
            header={item.event.question.header}
            answer={ans}
          />
        );
      })}
      {/* 答案正文:占位态(还没产出)不渲染;answerText=最后一段无工具的 text,否则回退 message.content。
          流式期间文本已进过程段时不回退 message.content(避免与过程块里中间文本重复)。 */}
      {(() => {
        if (isActive && message.content === "...") return null;
        const hasTextSegments = timeline.some((t) => t.event.type === "text");
        const displayContent = answerText || (hasTextSegments && isActive ? "" : getDisplayContent(message));
        if (!displayContent.trim()) return null;
        return (
          <div className="md-content">
            <MarkdownMessage content={displayContent} conversationId={conversationId} files={outputFiles} onPreviewFile={onPreviewFile} />
          </div>
        );
      })()}
      {/* 「还活着」跟随星芒:本轮未结束且当前没有工具在跑(纯思考空档 / 答案流式)→ 在内容最底常驻一个动的星芒,
          随产出增长一直贴底;有工具在跑时星芒在那一行(ToolCallStep),这里不重复。彻底消除「像卡住」。 */}
      {isActive && !anyToolRunning ? (
        // 起手(还没任何产出)= 图标 + 「正在思考」文案;之后的处理空档只留图标在动(文案太啰嗦)。
        <div className="flex items-center gap-2 py-0.5" role="status" aria-label="正在思考">
          <ThinkingSpark size={18} />
          {message.content === "..." && processSegments.length === 0 ? (
            <span className="fa-shimmer-text">正在思考</span>
          ) : null}
        </div>
      ) : null}
      {reimbursementProvenance ? <ProvenancePanel provenance={reimbursementProvenance} /> : null}
      {outputFiles.length ? (
        <div className="flex flex-col gap-2">
          {outputFiles.map((file) => (
            <OpenableFileRow
              key={`${file.name}-${file.storagePath ?? ""}`}
              menuKey={`assistant-${message.id ?? "active"}-${file.storagePath ?? file.name}`}
              conversationId={conversationId}
              name={file.name}
              mimeType={file.mimeType}
              sizeBytes={file.sizeBytes}
              storagePath={file.storagePath}
              openMenuKey={openMenuKey}
              setOpenMenuKey={setOpenMenuKey}
              onPreviewFile={onPreviewFile}
              bordered
            />
          ))}
        </div>
      ) : null}
      {isIncomplete && !isActive ? (
        <TurnError error={incompleteError} onRetry={isLatest ? onContinue : undefined} />
      ) : null}
      {message.id != null && !isActive ? (
        <div className="group">
          <div className="flex items-center gap-1 mt-1">
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded text-meta transition-colors",
                feedback?.rating === "up"
                  ? "text-[color:var(--tone-ok)] bg-[color:var(--tone-ok)]/10"
                  : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted"
              )}
              aria-label="有帮助"
              onClick={() => {
                if (message.id != null) onFeedback?.(message.id, "up");
                setReasonPickerOpen(false);
              }}
            >
              <HugeiconsIcon icon={ThumbsUpIcon} size={13} />
            </button>
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded text-meta transition-colors",
                feedback?.rating === "down"
                  ? "text-[color:var(--tone-alarm)] bg-[color:var(--tone-alarm)]/10"
                  : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted"
              )}
              aria-label="没帮上"
              onClick={() => {
                if (feedback?.rating !== "down") setReasonPickerOpen((o) => !o);
                else setReasonPickerOpen((o) => !o);
              }}
            >
              <HugeiconsIcon icon={ThumbsDownIcon} size={13} />
            </button>
          </div>
          {reasonPickerOpen ? (
            <div className="mt-1 flex flex-col gap-2 max-w-xs text-meta">
              <div className="flex flex-wrap gap-1">
                {["数字不对", "口径不对", "没理解需求", "其他"].map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={cn(
                      "px-2 py-0.5 rounded-full border border-border hover:bg-muted transition-colors",
                      customReason === label && "bg-muted"
                    )}
                    onClick={() => setCustomReason((prev) => prev === label ? "" : label)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                className="w-full rounded border border-border bg-background px-2 py-1 text-meta outline-none placeholder:text-muted-foreground"
                placeholder="补充说明（可跳过）"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  className="px-3 py-1 rounded bg-primary text-primary-foreground text-meta hover:opacity-90 transition-opacity"
                  onClick={() => {
                    if (message.id != null) onFeedback?.(message.id, "down", customReason || undefined);
                    setReasonPickerOpen(false);
                    setCustomReason("");
                  }}
                >
                  提交
                </button>
                <button
                  type="button"
                  className="px-3 py-1 rounded border border-border text-meta hover:bg-muted transition-colors"
                  onClick={() => { setReasonPickerOpen(false); setCustomReason(""); }}
                >
                  跳过
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 外部链接:桌面壳走 Tauri shell 在系统浏览器打开(避开 webview 对 _blank 的拦截);浏览器回退 window.open。 */
async function openExternalUrl(href: string) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(href);
      return;
    } catch (err) {
      console.error("[external-link] tauri open failed", err);
    }
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/** 代码块:复用 .md-content pre 样式,叠加右上角复制按钮(hover 浮现)。 */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    const text = ref.current?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  }
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={copy}
        className="absolute right-1.5 top-1.5 z-10 inline-flex items-center justify-center rounded p-1 bg-muted/80 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted hover:text-foreground cursor-pointer"
        aria-label={copied ? "已复制" : "复制代码"}
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/** 表格 DOM → 制表符分隔文本(可直接贴进 Excel/表格)。 */
function tableToText(table: HTMLTableElement | null): string {
  if (!table) return "";
  return Array.from(table.querySelectorAll("tr"))
    .map((row) => Array.from(row.querySelectorAll("th,td")).map((c) => (c.textContent ?? "").trim()).join("\t"))
    .join("\n");
}

/** 表格:只横线样式(CSS)+ 右上角复制按钮(hover 浮现,复制为 TSV)。 */
function TableBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    const text = tableToText(ref.current);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  }
  return (
    <div className="relative group my-3">
      <button
        type="button"
        onClick={copy}
        className="absolute right-0 -top-1 z-10 inline-flex items-center justify-center rounded p-1 bg-background/85 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted hover:text-foreground cursor-pointer"
        aria-label={copied ? "已复制" : "复制表格"}
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
      </button>
      <table ref={ref}>{children}</table>
    </div>
  );
}

const MarkdownMessage = memo(function MarkdownMessage({
  content,
  conversationId,
  files,
  onPreviewFile
}: {
  content: string;
  conversationId: number | null;
  files: DisplayFile[];
  onPreviewFile: (file: PreviewableConversationFile) => void;
}) {
  const linkableFiles = useMemo(
    () =>
      files
        .filter((file) => file.storagePath && file.name)
        .map((file) => ({ name: file.name, storagePath: file.storagePath! })),
    [files]
  );

  // 先把模型手写的文件链接(可能含空格/括号,会让 CommonMark 把整段降级成字面文本)规整成
  // 干净的 finance-file:// 链接,再交给 ReactMarkdown 解析。
  const normalizedContent = useMemo(() => normalizeModelFileLinks(content), [content]);

  const remarkPlugins: PluggableList = useMemo(
    () => [remarkGfm, [remarkFinanceFileLinks, linkableFiles]] as PluggableList,
    [linkableFiles]
  );

  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (!href) return <span>{children}</span>;

        const parsed = parseFileLinkHref(href);
        if (parsed) {
          // File link recognised — but we need conversationId to open the preview
          if (!conversationId) return <span>{children}</span>;

          const { storagePath } = parsed;
          const file = files.find((item) => item.storagePath === storagePath);
          const previewFile: PreviewableConversationFile = {
            fileName: file?.name ?? parsed.name,
            mimeType: file?.mimeType ?? guessMimeType(parsed.name),
            sizeBytes: file?.sizeBytes ?? 0,
            storagePath
          };
          return (
            <button className="inline-flex items-center gap-1 text-meta text-primary cursor-pointer hover:underline underline-offset-2 hover:opacity-80" type="button" onClick={() => onPreviewFile(previewFile)}>
              {getFileIcon(previewFile.mimeType, previewFile.fileName)}
              <span>{children}</span>
            </button>
          );
        }

        // 外部 http(s) 链接(如 WebSearch 引用)→ 可点、系统语义绿、在系统浏览器打开。
        // 排除指回本应用的 localhost/127.0.0.1(多为模型写的死链)→ 按纯文本处理,避免误开应用自身页 + shell.open 报错。
        const isExternalHttp =
          /^https?:\/\//i.test(href) &&
          !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(href);
        if (isExternalHttp) {
          // WebSearch 外链:前缀地球图标(网络标识)、蓝色(--primary,由 .md-content a 决定)、13px、默认无下划线 hover 才有。
          // 锚点保持 inline,长 URL 仍能正常换行。
          return (
            <a
              href={href}
              onClick={(e) => { e.preventDefault(); void openExternalUrl(href); }}
              className="text-small underline-offset-2 hover:underline transition-colors cursor-pointer"
            >
              <HugeiconsIcon icon={InternetIcon} size={12} className="inline-block align-[-0.15em] mr-1 shrink-0" aria-hidden="true" />
              {children}
            </a>
          );
        }
        // 其余非文件、非 http 链接 → 纯文本,避免桌面端死链
        return <span>{children}</span>;
      },
      table: ({ children }: { children?: React.ReactNode }) => <TableBlock>{children}</TableBlock>,
      pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>
    }),
    [files, onPreviewFile, conversationId]
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {normalizedContent}
    </ReactMarkdown>
  );
});

function fileNameFromStoragePath(storagePath: string) {
  const normalized = storagePath.split(/[\\/]/).filter(Boolean).pop();
  return normalized || "生成文件";
}

function guessMimeType(fileName: string) {
  const ext = fileName.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json"
  };
  return ext ? map[ext] ?? "application/octet-stream" : "application/octet-stream";
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const { event } = item;
  // System events are rendered separately from compact tool steps.
  return (
    <div className="flex items-start gap-2 text-meta text-muted-foreground py-0.5">
      <HugeiconsIcon icon={Clock01Icon} size={15} className="shrink-0 mt-0.5" />
      <div>
        <strong>{event.type === "system" ? event.message : ""}</strong>
        {event.type === "system" && event.subtype ? <p>{event.subtype}</p> : null}
      </div>
    </div>
  );
}

function getDisplayContent(message: Message) {
  if (message.role === "assistant") return stripLegacyThinking(message.content).trim();
  if (message.role !== "user") return message.content;
  return stripAttachmentSummary(message.content).trim();
}

function stripLegacyThinking(content: string) {
  return content.replace(/<details\s+class=["']thinking-section["'][^>]*>\s*<summary>.*?<\/summary>\s*[\s\S]*?<\/details>/gi, "").trim();
}

function FileTray({
  attachments,
  referencedAttachments,
  onPreviewAttachment,
  onPreviewReference,
  removeAttachment,
  removeReference
}: {
  attachments: ChatAttachment[];
  referencedAttachments: ReferencedFile[];
  onPreviewAttachment: (attachment: ChatAttachment) => void;
  onPreviewReference: (file: ReferencedFile) => void;
  removeAttachment: (id: string) => void;
  removeReference: (storagePath: string) => void;
}) {
  if (!attachments.length && !referencedAttachments.length) return null;
  return (
    <div className="attachment-tray" aria-label="已添加文件">
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          name={attachment.name}
          mimeType={attachment.mimeType}
          icon={attachment.mimeType.startsWith("image/")
            ? <img src={attachment.dataUrl} alt="" />
            : getFileIcon(attachment.mimeType, attachment.name)}
          onPreview={() => onPreviewAttachment(attachment)}
          onRemove={() => removeAttachment(attachment.id)}
        />
      ))}
      {referencedAttachments.map((file) => (
        <AttachmentChip
          key={file.storagePath}
          name={file.name}
          mimeType={file.mimeType}
          icon={getFileIcon(file.mimeType, file.name)}
          onPreview={() => onPreviewReference(file)}
          onRemove={() => removeReference(file.storagePath)}
        />
      ))}
    </div>
  );
}

/** 文件类型标签:优先扩展名(XLSX/PNG/PPTX),无扩展名退回 mime 子类型。 */
function fileTypeLabel(name: string, mimeType: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (ext) return ext.toUpperCase();
  const sub = mimeType.split("/")[1] ?? "";
  return sub ? sub.toUpperCase() : "文件";
}

/** 输入框里的附件卡片:边框卡 + 图标 + 名字(过长省略)+ 类型;点卡预览(预览标题用完整名,title 也带完整名)。 */
function AttachmentChip({
  name,
  mimeType,
  icon,
  onPreview,
  onRemove,
}: {
  name: string;
  mimeType: string;
  icon: React.ReactNode;
  onPreview: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="attachment-chip" title={name}>
      <button type="button" className="attachment-chip-main" onClick={onPreview} aria-label={`预览 ${name}`}>
        <span className="attachment-chip-icon">{icon}</span>
        <span className="attachment-chip-text">
          <span className="attachment-chip-name">{name}</span>
          <span className="attachment-chip-type">{fileTypeLabel(name, mimeType)}</span>
        </span>
      </button>
      <button type="button" className="attachment-chip-close" onClick={onRemove} aria-label={`移除 ${name}`}>
        &times;
      </button>
    </span>
  );
}

function MentionPopup({
  files,
  selectedIndex,
  selectFile,
  setSelectedIndex
}: {
  files: StoredChatAttachment[];
  selectedIndex: number;
  selectFile: (file: StoredChatAttachment) => void;
  setSelectedIndex: (index: number) => void;
}) {
  return (
    <div className="mention-popup" role="listbox" aria-label="可引用文件">
      {files.length ? (
        files.map((file, index) => (
          <button
            key={file.id}
            className={index === selectedIndex ? "selected" : ""}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onClick={() => selectFile(file)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            {getFileIcon(file.mimeType, file.fileName)}
            <span>{file.fileName}</span>
            <small>{formatBytes(file.sizeBytes)}</small>
          </button>
        ))
      ) : (
        <div className="mention-empty">当前对话暂无可引用文件</div>
      )}
    </div>
  );
}

function formatDuration(ms: number) {
  const total = Math.max(1, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // 紧凑写法、只显非零单位:12s / 7m / 7m3s / 1h7m1s;h、m 都为 0 时至少显示秒。
  let out = "";
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (s || !out) out += `${s}s`;
  return out;
}
