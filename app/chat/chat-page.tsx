"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp02Icon,
  AttachmentIcon,
  Folder01Icon,
  Add01Icon,
  StopIcon,
  NoteIcon,
} from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import type { StoredChatAttachment } from "@/lib/db/sqlite";
import { RoleModeProvider, type RoleMode } from "@/app/chat/role-mode";
import { ROLE_LABELS, ROLE_UI } from "@/lib/domain/role-ui";
import { AskUserPanel } from "@/app/components/ask-user-panel";
import { ChatFilePanel } from "@/app/chat/chat-file-panel";
import { ComposerTip } from "@/app/chat/composer-tips";
import { SkillPopup, ComposerHighlightOverlay, DeepThinkToggle, isValidSkillName, type PickerSkill } from "@/app/chat/composer-skills";
import { insertSkillToken } from "@/app/chat/skill-token";
import { FindInChat } from "@/app/chat/find-in-chat";
import { useShortcutEvent } from "@/app/shared/global-shortcuts";
import { syncCompletedConversationTitle, useNavState } from "@/app/shared/nav-state";
import { ShortcutHint } from "@/app/shared/shortcut-hint";
import {
  buildUserContent,
  formatFolderPathLine,
  getClipboardFiles,
} from "@/app/chat/chat-request";
import { folderNameFromPath, splitFolderPathLines } from "@/app/chat/folder-path";
import {
  getMessageFiles,
  getPersistedTimeline,
} from "@/app/chat/chat-types";
import { useChatStream, activeAssistantContent, mergeFinalMessages, overlayMessages } from "@/app/shared/chat-stream";
import type {
  Message,
  DisplayFile,
  ChatAttachment,
  ReferencedFile,
  Conversation,
  SkillRef,
  ModelTier,
  FolderRef,
} from "@/app/chat/chat-types";
import type { ChatQuickPrompt } from "@/lib/domain/tax-calendar";
import { ChatPreviewSidebar } from "@/app/chat/chat-preview-sidebar";
import {
  previewSelectionFromConversationFile,
  previewSelectionFromDisplayFile,
  previewSelectionFromDraftAttachment,
  previewSelectionFromReferencedFile,
} from "@/app/chat/chat-preview-selection";
import {
  getDefaultSidebarWidth,
  getMaxSidebarWidth,
  shouldAutoOpenOutputPanel,
  shouldDefaultOpenFilePanel
} from "@/app/chat/file-workspace-state";
import {
  type PreviewableConversationFile
} from "@/app/chat/chat-file-browser";
import { type PreviewFileSelection } from "@/app/shared/file-preview-page";
import { DragHandle } from "@/app/shared/window-controls";
import { SidebarToggle } from "@/app/shared/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUsage } from "./use-usage";
import { UsageRing } from "./usage-ring";
import { cn } from "@/lib/utils";
import { VerticalResizeDivider } from "@/app/shared/vertical-resize-divider";
import { surfaceVariants } from "@/components/ui/surface";

import { AssistantTurn, type TimelineItem } from "@/app/chat/components/assistant-turn";
import { UserBubble } from "@/app/chat/components/user-bubble";
import { FileTray } from "@/app/chat/components/file-tray";
import { MentionPopup } from "@/app/chat/components/mention-popup";
import { useChatNavigation } from "@/app/chat/hooks/use-chat-navigation";
import { useAttachments } from "@/app/chat/hooks/use-attachments";

type ChatMode = "new" | "recent";

const emptyConversationTitle = "新对话";
const EMPTY_TIMELINE: TimelineItem[] = [];

export default function ChatPage({
  mode,
  initialConversationId = null,
  initialDraft,
  initialSkill,
  initialRole,
  quickPrompts,
  roleMode = "daily",
}: {
  mode: ChatMode;
  initialConversationId?: number | null;
  initialDraft?: string;
  initialSkill?: SkillRef;
  /** 专员会话（E 刀）：非空时本会话与该角色直聊——头部身份标识 + 首条消息携带 role 参数。 */
  initialRole?: { id: string; name: string };
  quickPrompts?: ChatQuickPrompt[];
  roleMode?: RoleMode;
}) {
  const {
    refreshConversations,
    conversations: navConversations,
    updateConversationTitle,
    openConversationTab,
    upgradeNewConversationTab,
  } = useNavState();
  const router = useRouter();
  const [conversationId, setConversationId] = useState<number | null>(initialConversationId);
  const urlUpdatedRef = useRef(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState(() => {
    if (initialDraft) return initialDraft;
    if (typeof window === "undefined") return "";
    try { return sessionStorage.getItem(`chat-draft:${initialConversationId ?? "new"}`) ?? ""; }
    catch { return ""; }
  });
  const [conversationTitle, setConversationTitle] = useState(emptyConversationTitle);
  // 进行中回合的流式态全部托管在跨页存活的 chat-stream store 里(切走切回可继续渲染)。
  // chat-page 只持有"当前正在消费的回合 key",其余字段都从 store 派生。
  const stream = useChatStream();
  const [turnKey, setTurnKey] = useState<string | null>(null);
  const turn = stream.getTurn(turnKey);
  const loading = turn?.status === "streaming";
  // 用量进度环:挂载/轮询取数;回合从"进行中"落定后刷新一次,数字及时跟上。
  const { usage, refetch: refetchUsage } = useUsage();
  useEffect(() => {
    if (!loading) refetchUsage();
  }, [loading, refetchUsage]);
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
  // 技能引用:/ 弹窗选/输入技能 → 以 chip 呈现并随消息发给 agent。
  const [referencedSkills, setReferencedSkills] = useState<SkillRef[]>(initialSkill ? [initialSkill] : []);
  // 本地文件夹:专属卡片进托盘;发送时写成「文件夹路径:」行给 Agent(气泡里不再展示纯路径)。
  const [folderRefs, setFolderRefs] = useState<FolderRef[]>([]);
  const [composerSkills, setComposerSkills] = useState<PickerSkill[]>([]);
  const [composerSkillsLoaded, setComposerSkillsLoaded] = useState(false);
  const [skillMenuActive, setSkillMenuActive] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  // skillAtPos = -1 表示经 + 菜单打开(无 /xxx 文本需回删);>=0 为 / 在 draft 里的位置。
  const [skillAtPos, setSkillAtPos] = useState(-1);
  const [skillSelectedIdx, setSkillSelectedIdx] = useState(0);
  // 模型档位:跨消息粘滞(本会话沿用),默认快速;「深度思考」开 = reasoning。
  const [modelTier, setModelTier] = useState<ModelTier>("fast");
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerHighlightRef = useRef<HTMLDivElement>(null);
  /** 输入区+@ /技能浮层容器:点外面收起浮层时排除此范围。 */
  const composerPickersRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const [sidebarMaximized, setSidebarMaximized] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<Record<number, { rating: "up" | "down"; reason: string | null }>>({});
  // 会话级信任工具列表(供 header chip 展示/撤销)
  const [trustedTools, setTrustedTools] = useState<string[]>([]);
  const sidebarTouchedRef = useRef(false);
  const startXRef = useRef(0);
  const startSidebarRef = useRef(0);
  const outputCountRef = useRef(0);
  const panelDefaultResolvedRef = useRef(false);
  const userClosedPanelRef = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);
  // Draft persistence — timer for debounced writes; refs allow unmount cleanup to see current values.
  const draftPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftConvIdRef = useRef(conversationId);
  const draftCurValRef = useRef(draft);
  draftConvIdRef.current = conversationId;
  draftCurValRef.current = draft;
  // 防止 fetchTrustedTools 陈旧响应覆盖已切换会话的状态
  const latestConversationIdRef = useRef(conversationId);
  latestConversationIdRef.current = conversationId;

  // ── 附件状态（use-attachments hook）──
  const {
    attachments,
    setAttachments,
    referencedAttachments,
    setReferencedAttachments,
    conversationFiles,
    setConversationFiles,
    conversationFilesLoaded,
    setConversationFilesLoaded,
    generatedFiles,
    setGeneratedFiles,
    addFiles,
    removeAttachment,
    fetchConversationFiles,
  } = useAttachments({
    conversationId,
  });

  // ── find-in-chat / URL 参数导航（use-chat-navigation hook）──
  const { findOpen, findInitial, setFindOpen } = useChatNavigation({
    setFilePanelOpen,
  });

  // 按会话 key 把草稿写入 sessionStorage（空串=移除）。
  function persistDraft(value: string) {
    const key = `chat-draft:${draftConvIdRef.current ?? "new"}`;
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch { /* ignore */ }
  }

  // 从能力目录进入时已预填技能引用/开场白，直接把操作焦点交给输入框。
  useEffect(() => {
    if (initialDraft || initialSkill) textareaRef.current?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时把草稿同步写入 sessionStorage（flush 防抖中未触发的写入）。
  useEffect(() => {
    return () => {
      if (draftPersistTimerRef.current !== null) {
        clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const key = `chat-draft:${draftConvIdRef.current ?? "new"}`;
      try {
        const val = draftCurValRef.current;
        if (val) sessionStorage.setItem(key, val);
        else sessionStorage.removeItem(key);
      } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSidebarDividerDown(e: React.MouseEvent) {
    e.preventDefault();
    sidebarTouchedRef.current = true;
    startXRef.current = e.clientX;
    startSidebarRef.current = sidebarWidth;
    setSidebarMaximized(false);

    function onMove(ev: MouseEvent) {
      // 上限留够 MIN_CHAT_COLUMN_WIDTH 给聊天列:拖拽不能把预览拉到几乎全覆盖、挤塌输入框;真要全屏走「放大」按钮。
      const containerW = mainRef.current?.clientWidth ?? 1400;
      const max = getMaxSidebarWidth(containerW);
      setSidebarWidth(Math.max(200, Math.min(max, startSidebarRef.current - (ev.clientX - startXRef.current))));
    }

    function onUp() {
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
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 180;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, attachments, referencedAttachments]);

  // /skillName 引用留在正文里,没有单独的移除按钮:用户把文字删了,引用就跟着掉。
  useEffect(() => {
    setReferencedSkills((prev) => {
      const next = prev.filter((s) => new RegExp(`(?<!\\S)/${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\S)`).test(draft));
      return next.length === prev.length ? prev : next;
    });
  }, [draft]);

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
    setTrustedTools([]);
    setFolderRefs([]);
  }, [conversationId]);

  // 会话切换：先把旧会话未落盘的草稿冲刷到旧 key，再载入新会话的草稿（含空串=清空）。
  // 特例：新会话首次拿到真实 id（null→N）时草稿归属不变——迁移 key、不动 composer。
  const draftKeyIdRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const prevId = draftKeyIdRef.current;
    draftKeyIdRef.current = conversationId;
    if (prevId === undefined || prevId === conversationId) return; // 首次挂载：惰性初始化已载入
    if (draftPersistTimerRef.current !== null) { clearTimeout(draftPersistTimerRef.current); draftPersistTimerRef.current = null; }
    try {
      const val = draftCurValRef.current;
      if (prevId === null) {
        // null→N：迁移 key，不改 composer 内容
        sessionStorage.removeItem("chat-draft:new");
        if (val) sessionStorage.setItem(`chat-draft:${conversationId}`, val);
      } else {
        const prevKey = `chat-draft:${prevId}`;
        if (val) sessionStorage.setItem(prevKey, val); else sessionStorage.removeItem(prevKey);
        setDraft(sessionStorage.getItem(`chat-draft:${conversationId ?? "new"}`) ?? "");
      }
    } catch { /* ignore */ }
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
    const provisionalTitle = turn?.finalConversation?.title ?? conversationTitle;
    if (mode === "new") upgradeNewConversationTab(cid, provisionalTitle);
    else openConversationTab(cid, provisionalTitle);
    setConversationId(cid);
    if (mode === "new" && !urlUpdatedRef.current) {
      urlUpdatedRef.current = true;
      router.replace(`/chat/recent?id=${cid}`);
    }
    void refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn?.conversationId]);

  // 回合收尾:done → 落最终消息 / 改 URL / 刷新会话列表;error/stopped → 定格已流式内容并恢复输入框附件。
  useEffect(() => {
    if (!turn || !turnKey) return;
    if (turn.status === "streaming") return;
    const realId = turn.conversationId ?? conversationId;
    syncCompletedConversationTitle(
      { status: turn.status, conversationId: realId, finalTitle: turn.finalConversation?.title },
      { setLocalTitle: setConversationTitle, updateNavTitle: updateConversationTitle }
    );

    if (turn.status === "done" || turn.status === "incomplete") {
      // incomplete(出错但已保留已完成部分)也走这里:把落库的最终消息/文件写回本地,中间叙述与产物不丢。
      if (realId && realId !== conversationId) setConversationId(realId);
      if (mode === "new" && turn.conversationId && !urlUpdatedRef.current) {
        urlUpdatedRef.current = true;
        router.replace(`/chat/recent?id=${turn.conversationId}`);
      }
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
      const out = turn.retryPayload;
      if (out) {
        setAttachments(out.attachments);
        setReferencedAttachments(out.referencedAttachments);
        setReferencedSkills(out.referencedSkills);
        if (turn.status === "error" && out.text) { setDraft(out.text); persistDraft(out.text); }
      }
      // 刷新侧栏：落库 trace error → ConversationSummary.hasError，警告标与「最近工作」对齐
      void refreshConversations();
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
          toast.error(turn.errorMessage ?? "这次回复没有完成", {
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
    // 基线在此一并记录:历史产出不算"新产出",下方 auto-open effect 只对基线之后的增量弹出
    outputCountRef.current = conversationFiles.filter((file) => file.role === "assistant").length;
    panelDefaultResolvedRef.current = true;
  }, [conversationFiles, conversationFilesLoaded]);

  useEffect(() => {
    const outputs = conversationFiles.filter((file) => file.role === "assistant");
    // 历史会话首次加载只记基线:既有产出不是"新产出",不触发弹出(浮层会盖住回答首行);
    // 基线就绪后回合中新增产出照常自动弹出。
    if (!panelDefaultResolvedRef.current) {
      outputCountRef.current = outputs.length;
      return;
    }
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

  // ask-user 面板消失后刷新信任列表（用户可能刚勾了「本次对话不再询问」）。
  const prevPendingAskRef = useRef<typeof pendingAsk>(null);
  useEffect(() => {
    const prev = prevPendingAskRef.current;
    prevPendingAskRef.current = pendingAsk;
    if (prev !== null && pendingAsk === null && conversationId) {
      void fetchTrustedTools(conversationId);
    }
  }, [pendingAsk, conversationId]);

  // 专员会话身份：新会话来自 initialRole；打开既有会话时由 loadConversation 按 DB roleId 回填。
  const [sessionRole, setSessionRole] = useState<{ id: string; name: string } | null>(initialRole ?? null);

  const placeholder = useMemo(
    () => (sessionRole ? `和${sessionRole.name}说…` : "随心输入"),
    [sessionRole]
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
    // 专员会话身份回填（DB 权威）：roleId 非空即专员会话，角色名走 client-safe 的 ROLE_LABELS
    setSessionRole(conversation.roleId ? { id: conversation.roleId, name: ROLE_LABELS[conversation.roleId] ?? conversation.roleId } : null);
    setConversationTitle(conversation.title);
    openConversationTab(conversation.id, conversation.title);
    // 喂回 nav-state(标题单一源):打开会话时用 DB 权威标题校正侧栏,避免旧摘要标题反盖 header。
    updateConversationTitle(conversation.id, conversation.title);
    setMessages(conversation.messages);
    await Promise.all([
      fetchConversationFiles(conversation.id),
      fetchFeedback(conversation.id),
      fetchTrustedTools(conversation.id),
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

  async function fetchTrustedTools(id: number) {
    try {
      const res = await fetch(`/api/agent/trust?conversationId=${id}`);
      const payload = (await res.json()) as { ok: boolean; data?: { tools: string[] } };
      if (latestConversationIdRef.current !== id) return; // 陈旧响应：会话已切走
      if (payload.ok && payload.data) setTrustedTools(payload.data.tools);
    } catch { /* best-effort */ }
  }

  async function revokeToolTrustUI(toolName: string) {
    if (!conversationId) return;
    try {
      const res = await fetch("/api/agent/trust", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, toolName }),
      });
      if (res.ok) {
        setTrustedTools((prev) => prev.filter((t) => t !== toolName));
        toast("已恢复每次确认", { description: "代码执行将重新弹出确认卡" });
      } else {
        toast.error("撤销失败，代码执行仍处于已信任状态。请重试");
      }
    } catch {
      toast.error("撤销失败，代码执行仍处于已信任状态。请重试");
    }
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

  // 技能列表懒加载:/ 弹窗或 + 菜单首次打开时拉一次,只取启用的技能。
  const ensureComposerSkillsLoaded = useCallback(async () => {
    if (composerSkillsLoaded) return;
    try {
      const res = await fetch("/api/skills");
      const json = (await res.json()) as {
        ok: boolean;
        data?: Array<{ name: string; description: string; summary?: string; enabled: boolean; source: "bundled" | "user" }>;
      };
      if (json.ok && json.data) {
        setComposerSkills(
          json.data
            .filter((s) => s.enabled)
            .map((s) => ({ name: s.name, description: s.description, summary: s.summary, source: s.source })),
        );
      }
    } catch {
      // 拉取失败:列表为空,/ 弹窗给"暂无可用技能"提示,不阻塞输入。
    } finally {
      setComposerSkillsLoaded(true);
    }
  }, [composerSkillsLoaded]);

  const getFilteredSkills = useCallback(() => {
    const q = skillFilter.trim().toLowerCase();
    if (!q) return composerSkills;
    return composerSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.summary ?? "").toLowerCase().includes(q),
    );
  }, [composerSkills, skillFilter]);

  // 自由输入:filter 是合法技能名且不在列表里 → 提供"引用自定义技能"行。
  const customSkillName = (() => {
    const q = skillFilter.trim();
    if (!q || !isValidSkillName(q)) return null;
    if (composerSkills.some((s) => s.name === q)) return null;
    return q;
  })();

  function openSkillMenu() {
    setSkillFilter("");
    setSkillAtPos(-1);
    setSkillSelectedIdx(0);
    setMentionActive(false);
    setSkillMenuActive(true);
    void ensureComposerSkillsLoaded();
  }

  // 点浮层/输入区外收起 @ 与 / 选单(Escape 仍由 handleKeyDown 处理)。
  useEffect(() => {
    if (!skillMenuActive && !mentionActive) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && composerPickersRef.current?.contains(node)) return;
      setSkillMenuActive(false);
      setMentionActive(false);
    };
    // 延后绑定,避免「+ → 引用技能」同一次点击立刻关掉刚打开的浮层。
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [skillMenuActive, mentionActive]);

  function selectSkill(skill: SkillRef) {
    // 两条路径都把规范 token 写进正文(引用靠正文里的 /name 存活,见上方剪枝 effect):
    // 经 / 打开 → 替换已输入的 "/filter";经 + 菜单打开(skillAtPos<0)→ 在光标处插入。
    const el = textareaRef.current;
    const cursorPos = el?.selectionStart ?? (skillAtPos >= 0 ? skillAtPos + 1 + skillFilter.length : draft.length);
    const start = skillAtPos >= 0 ? skillAtPos : cursorPos;
    const { text, caret } = insertSkillToken(draft, start, cursorPos, skill.name);
    setDraft(text);
    requestAnimationFrame(() => el?.setSelectionRange(caret, caret));
    setReferencedSkills((prev) => (prev.some((s) => s.name === skill.name) ? prev : [...prev, skill]));
    setSkillMenuActive(false);
    setSkillAtPos(-1);
    textareaRef.current?.focus();
  }

  function handleDraftChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    const cursorPos = event.target.selectionStart ?? value.length;
    setDraft(value);
    // 防抖写 sessionStorage，300ms 无新输入则落盘。
    if (draftPersistTimerRef.current !== null) clearTimeout(draftPersistTimerRef.current);
    draftPersistTimerRef.current = setTimeout(() => { persistDraft(value); draftPersistTimerRef.current = null; }, 300);

    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([^\s/]*)$/);

    if (atMatch && conversationId) {
      const atPos = atMatch.index! + atMatch[0].indexOf("@");
      setMentionFilter(atMatch[1]);
      setMentionAtPos(atPos);
      setMentionSelectedIdx(0);
      setMentionActive(true);
      setSkillMenuActive(false);
      void fetchConversationFiles(conversationId);
    } else if (slashMatch) {
      const slashPos = slashMatch.index! + slashMatch[0].indexOf("/");
      setSkillFilter(slashMatch[1]);
      setSkillAtPos(slashPos);
      setSkillSelectedIdx(0);
      setSkillMenuActive(true);
      setMentionActive(false);
      void ensureComposerSkillsLoaded();
    } else {
      if (mentionActive) setMentionActive(false);
      if (skillMenuActive) setSkillMenuActive(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (skillMenuActive) {
      const filtered = getFilteredSkills();
      const optionCount = filtered.length + (customSkillName ? 1 : 0);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        // optionCount 为 0(过滤后无结果且无自定义引用)时 optionCount-1=-1,不夹住会把下标压成负数,
        // 后续 Enter 用 filtered[-1](undefined)调 selectSkill 直接崩在 skill.name 上。
        if (optionCount > 0) setSkillSelectedIdx((prev) => Math.min(prev + 1, optionCount - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSkillSelectedIdx((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (skillSelectedIdx < filtered.length) selectSkill(filtered[skillSelectedIdx]);
        else if (customSkillName) selectSkill({ name: customSkillName, description: "" });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillMenuActive(false);
        return;
      }
      return;
    }

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

    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      void sendMessage(draft);
    }
  }

  // 选文件夹:桌面端选本地目录 → 专属卡片进托盘,不自动发送。
  // 用户可再打字表达意图;路径在发送时写入消息正文供 Agent 读取。
  async function pickReceiptFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const folder = await open({ directory: true, multiple: false, title: "选择文件夹" });
      if (!folder || typeof folder !== "string") return;
      const path = folder.trim();
      if (!path) return;
      setFolderRefs((prev) => {
        if (prev.some((f) => f.path === path)) return prev;
        return [
          ...prev,
          { id: `folder-${path}-${crypto.randomUUID()}`, path, name: folderNameFromPath(path) },
        ];
      });
      setMentionActive(false);
      setSkillMenuActive(false);
      textareaRef.current?.focus();
    } catch (err) {
      console.error("[pick-folder] failed", err);
      toast.error("选择文件夹失败(桌面端可用)");
    }
  }

  async function sendMessage(text: string) {
    const value = text.trim();
    const outgoingAttachments = attachments;
    const outgoingRefAttachments = referencedAttachments;
    const outgoingSkills = referencedSkills;
    const outgoingFolders = folderRefs;
    const baseMessages = messages;

    const folderLines = outgoingFolders.map((f) => formatFolderPathLine(f.path)).filter(Boolean);
    const textWithFolders = [value, ...folderLines].filter(Boolean).join("\n");
    const hasContent = textWithFolders || outgoingAttachments.length || outgoingRefAttachments.length;
    if (!hasContent || loading) return;

    const userContent = buildUserContent(textWithFolders, outgoingAttachments, outgoingRefAttachments);
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
    const nextMessages: Message[] = [...baseMessages, userMsg];

    // 把发送 + 流式读取交给跨页存活的 store:流式态由它按会话 key 持有,
    // 切到别的页面再切回来,本回合仍在渲染(不再随组件卸载丢失)。
    const key = conversationId != null ? `c:${conversationId}` : `new:${crypto.randomUUID()}`;
    setTurnKey(key);
    // 取消待触发的防抖写，并立即清除 storage（防止重启后误恢复已发送内容）。
    if (draftPersistTimerRef.current !== null) { clearTimeout(draftPersistTimerRef.current); draftPersistTimerRef.current = null; }
    persistDraft("");
    setDraft("");
    setAttachments([]);
    setReferencedAttachments([]);
    setReferencedSkills([]);
    setFolderRefs([]);
    setMentionActive(false);
    setSkillMenuActive(false);

    stream.startTurn({
      key,
      conversationId,
      userMessage: userMsg,
      baseMessages,
      requestMessages: nextMessages,
      attachments: outgoingAttachments,
      referencedAttachments: outgoingRefAttachments,
      referencedSkills: outgoingSkills,
      modelTier,
      // 专员会话（E 刀）：首条消息携带角色,服务端创建会话时落 role_id;既有会话由 DB 行为准
      role: sessionRole?.id,
      retryPayload: {
        text: value,
        attachments: outgoingAttachments,
        referencedAttachments: outgoingRefAttachments,
        referencedSkills: outgoingSkills,
      },
    });
  }

  /** 将 DisplayFile 列表中有 storagePath 的项映射为 ReferencedFile（零磁盘读）。 */
  function filesToReferenced(files: DisplayFile[]): ReferencedFile[] {
    return files
      .filter((f) => f.storagePath)
      .map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        storagePath: f.storagePath!,
      }));
  }

  /**
   * 撤回：把这条 user 消息的文字+附件放回输入框，供重新编辑后再发送。
   * 非破坏性——不删除、不改动任何历史消息，只填充 composer。
   */
  function retractMessage(message: Message) {
    if (turnKey) return; // 流式进行中禁止撤回
    // 文本退回 draft；文件夹路径行拆回托盘卡片(不再塞进输入框)。
    const { folders, text } = splitFolderPathLines(message.content);
    const content = text === "请分析这些文件。" ? "" : text;
    setDraft(content);
    persistDraft(content);
    setFolderRefs(
      folders.map((f) => ({
        id: `folder-${f.path}-${crypto.randomUUID()}`,
        path: f.path,
        name: f.name,
      })),
    );
    // 用该消息的附件「完整替换」composer，并清掉其它已暂存的本地上传/技能引用——
    // 否则撤回时残留的无关上传会在下次发送时被一起带上，让 agent 处理错文件。
    setReferencedAttachments(filesToReferenced(getMessageFiles(message, conversationFiles)));
    setAttachments([]);
    setReferencedSkills([]);
    textareaRef.current?.focus();
  }

  function stopGeneration() {
    if (turnKey) stream.stopTurn(turnKey);
  }

  const filteredMentionFiles = getFilteredMentionFiles();
  const latestAssistantIndex = displayMessages.map((msg, index) => ({ msg, index })).reverse().find((item) => item.msg.role === "assistant")?.index;

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
            <header className="app-page-header relative flex items-center justify-between gap-3 pr-5 h-11 shrink-0">
              <DragHandle />
              <SidebarToggle />
              {sessionRole && (
                <span
                  className="fa-toned shrink-0 flex items-center justify-center w-6 h-6 text-meta font-semibold select-none"
                  style={{ "--tone": `var(${ROLE_UI[sessionRole.id as keyof typeof ROLE_UI]?.tone ?? "--tone-neutral"})`, borderRadius: "50%" } as CSSProperties}
                  aria-hidden="true"
                >
                  {sessionRole.name.slice(0, 1)}
                </span>
              )}
              <h1 data-tauri-drag-region className="flex-1 min-w-0 text-title truncate">
                {sessionRole ? `${sessionRole.name} · 专员会话` : displayTitle}
              </h1>
              {sessionRole && (
                <span className="fa-tone-pill text-meta shrink-0 text-muted-foreground" style={{ "--tone": "var(--tone-neutral)" } as CSSProperties}>
                  职责范围内的业务工具
                </span>
              )}
              {trustedTools.length > 0 && (
                <div className="flex items-center gap-2 shrink-0 text-meta text-muted-foreground">
                  <span>已信任代码执行</span>
                  <span>·</span>
                  <button
                    type="button"
                    className="hover:bg-muted rounded-[var(--radius-chip)] px-1 py-0.5 transition-colors"
                    onClick={() => void Promise.all(trustedTools.map((t) => revokeToolTrustUI(t)))}
                  >
                    撤销
                  </button>
                </div>
              )}
              <ChatFilePanel
                conversationId={conversationId}
                files={conversationFiles}
                filePanelOpen={filePanelOpen}
                onToggleFilePanel={toggleFilePanel}
                openMenuKey={openMenuKey}
                setOpenMenuKey={setOpenMenuKey}
                sidebarCollapsed={sidebarCollapsed}
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
                <MessageScrollerProvider
                  autoScroll
                  defaultScrollPosition="end"
                  scrollEdgeThreshold={96}
                >
                 <MessageScroller className="flex-1">
                  <MessageScrollerViewport ref={threadRef}>
                   <MessageScrollerContent className="w-full max-w-[800px] mx-auto gap-0 px-6 pt-10 pb-4">
                  {displayMessages.map((message, index) => {
                    return (
                    <MessageScrollerItem
                      // 用户气泡短而等高:保留 content-visibility 轻虚拟化。
                      // 助手回合含可展开的过程块(高度大、且展开/折叠会突变),固定 10rem 占位会导致
                      // 滚动跳动与离屏内容(fa-thread 连接线)闪失 → 显式 content-visibility:visible 退出虚拟化。
                      // 注:这里覆盖组件基类 [content-visibility:auto] 靠 tailwind-merge 对同一 CSS 属性
                      // 的任意值去重(后者胜);若 tailwind-merge 降级或规则变更需复核此覆盖仍生效。
                      className={cn(
                        "py-3",
                        message.role === "user" ? "flex justify-end" : "[content-visibility:visible]"
                      )}
                      key={`${message.role}-${message.id ?? index}`}
                      messageId={message.id != null ? `message:${message.id}` : undefined}
                    >
                      {message.role === "user" ? (
                        <UserBubble
                          message={message}
                          files={getMessageFiles(message, conversationFiles)}
                          conversationId={conversationId}
                          onPreviewDisplayFile={previewDisplayFile}
                          onPreviewFile={previewConversationFile}
                          onRetract={() => retractMessage(message)}
                          retractDisabled={!!turnKey}
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
                    </MessageScrollerItem>
                  );
                  })}
                   </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton aria-label="滚动到最新消息" />
                 </MessageScroller>
                </MessageScrollerProvider>
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
                          className={cn(
                            surfaceVariants({ level: "card", edge: "hairline", shape: "panel" }),
                            "flex items-center justify-between gap-3 px-4 py-3 text-body hover:bg-accent transition-colors cursor-pointer"
                          )}
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
                {pendingAsk ? (
                  <AskUserPanel
                    key={pendingAsk.questionId}
                    questionId={pendingAsk.questionId}
                    question={pendingAsk.question}
                  />
                ) : (
                <form
                  className={cn(
                    surfaceVariants({ level: "card", edge: "hairline", shape: "overlay" }),
                    "px-4 pt-3 pb-2 flex flex-col gap-2"
                  )}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendMessage(draft);
                  }}
                >
                  <Input
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
                  <div className="flex flex-col gap-2 relative" ref={composerPickersRef}>
                    <FileTray
                      attachments={attachments}
                      referencedAttachments={referencedAttachments}
                      folderRefs={folderRefs}
                      onPreviewAttachment={previewDraftAttachment}
                      onPreviewReference={previewReferencedAttachment}
                      removeAttachment={removeAttachment}
                      removeReference={(storagePath) => setReferencedAttachments((prev) => prev.filter((item) => item.storagePath !== storagePath))}
                      removeFolder={(id) => setFolderRefs((prev) => prev.filter((f) => f.id !== id))}
                    />
                    <div className="composer-highlight-wrap">
                      <ComposerHighlightOverlay text={draft} skills={referencedSkills} ref={composerHighlightRef} />
                      <Textarea
                        ref={textareaRef}
                        className="composer-textarea min-h-[24px] w-full resize-none rounded-none border-0 bg-transparent px-0 py-1 text-body shadow-none focus-visible:ring-0 dark:bg-transparent"
                        aria-label="输入消息"
                        onChange={handleDraftChange}
                        onKeyDown={handleKeyDown}
                        onScroll={(event) => {
                          if (composerHighlightRef.current) composerHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                        }}
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
                    </div>
                    {mentionActive ? (
                      <MentionPopup
                        files={filteredMentionFiles}
                        selectedIndex={mentionSelectedIdx}
                        selectFile={selectMentionFile}
                        setSelectedIndex={setMentionSelectedIdx}
                      />
                    ) : null}
                    {skillMenuActive ? (
                      <SkillPopup
                        skills={getFilteredSkills()}
                        customName={customSkillName}
                        selectedIndex={skillSelectedIdx}
                        selectSkill={selectSkill}
                        setSelectedIndex={setSkillSelectedIdx}
                      />
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <DropdownMenu>
                      <ShortcutHint label="技能与文件" combo="/" side="top">
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                              surfaceVariants({ level: "page", edge: "none", shape: "pill" }),
                              "size-8 text-muted-foreground"
                            )}
                            aria-label="添加内容"
                          >
                            <HugeiconsIcon icon={Add01Icon} size={16} />
                          </Button>
                        </DropdownMenuTrigger>
                      </ShortcutHint>
                      <DropdownMenuContent align="start" side="top" className="w-44">
                        <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                          <HugeiconsIcon icon={AttachmentIcon} size={16} />
                          添加照片和文件
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void pickReceiptFolder()}>
                          <HugeiconsIcon icon={Folder01Icon} size={16} />
                          选择文件夹
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={openSkillMenu}>
                          <HugeiconsIcon icon={NoteIcon} size={16} />
                          引用技能
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <div className="flex items-center gap-0.5">
                      <DeepThinkToggle active={modelTier === "reasoning"} onToggle={(on) => setModelTier(on ? "reasoning" : "fast")} />
                      <UsageRing usage={usage} />
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
                              disabled={!draft.trim() && !attachments.length && !referencedAttachments.length && !folderRefs.length}
                              type="submit"
                              aria-label="发送"
                            >
                              <HugeiconsIcon icon={ArrowUp02Icon} size={16} />
                            </button>
                          </span>
                        </ShortcutHint>
                      )}
                    </div>
                  </div>
                </form>
                )}
              </section>
            </div>
          </section>
          <VerticalResizeDivider
            className={cn(sidebarMaximized && "hidden")}
            onMouseDown={handleSidebarDividerDown}
            aria-label="调整右侧预览宽度"
          />
          <ChatPreviewSidebar collapsed={sidebarCollapsed} width={sidebarWidth} previewSelection={previewSelection} onMaximize={maximizeSidebar} isMaximized={sidebarMaximized} onCollapse={toggleSidebar} />
        </div>
      </section>
    </RoleModeProvider>
  );
}
