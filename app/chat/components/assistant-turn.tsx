"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Clock01Icon,
  ChevronRightIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "@hugeicons/core-free-icons";
import { RefreshIcon, SuccessIcon, CopyIcon } from "@/lib/icons";
import { messageTimestamp } from "@/app/chat/message-timestamp";
import { extractVoucherChips } from "@/app/chat/voucher-chips";
import { ToolStepList } from "@/app/components/tool-call-step";
import { AskAnsweredSummary } from "@/app/components/ask-user-card";
import { TurnError } from "@/app/chat/turn-error";
import { Callout } from "@/app/components/callout";
import { MarkdownMessage } from "@/app/chat/markdown-message";
import { SubagentTrack } from "@/app/chat/subagent-track";
import {
  stripAttachmentSummary,
} from "@/app/chat/chat-types";
import type { AgentEvent } from "@/app/chat/chat-types";
import type {
  Message,
  DisplayFile,
  GeneratedAttachment,
} from "@/app/chat/chat-types";
import { buildTurnSegments } from "@/app/chat/turn-segments";
import { buildReimbursementProvenance } from "@/app/chat/provenance";
import { ProvenancePanel } from "@/app/chat/provenance-panel";
import {
  OpenableFileRow,
  type PreviewableConversationFile
} from "@/app/chat/chat-file-browser";
import { ThinkingSpark } from "@/app/shared/thinking-spark";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { cn } from "@/lib/utils";

// Local TimelineItem keeps AgentEvent for strict narrowing (ask_user, etc.);
// cast with "as TimelineItem[]" where component props require the looser tool-call-step type.
export type TimelineItem = {
  id: string;
  event: AgentEvent;
  createdAt: number;
};

/** 运行中实时跳秒(与工具步骤同款):从 startedAt 起每秒刷新,startedAt 清空即停。 */
export function useLiveElapsed(startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt == null ? 0 : Math.max(0, now - startedAt);
}

/** 起手纯思考阶段的状态行:「正在思考 + 实时计时」(星芒呼吸)。产出一开始即消失,
 *  思考原文不再进过程叙事(thinking 段不渲染),此处只负责起手计时行。 */
export function ThinkingStatusLine({ active }: { active: boolean }) {
  // 思考开始时刻:首次进入"思考态"时记一次,供进行中实时计时。
  const startRef = useRef<number | null>(null);
  if (active && startRef.current == null) startRef.current = Date.now();
  const liveMs = useLiveElapsed(active ? startRef.current ?? undefined : undefined);
  if (!active) return null;

  const timer = liveMs >= 1000 ? ` ${formatDuration(liveMs)}` : "";
  return (
    <Marker role="status" className="py-1 text-small">
      <MarkerIcon><ThinkingSpark size={14} /></MarkerIcon>
      <MarkerContent className="truncate shimmer shimmer-color-primary text-muted-foreground">正在思考{timer}</MarkerContent>
    </Marker>
  );
}

// dead code (zero callers); kept for potential future use; removal is a separate cleanup task
export function fileNameFromStoragePath(storagePath: string) {
  const normalized = storagePath.split(/[\\/]/).filter(Boolean).pop();
  return normalized || "生成文件";
}

export function TimelineRow({ item }: { item: TimelineItem }) {
  const { event } = item;
  // System events are rendered separately from compact tool steps.
  return (
    <Marker className="items-start py-0.5 text-meta">
      <MarkerIcon className="mt-0.5"><HugeiconsIcon icon={Clock01Icon} size={15} /></MarkerIcon>
      <MarkerContent>
        <strong>{event.type === "system" ? event.message : ""}</strong>
        {event.type === "system" && event.subtype ? <span className="block">{event.subtype}</span> : null}
      </MarkerContent>
    </Marker>
  );
}

export function getDisplayContent(message: Message) {
  if (message.role === "assistant") return stripLegacyThinking(message.content).trim();
  if (message.role !== "user") return message.content;
  return stripAttachmentSummary(message.content).trim();
}

export function stripLegacyThinking(content: string) {
  return content.replace(/<details\s+class=["']thinking-section["'][^>]*>\s*<summary>.*?<\/summary>\s*[\s\S]*?<\/details>/gi, "").trim();
}

export function formatDuration(ms: number) {
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

export function AssistantTurn({
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
  // thinking 段是否存在:决定纯思考回合(无工具步)也显示过程块,思考按时序穿插在步骤间。
  const hasThinkingSegment = useMemo(() => processSegments.some((s) => s.kind === "thinking"), [processSegments]);
  // 过程区是否有可见内容(正文进展句):thinking 段不再渲染后,details 的显隐以此为准
  const hasProcessText = useMemo(
    () => processSegments.some((s) => s.kind === "text" && s.content.trim() !== ""),
    [processSegments]
  );
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
  // 思考时长(回合起→首个产出):持久化在 agentEvents 的 thinking_duration,供「已思考 X」与重载展示。
  const thinkingDurationMs = useMemo(() => {
    const ev = (message.agentEvents ?? []).find(
      (e) => (e.payload as { subtype?: string } | undefined)?.subtype === "thinking_duration"
    );
    const v = ev ? Number((ev.payload as { message?: string }).message) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  }, [message]);
  // 纯思考回合(无工具步)的头部走「已思考 + 定格时长」;有工具步照旧「已处理 N 步 · 用时 X」。
  const processedLabel = toolStepCount > 0
    ? `已处理 ${toolStepCount} 步${turnDurationMs != null ? ` · 用时 ${formatDuration(turnDurationMs)}` : ""}`
    : `已思考${thinkingDurationMs != null && thinkingDurationMs >= 1000 ? ` ${formatDuration(thinkingDurationMs)}` : ""}`;
  // 是否已有任何产出(思考原文/工具/答案文本):首个事件一到,起手「正在思考」状态行即让位,
  // 流动的星芒交给时间线里当前进行中的那一行。
  const hasOutput = useMemo(
    () => timeline.some((t) => t.event.type === "tool_use" || t.event.type === "tool_result" || t.event.type === "text" || t.event.type === "thinking"),
    [timeline]
  );
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
  // 用量超限:服务端落库 subtype="usage_blocked" 的 system 事件并把提示文案作为正文。
  // 重载/done 后取自 message.agentEvents(权威),直播瞬间兜底扫 timeline。命中则正文走红字。
  const usageBlockedMessage = useMemo(() => {
    const ev = (message.agentEvents ?? []).find((e) => (e.payload as { subtype?: string } | undefined)?.subtype === "usage_blocked");
    if (ev) return (ev.payload as { message?: string }).message ?? null;
    const live = timeline.find((t) => t.event.type === "system" && (t.event as { subtype?: string }).subtype === "usage_blocked");
    return live ? ((live.event as { message?: string }).message ?? null) : null;
  }, [message, timeline]);
  // C3 溯源:仅报销流程返回非空;机械事实打底,口径叙述仍由模型写在正文。
  const reimbursementProvenance = useMemo(() => buildReimbursementProvenance(timeline), [timeline]);
  // export_voucher_list chips:从 timeline tool_result 读取 sheets/voucherCount,按产物文件名索引。
  // extractVoucherChips 按文件名查找;这里预先收集所有产物文件名 → chips,渲染时直接按名查。
  const voucherChipsMap = useMemo((): Map<string, { sheets: number; voucherCount: number }> => {
    const m = new Map<string, { sheets: number; voucherCount: number }>();
    // 遍历所有 export_voucher_list tool_result,以 fileName 为 key 缓存 chips
    for (const item of timeline) {
      const ev = item.event;
      if (ev.type !== "tool_result") continue;
      const toolName = (ev as { name?: string }).name ?? "";
      if (!toolName.includes("export_voucher_list")) continue;
      const content = (ev as { content?: string }).content ?? "";
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (typeof parsed.fileName !== "string") continue;
        const chips = extractVoucherChips([item], parsed.fileName as string);
        if (chips) m.set(parsed.fileName as string, chips);
      } catch { /* ignore malformed JSON */ }
    }
    return m;
  }, [timeline]);
  const lastSegIdx = processSegments.length - 1;

  // F2: 反馈状态
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false);
  const [customReason, setCustomReason] = useState("");
  // 复制整条回答(纯文本):复用反馈操作区,与代码块/表格局部复制对齐的交互。
  const [answerCopied, setAnswerCopied] = useState(false);
  async function copyAnswer() {
    const text = getDisplayContent(message);
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setAnswerCopied(true);
      toast.success("已复制全文");
      setTimeout(() => setAnswerCopied(false), 1500);
    } catch {
      toast.error("复制失败,请重试");
    }
  }

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
      {/* 起手纯思考阶段(还没任何产出)的状态行:正在思考 + 实时计时。产出一开始就交给过程块,
          思考原文作为 thinking 段按真实时序穿插在工具步骤之间,不再单独聚合展示。 */}
      <ThinkingStatusLine active={isActive && !hasOutput} />
      {/* 纯思考回合(无工具/无过程正文):思考行已不渲染,details 会是空壳,退化为一行定格标签 */}
      {toolStepCount === 0 && !hasProcessText && hasThinkingSegment && !isActive ? (
        <div className="py-1 text-body text-muted-foreground">{processedLabel}</div>
      ) : null}
      {/* 过程块在有工具步骤或过程正文时显示;进行中的纯思考回合也先挂上(产出随时到来) */}
      {toolStepCount > 0 || hasProcessText || (hasThinkingSegment && isActive) ? (
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
            <span className={cn("min-w-0 truncate text-body", isActive ? "shimmer shimmer-color-primary text-muted-foreground" : "text-muted-foreground")}>
              {isActive ? "正在处理" : processedLabel}
            </span>
            <HugeiconsIcon icon={ChevronRightIcon} size={15} className="details-chevron shrink-0 transition-transform" />
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
              if (seg.kind === "thinking") {
                // 思考段不渲染(对齐 Claude:thinking 不进过程叙事,节奏由正文进展句+动作组承担)。
                // 数据仍在 timeline 里,需要时可恢复;进行中的思考由 ThinkingStatusLine/星芒表达。
                return null;
              }
              if (seg.kind === "subagent") {
                // 子代理子轨道：显示角色名 + 逐步工具步骤 + blocked 高亮
                return (
                  <SubagentTrack
                    key={`subagent-${seg.label}-${segIdx}`}
                    label={seg.label}
                    items={seg.items as TimelineItem[]}
                    isActive={segActive}
                  />
                );
              }
              // 跨段恢复信号:该段之后所有 tools 段的事件(失败与重试成功常被 thinking 段隔开)
              const laterToolItems = processSegments
                .slice(segIdx + 1)
                .filter((s) => s.kind === "tools")
                .flatMap((s) => s.items as TimelineItem[]);
              return (
                <div key={`tools-${segIdx}`}>
                  <ToolStepList timeline={seg.items as TimelineItem[]} isActive={segActive} laterTimeline={laterToolItems} conversationId={conversationId} />
                  {(seg.items as TimelineItem[]).filter((t) => t.event.type === "system").map((item) => (
                    <TimelineRow key={item.id} item={item} />
                  ))}
                </div>
              );
            })}
            {/* 已答的确认项折叠在过程块内(它们是过程的一部分);待答且回合进行中 → 输入框上方浮层,不在此重复 */}
            {askUserItems.map((item) => {
              const ans = askAnswers.get(item.event.questionId);
              if (ans === undefined && isActive) return null;
              return (
                <AskAnsweredSummary
                  key={item.event.questionId}
                  header={item.event.question.header}
                  answer={ans}
                />
              );
            })}
          </div>
          )}
        </details>
        </>
      ) : (
        // 无过程块的回合(纯直答)兜底:已答确认项仍要有处落脚
        askUserItems.map((item) => {
          const ans = askAnswers.get(item.event.questionId);
          if (ans === undefined && isActive) return null;
          return (
            <AskAnsweredSummary
              key={item.event.questionId}
              header={item.event.question.header}
              answer={ans}
            />
          );
        })
      )}
      {/* 答案正文:占位态(还没产出)不渲染;answerText=最后一段无工具的 text,否则回退 message.content。
          流式期间文本已进过程段时不回退 message.content(避免与过程块里中间文本重复)。 */}
      {(() => {
        // 用量超限:走与 TurnError 同一个全宽 Callout(warn),视觉与其它提示统一,不再是裸红字。
        if (usageBlockedMessage) {
          return (
            <Callout variant="warn" className="w-full">
              <span className="whitespace-pre-wrap">{usageBlockedMessage}</span>
            </Callout>
          );
        }
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
      {/* 「还活着」跟随星芒:已开始产出、回合未结束且没有工具在跑(答案流式 / 处理空档)→ 底部动的星芒。
          思考行已不渲染,尾巴是思考段时星芒统一落底部,不再有"落在思考行"的分支。 */}
      {isActive && !anyToolRunning && hasOutput ? (
        <div className="flex items-center gap-2 py-0.5" role="status" aria-label="处理中">
          <ThinkingSpark size={18} />
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
              voucherChips={voucherChipsMap.get(file.name) ?? null}
            />
          ))}
        </div>
      ) : null}
      {isIncomplete && !isActive ? (
        <TurnError error={incompleteError} />
      ) : null}
      {message.id != null && !isActive ? (
        <div className="group">
          <div className="flex items-center gap-1 mt-1">
            {/* 未完成回合的「重试」并入操作行(常驻,不随 hover 隐藏——出错恢复是主动作);其余操作仍 hover 浮现。 */}
            {isIncomplete && isLatest && onContinue ? (
              <button
                type="button"
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                className="flex items-center gap-1 px-2 py-1 rounded text-meta text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
                aria-label="重试"
                onClick={onContinue}
              >
                <HugeiconsIcon icon={RefreshIcon} size={13} />
              </button>
            ) : null}
            <button
              type="button"
              className={cn(
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                "flex items-center gap-1 px-2 py-1 rounded text-meta transition-colors transition-opacity",
                answerCopied
                  ? "text-[color:var(--tone-ok)] bg-[color:var(--tone-ok)]/10"
                  : "msg-toolbar-btn-fade text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground hover:bg-muted"
              )}
              aria-label={answerCopied ? "已复制" : "复制全文"}
              onClick={copyAnswer}
            >
              <HugeiconsIcon icon={answerCopied ? SuccessIcon : CopyIcon} size={13} />
            </button>
            <button
              type="button"
              className={cn(
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                "flex items-center gap-1 px-2 py-1 rounded text-meta transition-colors transition-opacity",
                feedback?.rating === "up"
                  ? "text-[color:var(--tone-ok)] bg-[color:var(--tone-ok)]/10"
                  : "msg-toolbar-btn-fade text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground hover:bg-muted"
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
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                "flex items-center gap-1 px-2 py-1 rounded text-meta transition-colors transition-opacity",
                feedback?.rating === "down"
                  ? "text-[color:var(--tone-alarm)] bg-[color:var(--tone-alarm)]/10"
                  : "msg-toolbar-btn-fade text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground hover:bg-muted"
              )}
              aria-label="没帮上"
              onClick={() => {
                if (feedback?.rating !== "down") setReasonPickerOpen((o) => !o);
                else setReasonPickerOpen((o) => !o);
              }}
            >
              <HugeiconsIcon icon={ThumbsDownIcon} size={13} />
            </button>
            {/* 相对时间戳:hover/键盘聚焦时淡入,灰字小字,离开后消失 */}
            {message.createdAt ? (
              <span className="msg-toolbar-timestamp text-caption text-muted-foreground/60 px-1 select-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                {messageTimestamp(message.createdAt)}
              </span>
            ) : null}
          </div>
          {reasonPickerOpen ? (
            <div className="mt-1 flex flex-col gap-2 max-w-xs text-meta">
              <div className="flex flex-wrap gap-1">
                {["数字不对", "口径不对", "没理解需求", "其他"].map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={cn(
                      // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
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
                // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
                className="w-full rounded border border-border bg-background px-2 py-1 text-meta placeholder:text-muted-foreground"
                placeholder="补充说明（可跳过）"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
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
                  // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
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
