"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Search01Icon,
  CommandLineIcon,
  File01Icon,
  PencilEdit01Icon,
  NoteIcon,
  HelpSquareIcon,
  Calculator01Icon,
} from "@hugeicons/core-free-icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
import { EASE_OUT_QUICK } from "@/app/shared/motion-presets";

// 时长徽章只在 ≥3s 时显示,避免每个快速步骤都挂毫秒级噪声
const STEP_DURATION_FLOOR_MS = 3000;

const CODE_PLUGINS: PluggableList = [rehypeHighlight];

// 图片扩展名集合，用于缩略图判断
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif|svg)$/i;

/** 判断路径是否为图片 */
function isImagePath(p: string): boolean {
  return Boolean(p && IMAGE_EXT.test(p));
}

/** filePath 多为绝对路径（read_document 约定）；路由只认相对会话目录的尾段。
 *  定位 /conversations/<id>/ 之后的相对段；绝对路径里找不到标记则返回 null（降级 chip，不把本机路径塞进 URL）。 */
function conversationRelativePath(filePath: string, conversationId: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = `/conversations/${conversationId}/`;
  const idx = normalized.indexOf(marker);
  if (idx >= 0) return normalized.slice(idx + marker.length);
  if (!normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized)) return normalized; // 已是相对路径
  return null;
}

// 工具类型 → 可剥的中文动词前缀(行图标已移除,组头/renderer 文案承担类型语义)。
// strip:剥掉类型动词前缀;relabel:剥空后用此固定文案兜底。
const TOOL_VISUAL: Record<string, { strip?: RegExp; relabel?: string }> = {
  analyze_tabular: { strip: /^整理表格数据(?:（[^）]+）)?[:：]?\s*/ },
  bash:       { strip: /^执行[:：]?\s*/ },
  write:      { strip: /^写入\s*/ },
  edit:       { strip: /^编辑\s*/ },
  read:       { strip: /^读取\s*/ },
  grep:       { strip: /^搜索/ },
  find:       { strip: /^查找文件\s*/ },
  ls:         { strip: /^查看目录\s*/ },
  search_knowledge: { strip: /^检索知识库[:：]?\s*/ },
  AskUserQuestion:  { strip: /^询问[:：]?\s*/ },
  spawn_subagent:   { strip: /^执行子任务[:：]?\s*/ },
  // 单据→凭证系:组头已带动词(「匹配科目 ×8」),子行剥前缀只留对象,避免逐行重复
  query_kingdee_accounts: { strip: /^查询金蝶科目[表]?\s*/ },
  scan_slip_folder:       { strip: /^扫描单据文件夹\s*/ },
  read_document:          { strip: /^识别单据\s*/ },
};
function toolVisual(name: string): { strip?: RegExp; relabel?: string } {
  return TOOL_VISUAL[name] ?? {};
}

// 动作家族 → 淡色小图标(参考 Claude:图标不缺席,但按类型归并到 6 个家族,
// 同族连续行共用同一图标 → 有结构感又不"碎")。默认回落文档图标。
const STEP_ICON_BY_FAMILY: Record<string, IconSvgElement> = {
  search: Search01Icon,     // 检索/查询/grep/web 搜索/科目匹配
  command: CommandLineIcon, // Bash / fixed command tools
  read: File01Icon,         // 读取文件/识别单据/抓取网页
  write: PencilEdit01Icon,  // 写入/编辑
  skill: NoteIcon,          // 技能/子代理
  ask: HelpSquareIcon,      // 询问用户
  finance: Calculator01Icon,// 金额核对等财务动作
};

const TOOL_FAMILY: Record<string, keyof typeof STEP_ICON_BY_FAMILY> = {
  search_knowledge: "search", grep: "search", find: "search",
  query_kingdee_accounts: "search",
  bash: "command", analyze_tabular: "finance",
  generate_business_analysis: "finance",
  read: "read", ls: "read", read_document: "read", scan_slip_folder: "read",
  write: "write", edit: "write", patch_workbook: "write", finalize_deliverable: "write",
  spawn_subagent: "skill",
  AskUserQuestion: "ask",
};

/** 工具事件可能带有多个命名空间(例如 mcp__finance_worker__Read),图标只按最终工具名归类。 */
function bareToolName(name: string): string {
  return name.replace(/^.*__/, "");
}

// 有家族图标返回之,无则返回 null(是否补节点由 StepIcon 按 threaded 决定)。
function stepIcon(name: string): IconSvgElement | null {
  const bare = bareToolName(name);
  const family = TOOL_FAMILY[bare];
  return family ? STEP_ICON_BY_FAMILY[family] : null;
}

/** 行首节点:有家族图标就渲染淡色小图标。无图标时——
 *  子步骤(threaded)串在连接线上,补一个大实心圆点作节点;
 *  非子步骤(顶层行,无连接线)保持原样,回落文档图标,不加圆点。 */
function StepIcon({ name, className, threaded = false }: { name: string; className?: string; threaded?: boolean }) {
  const icon = stepIcon(name);
  if (icon) return <HugeiconsIcon icon={icon} size={13} className={className} />;
  if (threaded) return <span className="block h-2 w-2 rounded-full bg-foreground" aria-hidden="true" />;
  return <HugeiconsIcon icon={File01Icon} size={13} className={className} />;
}

// 把路径/文件名这类技术 token 嵌成等宽小芯片(参考 Claude Code 的行内 code 风格),人话里更分得清。
const STEP_TOKEN = /(\S*\/[^\s。,、]+|\b[\w-]+\.[a-zA-Z]{1,6}\b)/g;
function renderStepText(text: string): React.ReactNode {
  const parts = text.split(STEP_TOKEN);
  return parts.map((p, i) =>
    p && /(\/|\.[a-zA-Z]{1,6}$)/.test(p)
      // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
      ? <code key={i} className="rounded bg-foreground/[0.07] px-1 py-px font-mono text-meta">{p}</code>
      : p
  );
}

// HighlightBlock:展开面板的代码高亮块(有语言才上色)
function HighlightBlock({ lang, text, bare = false }: { lang: string; text: string; bare?: boolean }) {
  const md = "```" + lang + "\n" + text + "\n```";
  return (
    <div className={cn("md-content text-small [&_pre]:my-0 [&_pre]:max-h-none [&_pre]:overflow-visible", bare && "md-content-bare") }>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={CODE_PLUGINS}>{md}</ReactMarkdown>
    </div>
  );
}

// PlainBlock:无法识别语言时的纯文本块。复用与 HighlightBlock 完全相同的 .md-content pre 容器
// + 给 code 挂 hljs 基色(亮/暗都跟主题),使背景/字体/字色与高亮块一致,只是没有语法配色;
// 错误输出整体走告警色。
function PlainBlock({ text, error, bare = false }: { text: string; error?: boolean; bare?: boolean }) {
  return (
    <div className={cn("md-content text-small [&_pre]:my-0 [&_pre]:max-h-none [&_pre]:overflow-visible", bare && "md-content-bare") }>
      <pre><code className="hljs" style={error ? { color: "var(--tone-alarm)" } : undefined}>{text}</code></pre>
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
  // filePath 为绝对路径时用 conversationRelativePath 提取相对段；找不到则降级 chip
  const relPath = showThumbnail && conversationId ? conversationRelativePath(filePath, conversationId) : null;
  const imgSrc = relPath
    ? `/api/files/${encodeURIComponent(conversationId!)}/${relPath.split("/").map(encodeURIComponent).join("/")}`
    : null;

  return (
    <div className="tool-detail-scroll max-h-64 overflow-y-scroll">
      {/* spec 12: 图片缩略图（顶部） */}
      {showThumbnail && (
        <div className="mb-1.5">
          {imgSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt={filePath.split(/[/\\]/).pop() ?? ""}
              // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
              className="max-h-32 max-w-full rounded border border-border/40 object-contain"
            />
          ) : (
            // 降级：路径 chip（无可用路由）
            // eslint-disable-next-line no-restricted-syntax -- 交互元素豁免，WP8a 规则
            <code className="rounded bg-foreground/[0.07] px-1.5 py-0.5 font-mono text-small text-muted-foreground">
              {filePath}
            </code>
          )}
        </div>
      )}

      {pair.input != null && (() => {
        const fmt = formatToolInput(pair.name, pair.input);
        return (
          <div className="mb-3">
            {"lang" in fmt ? (
              <HighlightBlock lang={fmt.lang} text={fmt.text} bare />
            ) : (
              <PlainBlock text={fmt.plain} bare />
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
              <span className="text-small" style={{ color: "var(--tone-alarm)" }}>
                错误
              </span>
              {/* headline 首行显示（保留「错误」标签样式） */}
              {headline !== body && (
                <div className="mt-0.5 text-small" style={{ color: "var(--tone-alarm)" }}>{headline}</div>
              )}
              <div className="mt-0.5"><PlainBlock text={body} error bare /></div>
            </div>
          );
        }
        const fmt = formatToolOutput(pair.name, sliced);
        return (
          <div>
            {"plain" in fmt ? (
              <PlainBlock text={fmt.plain} bare />
            ) : (
              <HighlightBlock lang={fmt.lang} text={fmt.text} bare />
            )}
          </div>
        );
      })()}
    </div>
  );
}

function DetailMotion({ open, className, children }: { open: boolean; className?: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return <AnimatePresence initial={false}>{open ? (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px) scale(0.99)" }}
      animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px) scale(0.99)" }}
      transition={EASE_OUT_QUICK}
      className={className}
    >{children}</motion.div>
  ) : null}</AnimatePresence>;
}

function ToolCallStep({ pair, degraded = false, threaded = false, inCard = false, detailCard = false, conversationId }: { pair: ToolPair; degraded?: boolean; threaded?: boolean; inCard?: boolean; detailCard?: boolean; conversationId?: number | null }) {
  const [expanded, setExpanded] = useState(false);
  const reduce = useReducedMotion();
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
    <div className={cn("w-full", inCard && "px-3 py-2")}>
      <button
        className={cn(
          "group flex w-full items-center gap-2 py-1 text-body text-left transition-colors",
          hasDetail ? "cursor-pointer" : "cursor-default"
        )}
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        {/* 每行一个类型图标是视觉噪音(Claude 过程行几乎无图标):仅运行中保留星芒,静止行无图标 */}
        {/* 运行中→星芒;否则→淡色家族图标(与竖线对齐,给过程行结构感) */}
        <span
          className="fa-node inline-flex shrink-0 w-4 h-4 items-center justify-center"
          style={{ color: isError && !isDegraded ? "var(--tone-alarm)" : "var(--muted-foreground)" }}
        >
          {running
            ? <ThinkingSpark size={13} speed="1.0s" />
            : <StepIcon name={pair.name} className="opacity-70" threaded={threaded} />}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            running ? "shimmer shimmer-color-primary text-muted-foreground"
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
            className="inline-flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
          >
            <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={14} className="text-muted-foreground/70" />
          </motion.span>
        )}
        {running && liveElapsed >= 1000 && (
          <span className="shrink-0 text-meta tabular-nums text-primary/70">{formatMs(liveElapsed)}</span>
        )}
        {pair.durationMs != null && pair.durationMs >= STEP_DURATION_FLOOR_MS && pair.status !== "running" && (
          <span className="shrink-0 text-meta tabular-nums text-muted-foreground/60">{formatMs(pair.durationMs)}</span>
        )}
      </button>

      <ToolResultCard name={pair.name} structured={pair.structured} />

      <DetailMotion
        open={expanded && hasDetail}
        className={cn(
          "mt-1 px-3 pb-1",
          detailCard && "overflow-hidden rounded-xl border border-border bg-card py-2",
        )}
      >
        <ExpandedDetail pair={pair} conversationId={conversationId != null ? String(conversationId) : undefined} />
      </DetailMotion>
    </div>
  );
}

/** retry-group 行：工具重试聚合渲染。
 *  spec 4: recovered=true 时整行灰显+「已恢复」，不用红色；recovered=false 保持红色。
 *  展开显示组内逐步明细（复用 ToolCallStep）。*/
function RetryGroupRow({
  group,
  threaded = false,
  conversationId,
}: {
  group: Extract<AggregatedStep, { kind: "retry-group" }>;
  threaded?: boolean;
  conversationId?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { label, count, recovered, items } = group;
  const displayLabel = `${label}`;  // label 已含「×N」
  void count; // count 已编码进 label

  // 展开内的子步骤：从 items 重建最简 ToolPair
  const subPairs = buildPairs(items, true);

  return (
    <div className="w-full px-3 py-2">
      <button
        className="group flex w-full items-center gap-2 py-1 text-body text-left cursor-pointer transition-colors"
        type="button"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className="fa-node inline-flex shrink-0 w-4 h-4 items-center justify-center"
          style={{ color: recovered ? "var(--muted-foreground)" : "var(--tone-alarm)" }}
        >
          <StepIcon name={group.toolName} className="opacity-70" threaded={threaded} />
        </span>
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
          className="inline-flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
        >
          <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={14} className="text-muted-foreground/70" />
        </motion.span>
      </button>

      {/* 展开：组内逐步明细 */}
      <DetailMotion open={expanded} className="mt-1 overflow-hidden rounded-xl border border-border bg-card">
            <div className="divide-y divide-border/70">
              {subPairs.map((p) => (
                <ToolCallStep key={p.id} pair={p} degraded={recovered} inCard conversationId={conversationId} />
              ))}
            </div>
      </DetailMotion>
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
  const visual = toolVisual(bareToolName(pair.name));
  let text = summary;
  if (visual.strip) text = summary.replace(visual.strip, "");
  text = text.replace(/[「『」』]/g, "").trim();
  return text || visual.relabel || summary;
}

export function ToolStepList({
  timeline,
  isActive,
  laterTimeline,
  conversationId,
}: {
  timeline: TimelineItem[];
  isActive: boolean;
  /** 本回合中位于该段之后的事件:跨段判定失败是否已被后续成功覆盖(已恢复→灰显) */
  laterTimeline?: TimelineItem[];
  conversationId?: number | null;
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
  const rowsInCard = !isActive && aggregated.length >= 2;

  // threaded = 折叠成 fa-thread 时间线的分支(见下)。仅该分支的行首无图标才补大圆点节点;
  //           顶层实时行(非 fa-thread)保持原样,无图标回落文档图标、不加圆点。
  const rows = aggregated.map((agg, idx) => {
    if (agg.kind === "retry-group") {
      return <RetryGroupRow key={`group-${idx}`} group={agg} conversationId={conversationId} />;
    }
    // kind:"step"
    // 从 pairs 找对应的 ToolPair（按 item.id 匹配）
    const pair = pairs.find((p) => p.id === agg.item.id);
    if (!pair) return null;
    return <ToolCallStep key={pair.id} pair={pair} degraded={agg.degraded} inCard={rowsInCard} detailCard={!isActive && aggregated.length === 1} conversationId={conversationId} />;
  });

  // 所有工具段默认只显示正文流中的一行摘要，点开后才在下方出现详情卡。
  // 多步骤共享一张详情卡，卡内用分隔线区分每个步骤；避免摘要本身看起来像卡片。
  if (!isActive && aggregated.length >= 2) {
    return (
      <details className="details-fold flex flex-col">
        <summary className="group flex w-full items-center gap-2 py-1 text-body text-left cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors">
          <span className="min-w-0 truncate">{summarizeToolSegment(toolItems)}</span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={14}
            className="details-chevron details-chevron-closed shrink-0 text-muted-foreground/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
          />
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={14}
            className="details-chevron details-chevron-open shrink-0 text-muted-foreground/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity"
          />
        </summary>
        <div className="mt-1 overflow-hidden rounded-xl border border-border bg-card divide-y divide-border/70">{rows}</div>
      </details>
    );
  }

  return (
    <div className="w-full">
      {/* 进行中的段:段摘要灰字提示 + 实时逐行 */}
      {isActive && summary && (
        <div className="px-3 pt-2.5 text-small text-muted-foreground/60 select-none">{summary}</div>
      )}
      <div className={cn("divide-y divide-border/70", isActive && summary && "mt-1")}>{rows}</div>
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
