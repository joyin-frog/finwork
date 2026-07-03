"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChevronRightIcon,
  CommandLineIcon, FlashIcon, PencilEdit01Icon, File01Icon,
  Search01Icon, InternetIcon, Calculator01Icon, HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { ThinkingSpark } from "@/app/shared/thinking-spark";
import { getToolSummary } from "@/lib/agent/tools/renderers";
import { useRoleMode } from "@/app/chat/role-mode";
import { ToolResultCard } from "./tool-cards";
import { cn } from "@/lib/utils";
import { formatToolInput, formatToolOutput } from "@/lib/agent/tools/content-format";
import { aggregateToolSegment, summarizeToolSegment } from "@/app/chat/step-aggregate";
import type { AggregatedStep } from "@/app/chat/step-aggregate";
import { cleanErrorDetail } from "@/app/chat/error-detail";

// 时长徽章只在 ≥3s 时显示,避免每个快速步骤都挂毫秒级噪声
const STEP_DURATION_FLOOR_MS = 3000;

const CODE_PLUGINS: PluggableList = [rehypeHighlight];

// 图片扩展名集合，用于缩略图判断
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|svg)$/i;

/** 判断路径是否为图片 */
function isImagePath(p: string): boolean {
  return Boolean(p && IMAGE_EXT.test(p));
}

// 工具类型 → 图标(代替"运行 Python / 调用技能"等文案)+ 可剥的中文前缀。
type IconSpec = typeof CommandLineIcon;
// strip:剥掉类型动词前缀(图标已表达);relabel:剥空后用此固定文案兜底(而非只剩图标)。
const TOOL_VISUAL: Record<string, { icon: IconSpec; strip?: RegExp; relabel?: string }> = {
  // run_python 只剥前缀动词,保留后续业务描述(如"处理《X》");裸"执行 Python"剥空后兜底 relabel。
  run_python: { icon: CommandLineIcon, strip: /^(?:运行|执行) Python[:：]?\s*/, relabel: "运行代码" },
  Bash:       { icon: CommandLineIcon, strip: /^执行[:：]?\s*/ },
  Skill:      { icon: FlashIcon,       strip: /^调用技能[:：]?\s*/ },
  Write:      { icon: PencilEdit01Icon, strip: /^写入\s*/ },
  Edit:       { icon: PencilEdit01Icon, strip: /^编辑\s*/ },
  MultiEdit:  { icon: PencilEdit01Icon, strip: /^编辑\s*/ },
  Read:       { icon: File01Icon, strip: /^读取\s*/ },
  read_file:  { icon: File01Icon, strip: /^读取资料[:：]?\s*/ },
  WebSearch:  { icon: InternetIcon, strip: /^搜索/ },
  WebFetch:   { icon: InternetIcon, strip: /^获取\s*/ },
  Grep:       { icon: Search01Icon, strip: /^搜索/ },
  Glob:       { icon: Search01Icon, strip: /^查找文件\s*/ },
  search_knowledge: { icon: Search01Icon, strip: /^检索知识库[:：]?\s*/ },
  query_knowledge:  { icon: Search01Icon, strip: /^查询知识库[:：]?\s*/ },
  AskUserQuestion:  { icon: HelpCircleIcon, strip: /^询问[:：]?\s*/ },
  spawn_subagent:   { icon: FlashIcon, strip: /^执行子任务[:：]?\s*/ },
  remember_convention: { icon: File01Icon },
};
const FINANCE_TOOLS = /payroll|reimbursement|reconcile|business|expense_policy|invoice/i;
function toolVisual(name: string): { icon: IconSpec; strip?: RegExp; relabel?: string } {
  return TOOL_VISUAL[name] ?? (FINANCE_TOOLS.test(name) ? { icon: Calculator01Icon } : { icon: CommandLineIcon });
}

// 把路径/文件名这类技术 token 嵌成等宽小芯片(参考 Claude Code 的行内 code 风格),人话里更分得清。
const STEP_TOKEN = /(\S*\/[^\s。,、]+|\b[\w-]+\.[a-zA-Z]{1,6}\b)/g;
function renderStepText(text: string): React.ReactNode {
  const parts = text.split(STEP_TOKEN);
  return parts.map((p, i) =>
    p && /(\/|\.[a-zA-Z]{1,6}$)/.test(p)
      ? <code key={i} className="rounded bg-foreground/[0.07] px-1 py-px font-mono text-meta">{p}</code>
      : p
  );
}

// HighlightBlock:展开面板的代码高亮块(有语言才上色)
function HighlightBlock({ lang, text }: { lang: string; text: string }) {
  const md = "```" + lang + "\n" + text + "\n```";
  return (
    <div className="md-content text-small [&_pre]:my-0 [&_pre]:max-h-64 [&_pre]:overflow-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={CODE_PLUGINS}>{md}</ReactMarkdown>
    </div>
  );
}

// PlainBlock:无法识别语言时的纯文本块。复用与 HighlightBlock 完全相同的 .md-content pre 容器
// + 给 code 挂 hljs 基色(亮/暗都跟主题),使背景/字体/字色与高亮块一致,只是没有语法配色;
// 错误输出整体走告警色。
function PlainBlock({ text, error }: { text: string; error?: boolean }) {
  return (
    <div className="md-content text-small [&_pre]:my-0 [&_pre]:max-h-64 [&_pre]:overflow-auto">
      <pre><code className="hljs" style={error ? { color: "var(--tone-alarm)" } : undefined}>{text}</code></pre>
    </div>
  );
}

/** 思考步骤行:折叠标题固定显示「思考」+ 时长徽章；原文进入展开详情。
 *  星芒是流动的:只有该行是当前进行中的尾巴(active)才亮动画星芒,处理完图标即消失(留空槽对齐)。 */
export function ThinkingStep({ content, active = false }: { content: string; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // spec 3b: 标题固定「思考」，不展示模型原文首行（统一与 Claude 行为一致）
  const title = "思考";
  return (
    <div className="w-full">
      <button
        className="group flex w-full items-center gap-2 py-0.5 text-body text-left cursor-pointer transition-colors"
        type="button"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="inline-flex shrink-0 w-4 h-4 items-center justify-center text-muted-foreground">
          {/* 进行中=流动星芒;完成态=安静小圆点(非旋转、明确不是"工作中"),给思考行一个左锚点,
              使它读作"动作之间的旁白"而非缺了图标的错位文字。 */}
          {active
            ? <ThinkingSpark size={13} speed="1.0s" />
            : <span className="w-[5px] h-[5px] rounded-full bg-muted-foreground/45" />}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            active ? "fa-shimmer-text" : "text-muted-foreground group-hover:text-foreground transition-colors"
          )}
          title={title}
        >
          {title}
        </span>
        {/* spec 2: chevron 默认隐藏，hover/focus 显现；触屏兜底 */}
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="inline-flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
        >
          <HugeiconsIcon icon={ChevronRightIcon} size={14} className="text-muted-foreground/70" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.22, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.18 } }}
            style={{ overflow: "hidden" }}
            className="px-2 pb-1"
          >
            {/* spec 3b: 展开详情展示原文，走 small 号 + 弱化色 */}
            <div className="md-content" style={{ fontSize: "var(--text-small)", color: "var(--muted-foreground)" }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type ToolPair = {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  startedAt?: number;
  structured?: unknown;
  status: "running" | "done" | "error";
};

/** 运行中实时跳秒:从 startedAt 起每秒刷新 now,结束(startedAt 清空)即停。 */
function useLiveElapsed(startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt == null ? 0 : Math.max(0, now - startedAt);
}

/** 展开详情区：错误内容经 cleanErrorDetail 剥壳；成功输出原样格式化。
 *  spec 12: read_document/Read 目标为图片时顶部内联缩略图（依赖现有 /api/files 路由）。
 *  conversationId 未知时降级为路径 chip。 */
function ExpandedDetail({
  pair,
  conversationId,
}: {
  pair: ToolPair;
  conversationId?: string;
}) {
  // spec 12: 判断是否为图片路径
  const filePath =
    pair.name === "read_document" ? String((pair.input as Record<string, unknown>)?.filePath ?? "") :
    pair.name === "Read" ? String((pair.input as Record<string, unknown>)?.file_path ?? "") :
    "";
  const showThumbnail = isImagePath(filePath);
  // 路由：/api/files/[conversationId]/[...filename]
  // 依赖现有路由；若无 conversationId 则降级为路径 chip
  const imgSrc = showThumbnail && conversationId
    ? `/api/files/${encodeURIComponent(conversationId)}/${filePath.replace(/^\//, "")}`
    : null;

  return (
    <>
      {/* spec 12: 图片缩略图（顶部） */}
      {showThumbnail && (
        <div className="mb-1.5">
          {imgSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt={filePath.split(/[/\\]/).pop() ?? ""}
              className="max-h-32 max-w-full rounded border border-border/40 object-contain"
            />
          ) : (
            // 降级：路径 chip（无可用路由）
            <code className="rounded bg-foreground/[0.07] px-1.5 py-0.5 font-mono text-small text-muted-foreground">
              {filePath}
            </code>
          )}
        </div>
      )}

      {pair.input != null && (() => {
        const fmt = formatToolInput(pair.name, pair.input);
        return (
          <div className="mb-1">
            <span className="text-small uppercase tracking-wide text-muted-foreground">输入</span>
            {"lang" in fmt ? (
              <div className="mt-0.5"><HighlightBlock lang={fmt.lang} text={fmt.text} /></div>
            ) : (
              <div className="mt-0.5"><PlainBlock text={fmt.plain} /></div>
            )}
          </div>
        );
      })()}

      {pair.result != null && (() => {
        const sliced = pair.result.slice(0, 6000);
        if (pair.isError) {
          // spec 6: 错误详情经 cleanErrorDetail 剥壳
          const { headline, body } = cleanErrorDetail(sliced);
          return (
            <div>
              <span className="text-small uppercase tracking-wide" style={{ color: "var(--tone-alarm)" }}>
                错误
              </span>
              {/* headline 首行显示（保留「错误」标签样式） */}
              {headline !== body && (
                <div className="mt-0.5 text-small" style={{ color: "var(--tone-alarm)" }}>{headline}</div>
              )}
              <div className="mt-0.5"><PlainBlock text={body} error /></div>
            </div>
          );
        }
        const fmt = formatToolOutput(pair.name, sliced);
        return (
          <div>
            <span className="text-small uppercase tracking-wide">输出</span>
            {"plain" in fmt ? (
              <div className="mt-0.5"><PlainBlock text={fmt.plain} /></div>
            ) : (
              <div className="mt-0.5"><HighlightBlock lang={fmt.lang} text={fmt.text} /></div>
            )}
          </div>
        );
      })()}
    </>
  );
}

function ToolCallStep({ pair, degraded = false }: { pair: ToolPair; degraded?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // 日常:每步只一行人话、不可展开;技术模式:可点开看原始输入/输出(调试用)。
  const roleMode = useRoleMode();
  const hasDetail = roleMode === "tech" && Boolean(pair.input || pair.result);
  const running = pair.status === "running";
  const isError = pair.status === "error";
  // spec 4: degraded（已恢复的单个失败步）灰显，不用 tone-alarm
  const isDegraded = degraded && isError;
  // 文案与折叠摘要共用 stepDisplayText(剥动词前缀/错误前缀,口径一致);行图标已移除(仅运行中星芒)。
  const text = stepDisplayText(pair);
  const liveElapsed = useLiveElapsed(running ? pair.startedAt : undefined);

  return (
    <div className="w-full">
      <button
        className={cn(
          "group flex w-full items-center gap-2 py-0.5 text-body text-left transition-colors",
          hasDetail ? "cursor-pointer" : "cursor-default"
        )}
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        {/* 每行一个类型图标是视觉噪音(Claude 过程行几乎无图标):仅运行中保留星芒,静止行无图标 */}
        {running ? (
          <span className="inline-flex shrink-0 w-4 h-4 items-center justify-center" style={{ color: "var(--muted-foreground)" }}>
            <ThinkingSpark size={13} speed="1.0s" />
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate",
            running ? "fa-shimmer-text"
              : (isError && !isDegraded) ? ""
              : "text-muted-foreground group-hover:text-foreground transition-colors"
          )}
          style={isError && !isDegraded ? { color: "var(--tone-alarm)" } : undefined}
          title={text}
        >
          {renderStepText(text)}
        </span>
        {/* spec 4: 已恢复标注 */}
        {isDegraded && (
          <span className="shrink-0 text-small text-muted-foreground/70">已恢复</span>
        )}
        {/* spec 2: chevron 默认隐藏，hover/focus 显现；触屏兜底 */}
        {hasDetail && (
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.18 }}
            className="inline-flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
          >
            <HugeiconsIcon icon={ChevronRightIcon} size={14} className="text-muted-foreground/70" />
          </motion.span>
        )}
        {running && liveElapsed >= 1000 && (
          <span className="shrink-0 tabular-nums text-primary/70">{formatMs(liveElapsed)}</span>
        )}
        {pair.durationMs != null && pair.durationMs >= STEP_DURATION_FLOOR_MS && pair.status !== "running" && (
          <span className="shrink-0 tabular-nums text-muted-foreground/60">{formatMs(pair.durationMs)}</span>
        )}
      </button>

      <ToolResultCard name={pair.name} structured={pair.structured} />

      <AnimatePresence initial={false}>
        {expanded && hasDetail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.22, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.18 } }}
            style={{ overflow: "hidden" }}
            className="px-2 pb-1"
          >
            <ExpandedDetail pair={pair} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** retry-group 行：工具重试聚合渲染。
 *  spec 4: recovered=true 时整行灰显+「已恢复」，不用红色；recovered=false 保持红色。
 *  展开显示组内逐步明细（复用 ToolCallStep）。*/
function RetryGroupRow({
  group,
}: {
  group: Extract<AggregatedStep, { kind: "retry-group" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { label, count, recovered, items } = group;
  const displayLabel = `${label}`;  // label 已含「×N」
  void count; // count 已编码进 label

  // 展开内的子步骤：从 items 重建最简 ToolPair
  const subPairs = buildPairs(items, true);

  return (
    <div className="w-full">
      <button
        className="group flex w-full items-center gap-2 py-0.5 text-body text-left cursor-pointer transition-colors"
        type="button"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className={cn(
            "min-w-0 truncate",
            recovered
              ? "text-muted-foreground group-hover:text-foreground transition-colors"
              : ""
          )}
          style={!recovered ? { color: "var(--tone-alarm)" } : undefined}
          title={displayLabel}
        >
          {displayLabel}
        </span>
        {/* spec 4: 已恢复尾缀 */}
        {recovered && (
          <span className="shrink-0 text-small text-muted-foreground/70">已恢复</span>
        )}
        {/* spec 2: chevron 默认隐藏，hover/focus 显现 */}
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="inline-flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
        >
          <HugeiconsIcon icon={ChevronRightIcon} size={14} className="text-muted-foreground/70" />
        </motion.span>
      </button>

      {/* 展开：组内逐步明细 */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { duration: 0.22, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.18 } }}
            style={{ overflow: "hidden" }}
            className="pl-6 py-0.5"
          >
            <div className="flex flex-col gap-0.5">
              {subPairs.map((p) => (
                <ToolCallStep key={p.id} pair={p} degraded={recovered} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type TimelineItem = {
  id: string;
  event: {
    type: string;
    id?: string;
    toolUseId?: string;
    name?: string;
    input?: unknown;
    content?: string;
    isError?: boolean;
    durationMs?: number;
    structured?: unknown;
    subtype?: string;
    message?: string;
  };
  createdAt: number;
};

function buildPairs(timeline: TimelineItem[], finalizeDangling: boolean): ToolPair[] {
  const pairs: ToolPair[] = [];
  const pendingById = new Map<string, ToolPair>();

  for (const item of timeline) {
    const ev = item.event;
    if (ev.type === "tool_use") {
      const pair = {
        id: item.id,
        name: ev.name ?? "tool",
        input: ev.input,
        startedAt: item.createdAt,
        status: "running",
      } satisfies ToolPair;
      pairs.push(pair);
      if (ev.id) pendingById.set(ev.id, pair);
    } else if (ev.type === "tool_result") {
      const name = ev.name ?? "";
      const byId = ev.toolUseId ? pendingById.get(ev.toolUseId) : null;
      // 无 toolUseId 的回退配对取最早的同名 running(FIFO):结果按发起顺序到达,
      // 取最晚(LIFO)会在同名并发时把首个结果配给第二次调用,留下永远 running 的孤儿行。
      const match = byId ?? pairs.find((p) => {
        if (p.status !== "running") return false;
        return name ? p.name === name : true;
      });
      if (match) {
        match.result = ev.content;
        match.isError = ev.isError;
        match.durationMs = ev.durationMs;
        match.structured = ev.structured;
        match.status = ev.isError ? "error" : "done";
        if (ev.toolUseId) pendingById.delete(ev.toolUseId);
      } else {
        pairs.push({
          id: item.id,
          name,
          result: ev.content,
          isError: ev.isError,
          durationMs: ev.durationMs,
          structured: ev.structured,
          status: ev.isError ? "error" : "done",
        });
      }
    }
  }

  if (finalizeDangling) {
    for (const pair of pairs) {
      if (pair.status === "running") pair.status = "done";
    }
  }

  return pairs;
}

/** 单步的人话展示文案(图标已表达动词时剥前缀;失败保留"错误：…")。摘要与列表共用,口径一致。 */
function stepDisplayText(pair: ToolPair): string {
  const summary = getToolSummary(pair.name, pair.input, pair.result, pair.isError);
  // 失败步去掉"错误："前缀——列表里靠红色表达错误,文字不再重复
  if (pair.status === "error") return summary.replace(/^错误[:：]\s*/, "");
  const visual = toolVisual(pair.name.replace(/^mcp__\w+__/, ""));
  let text = summary;
  if (visual.strip) text = summary.replace(visual.strip, "");
  text = text.replace(/[「『」』]/g, "").trim();
  return text || visual.relabel || summary;
}

export function ToolStepList({
  timeline,
  isActive,
  laterTimeline,
}: {
  timeline: TimelineItem[];
  isActive: boolean;
  /** 本回合中位于该段之后的事件:跨段判定失败是否已被后续成功覆盖(已恢复→灰显) */
  laterTimeline?: TimelineItem[];
}) {
  const toolItems = timeline.filter(
    (t) => t.event.type === "tool_use" || t.event.type === "tool_result"
  );

  // spec 4: 过 aggregateToolSegment 聚合失败重试(laterTimeline 提供跨段恢复信号)
  const aggregated = aggregateToolSegment(toolItems, laterTimeline ?? []);
  if (!aggregated.length) return null;

  // spec 3c/7: 段级摘要（灰字组摘要，当 tools 段无前置 text 叙事时提示）
  // 取舍说明：ToolStepList 不感知前置段是否存在 text 叙事（那层在 chat-page 里），
  // 因此保守实现：当 aggregated.length >= 3（多步才有摘要价值）时在段首加灰字摘要。
  // 若调用方已有叙事段，此摘要与叙事重复；但重复度低（摘要简短），可接受。
  const summary = aggregated.length >= 3 ? summarizeToolSegment(toolItems) : "";

  // spec 4: 将 aggregated 结果转为子步骤渲染
  const pairs = buildPairs(toolItems, !isActive);

  const rows = aggregated.map((agg, idx) => {
    if (agg.kind === "retry-group") {
      return <RetryGroupRow key={`group-${idx}`} group={agg} />;
    }
    // kind:"step"
    // 从 pairs 找对应的 ToolPair（按 item.id 匹配）
    const pair = pairs.find((p) => p.id === agg.item.id);
    if (!pair) return null;
    return <ToolCallStep key={pair.id} pair={pair} degraded={agg.degraded} />;
  });

  // 已完成的多步段默认收成一行摘要(带对象与统计),点开才见逐步明细——密度对齐 Claude 的
  // "一句话+折叠动作组"。进行中的段保持实时逐行,当前动作必须可见。
  if (!isActive && aggregated.length >= 2) {
    return (
      <details className="flex flex-col gap-0.5">
        <summary className="group flex w-full items-center gap-2 py-0.5 text-body text-left cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors">
          <span className="min-w-0 truncate">{summarizeToolSegment(toolItems)}</span>
          <HugeiconsIcon
            icon={ChevronRightIcon}
            size={14}
            className="details-chevron shrink-0 text-muted-foreground/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
          />
        </summary>
        <div className="flex flex-col gap-0.5 pl-3">{rows}</div>
      </details>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {/* 进行中的段:段摘要灰字提示 + 实时逐行 */}
      {isActive && summary && (
        <div className="text-small text-muted-foreground/60 pb-0.5 select-none">{summary}</div>
      )}
      {rows}
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
