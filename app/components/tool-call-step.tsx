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

// 时长徽章只在 ≥3s 时显示,避免每个快速步骤都挂毫秒级噪声
const STEP_DURATION_FLOOR_MS = 3000;

const CODE_PLUGINS: PluggableList = [rehypeHighlight];

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
  read_file:  { icon: File01Icon, strip: /^读取(?:知识库文件)?\s*/ },
  WebSearch:  { icon: InternetIcon, strip: /^搜索/ },
  WebFetch:   { icon: InternetIcon, strip: /^获取\s*/ },
  Grep:       { icon: Search01Icon, strip: /^搜索/ },
  Glob:       { icon: Search01Icon, strip: /^查找文件\s*/ },
  search_knowledge: { icon: Search01Icon, strip: /^检索知识库/ },
  query_knowledge:  { icon: Search01Icon, strip: /^知识库命令检索[:：]?\s*/ },
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

function ToolCallStep({ pair }: { pair: ToolPair }) {
  const [expanded, setExpanded] = useState(false);
  // 日常:每步只一行人话、不可展开;技术模式:可点开看原始输入/输出(调试用)。
  const roleMode = useRoleMode();
  const hasDetail = roleMode === "tech" && Boolean(pair.input || pair.result);
  const running = pair.status === "running";
  const isError = pair.status === "error";
  // 图标按工具类型;文案与折叠摘要共用 stepDisplayText(剥动词前缀/错误前缀,口径一致)。
  const visual = toolVisual(pair.name.replace(/^mcp__\w+__/, ""));
  const text = stepDisplayText(pair);
  const liveElapsed = useLiveElapsed(running ? pair.startedAt : undefined);

  return (
    <div className="w-full">
      <button
        className={cn(
          "group flex w-full items-center gap-2 py-0.5 text-small text-left transition-colors",
          hasDetail ? "cursor-pointer" : "cursor-default"
        )}
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
      >
        <span
          className="inline-flex shrink-0 w-4 h-4 items-center justify-center"
          style={{ color: isError ? "var(--tone-alarm)" : "var(--muted-foreground)" }}
        >
          {running ? <ThinkingSpark size={13} speed="1.0s" /> : <HugeiconsIcon icon={visual.icon} size={13} />}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            running ? "fa-shimmer-text" : isError ? "" : "text-muted-foreground group-hover:text-foreground transition-colors"
          )}
          style={isError ? { color: "var(--tone-alarm)" } : undefined}
          title={text}
        >
          {renderStepText(text)}
        </span>
        {hasDetail && (
          <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.18 }} className="inline-flex shrink-0">
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
              // 展示给用户的上限(技术模式展开时):比给模型的小得多——用户只是瞄一眼这步干了啥;
              // 外层 <pre> 已是 max-h-64 滚动框,装不下会滚动,不会撑版面。
              const sliced = pair.result.slice(0, 6000);
              const fmt = pair.isError ? { plain: sliced } : formatToolOutput(pair.name, sliced);
              return (
                <div>
                  <span className="text-small uppercase tracking-wide" style={{ color: pair.isError ? "var(--tone-alarm)" : undefined }}>
                    {pair.isError ? "错误" : "输出"}
                  </span>
                  {"plain" in fmt ? (
                    <div className="mt-0.5"><PlainBlock text={fmt.plain} error={pair.isError} /></div>
                  ) : (
                    <div className="mt-0.5"><HighlightBlock lang={fmt.lang} text={fmt.text} /></div>
                  )}
                </div>
              );
            })()}
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
      const last = byId ?? [...pairs].reverse().find((p) => {
        if (p.status !== "running") return false;
        return name ? p.name === name : true;
      });
      if (last) {
        last.result = ev.content;
        last.isError = ev.isError;
        last.durationMs = ev.durationMs;
        last.structured = ev.structured;
        last.status = ev.isError ? "error" : "done";
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
}: {
  timeline: TimelineItem[];
  isActive: boolean;
}) {
  const toolItems = timeline.filter(
    (t) => t.event.type === "tool_use" || t.event.type === "tool_result"
  );
  const pairs = buildPairs(toolItems, !isActive);
  if (!pairs.length) return null;

  // 统一渲染:每步一行(人话摘要 + 走光指示),可展开看原始输入/输出(对所有人一致)。
  return (
    <div className="flex flex-col gap-0.5">
      {pairs.map((pair) => <ToolCallStep key={pair.id} pair={pair} />)}
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
