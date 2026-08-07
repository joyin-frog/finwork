import path from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { isDeliveredPath, isInsidePath } from "@/lib/agent/tools/path-policy";
import {
  FINWORK_READ_TOOL_NAMES,
  isFinworkBuiltinTool,
  type FinworkBuiltinRoots,
} from "@/lib/agent/pi/builtin-tools";
import type { AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import type { ReplayMessage } from "@/lib/agent/pi/history-replay";
import { extractCompactionFacts, formatFactsBlock } from "@/lib/agent/pi/compaction-facts";
import { createLogger } from "@/lib/runtime/logger";

const log = createLogger("pi-extension");

/**
 * Finwork 的 Pi extension —— 横切能力的落点（L1）。
 *
 * 为什么是 extension 而不是继续内联在 tool-adapter：Pi 的内置工具不经过 Finwork 的
 * tool-adapter，`tool_call` 是唯一能拦住它们的地方。ambient 扩展发现仍然关闭
 * （`noExtensions: true` 只压制磁盘发现，不影响内联 `extensionFactories`）。
 *
 * **本包故意不迁移财务工具的授权。** Pi 文档明确 `tool_call` 之后
 * "No re-validation is performed"，而财务工具的权威校验是 tool-adapter 里的
 * `z.parseAsync`（含 AR3b 的 `jsonCoercible` 预处理）。把风险判定挪到 Zod 之前，
 * 就会重演 AR3-spike E2b 记录过的那一类绕过。分工因此是：
 *
 * - 内置工具（read/write/edit/bash）：入参是裸字符串，闸在这里。
 * - 财务工具（45 个）：闸留在 tool-adapter，在 Zod 之后。
 */

export type FinworkExtensionContext = {
  roots: FinworkBuiltinRoots;
  emit?: (event: AgentRuntimeEvent) => void;
  /** 供 provider trace 归因；缺省时只记模型与状态。 */
  traceId?: string;
  /**
   * L3a：每回合刷新的系统提示词尾段（记忆/画像/日期/输出目录/负反馈）。
   * 静态前缀留在 ResourceLoader（只依赖公司名/Agent 名/roleMode，可缓存）；
   * 动态段走 `before_agent_start`，因此不再让整个 loader 每请求重建。
   */
  dynamicSystemContext?: () => string;
  /**
   * L3b：新 pi session 首轮要回放的历史。已恢复的 session 不传（历史在 session 文件里）。
   */
  replayHistory?: ReplayMessage[];
  /**
   * L8：压缩叙述生成器。缺省或抛错时回落 pi 自带摘要（fail-safe）。
   * 传入被压缩消息的纯文本，返回叙述性摘要。
   */
  summarizeForCompaction?: (texts: string[], signal?: AbortSignal) => Promise<string | undefined>;
};

/** 从 pi 消息里取纯文本；结构未知的一律跳过，不猜。 */
function extractTexts(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const b = block as { type?: unknown; text?: unknown };
    return b.type === "text" && typeof b.text === "string" ? [b.text] : [];
  });
}

/**
 * 值得单独记一笔的响应头。限流与重试归因全靠它们，而在此之前 Finwork 对 provider
 * 这一层完全没有可观测性——网关 429 只表现为「回合失败」。
 */
const TRACED_RESPONSE_HEADERS = [
  "retry-after",
  "x-request-id",
  "request-id",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
] as const;

/**
 * 明显破坏性的 shell 形态。照 pi `examples/extensions/permission-gate.ts` 的判据。
 *
 * **这不是 bash 的安全边界，只是给模型一句可读的早期反馈。** 真正的约束是
 * `tools/bash-sandbox.ts` 的 OS 沙箱：正则实测漏过 8/10（分开写 `-r -f`、改用
 * python、绝对路径重定向……全都绕过），任何在命令字符串上做匹配的方案都是如此。
 * 保留它是因为「拒绝执行破坏性命令」比内核抛的 `Operation not permitted` 更好懂，
 * 不是因为它拦得住。
 */
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b.*--force\b)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*\b777\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
];

// 全盘 find 不是财务任务的合法探查方式：它既浪费时间，也会在沙箱里遍历大量
// 无关路径。附件路径已由提示词明确给出；模型应在会话/附件只读根内读取。
const BROAD_DISCOVERY_PATTERNS = [
  /\bfind\s+(?:\/|~|\/Users(?:\/|\s)|\/System(?:\/|\s))/i,
  /\bfind\s+\$HOME(?:\/|\s|$)/i,
];

/**
 * 返回拒绝原因；放行返回 null。
 *
 * 抽成纯函数是为了能脱离 Pi session 直接测——闸的判据不该只能靠跑一整个 agent 才验证。
 */
export function evaluateBuiltinToolCall(
  toolName: string,
  input: unknown,
  roots: FinworkBuiltinRoots,
): string | null {
  if (!isFinworkBuiltinTool(toolName)) return null;

  if (toolName === "bash") {
    const command = readStringField(input, "command");
    if (!command) return "bash 缺少 command 参数。";
    for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return `拒绝执行破坏性命令：${command.slice(0, 120)}。如果确实需要，请由用户在终端自行执行。`;
      }
    }
    for (const pattern of BROAD_DISCOVERY_PATTERNS) {
      if (pattern.test(command)) {
        return `拒绝执行全盘路径探查：${command.slice(0, 160)}。请使用提示词中提供的附件路径或会话目录。`;
      }
    }
    return null;
  }

  const filePath = readStringField(input, "path");
  const isReadClass = (FINWORK_READ_TOOL_NAMES as readonly string[]).includes(toolName);

  if (!filePath) {
    // grep/find/ls 的 path 可省略，省略即落在构造时的 cwd（会话目录），是安全缺省。
    // read/write/edit 没有路径则无从校验，必须拒绝——否则可以靠省略参数绕闸。
    return toolName === "read" || !isReadClass ? `${toolName} 缺少 path 参数。` : null;
  }

  if (isReadClass) {
    const resolvedFilePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(roots.readRoot, filePath);
    // 会话目录 + 技能目录（只读）。技能目录必须放行，否则 SKILL.md 指向的
    // references/ 与 scripts/ 读不到，渐进披露形同虚设。
    const allowed = [roots.readRoot, ...(roots.skillRoots ?? [])];
    if (!allowed.some((root) => isInsidePath(resolvedFilePath, root))) {
      return `只能读取本次会话目录或技能目录内的文件：${roots.readRoot}。读 Office/PDF 二进制请用 read_document。`;
    }
    return null;
  }

  // write / edit
  // Pi 的内置工具 cwd 已设为 writeRoot；策略层也必须以同一根解析相对路径，
  // 不能让 Node 进程自身的 cwd（项目根）改变授权结果。
  const resolvedFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(roots.writeRoot, filePath);
  if (isDeliveredPath(resolvedFilePath, roots.writeRoot)) {
    return "不能写入不可变交付目录 delivered/（正式附件只读）。";
  }
  if (!isInsidePath(resolvedFilePath, roots.writeRoot)) {
    return `只能把生成文件写入本次会话输出目录：${roots.writeRoot}`;
  }
  return null;
}

export function createFinworkExtension(context: FinworkExtensionContext): InlineExtension {
  return {
    name: "finwork-core",
    factory: (pi: ExtensionAPI) => {
      // L7：把 Pi session tree 暴露为可审计的用户命令。Web Query 不依赖这些命令，
      // 但 TUI/RPC 可复用同一套 session 文件做 checkpoint、分支和回溯。
      pi.registerCommand("checkpoint", {
        description: "给当前会话节点加复核 checkpoint 标签",
        handler: async (args, ctx) => {
          const label = args.trim();
          if (!label) {
            ctx.ui.notify("用法：/checkpoint <标签>", "warning");
            return;
          }
          const leafId = ctx.sessionManager.getLeafId();
          if (!leafId) {
            ctx.ui.notify("当前会话没有可标记节点", "warning");
            return;
          }
          pi.setLabel(leafId, label);
          ctx.ui.notify(`已标记 checkpoint：${label}`);
        },
      });
      pi.registerCommand("branch", {
        description: "从指定 session 节点建立方案分支",
        handler: async (args, ctx) => {
          const entryId = args.trim();
          if (!entryId) {
            ctx.ui.notify("用法：/branch <节点 ID>", "warning");
            return;
          }
          await ctx.fork(entryId, { position: "at" });
        },
      });
      pi.registerCommand("return", {
        description: "回到 session 树中的指定节点",
        handler: async (args, ctx) => {
          const entryId = args.trim();
          if (!entryId) {
            ctx.ui.notify("用法：/return <节点 ID>", "warning");
            return;
          }
          await ctx.navigateTree(entryId, { summarize: true, label: "返回复核" });
        },
      });
      // L9：工作流命令只负责提供稳定入口，具体业务仍由 Finwork 工具和确认闸执行。
      pi.registerCommand("月结", {
        description: "开始月结工作流",
        handler: async (args, ctx) => {
          const period = args.trim() || "当前期间";
          pi.sendUserMessage(`请按月结工作流处理${period}：先检查期间与数据完整性，再列出风险和待人工确认事项。`);
        },
      });
      pi.registerCommand("对账", {
        description: "开始银行与账面核对工作流",
        handler: async (args, ctx) => {
          pi.sendUserMessage(`请按银行对账工作流处理${args.trim() || "当前上传的流水和账面数据"}。`);
        },
      });
      pi.registerCommand("凭证", {
        description: "开始凭证草稿工作流",
        handler: async (args, ctx) => {
          pi.sendUserMessage(`请按凭证草稿工作流处理${args.trim() || "当前单据"}，最终只生成草稿并保留人工确认点。`);
        },
      });

      pi.on("tool_call", async (event) => {
        const reason = evaluateBuiltinToolCall(event.toolName, event.input, context.roots);
        if (!reason) return undefined;
        context.emit?.({ type: "run_blocked", toolName: event.toolName, summary: reason });
        return { block: true, reason };
      });

      // L3a：动态段每回合重算，静态前缀不动。返回的 systemPrompt 在多个扩展间链式传递，
      // 所以要基于 event.systemPrompt 追加而不是覆盖。
      if (context.dynamicSystemContext) {
        pi.on("before_agent_start", (event) => {
          const dynamic = context.dynamicSystemContext?.().trim();
          if (!dynamic) return undefined;
          return { systemPrompt: `${event.systemPrompt}\n\n${dynamic}` };
        });
      }

      // L3b：历史作为真消息前置注入。`context` 每次 LLM 调用都会触发，而 event.messages
      // 是深拷贝、改动只作用于本次调用，所以每次前置是幂等的（不会越堆越多）。
      if (context.replayHistory?.length) {
        const replay = context.replayHistory;
        pi.on("context", (event) => ({
          messages: [...replay, ...event.messages] as typeof event.messages,
        }));
      }

      // L8：财务专属压缩。默认摘要不知道口径/科目/期间/金额最要紧，
      // 这里先确定性提取关键事实，再让模型写叙述，两者拼成最终摘要。
      //
      // **fail-safe 是硬要求**：任何一步出问题都返回 undefined，回落 pi 自带摘要。
      // 压缩失败会让整个回合失败，绝不能因为这段增强而崩。
      pi.on("session_before_compact", async (event) => {
        try {
          const messages = event.preparation?.messagesToSummarize ?? [];
          const texts = messages.flatMap(extractTexts);
          const facts = extractCompactionFacts(texts);
          const factsBlock = formatFactsBlock(facts);

          // 审计：design §8 的「compaction 审计」欠账。无论走不走自定义摘要都记。
          log.info("compaction", {
            traceId: context.traceId ?? null,
            reason: event.reason,
            tokensBefore: event.preparation?.tokensBefore ?? null,
            messages: messages.length,
            amounts: facts.amounts.length,
            periods: facts.periods.length,
            conventions: facts.conventions.length,
          });
          // 不再额外发运行时事件：`compaction_completed` 已由 event-mapper 从 pi 的
          // compaction 事件发出，这里再发一条会双计。审计走结构化日志（D8：事件合同不变）。

          if (!factsBlock || !context.summarizeForCompaction) return undefined;
          const narrative = await context.summarizeForCompaction(texts, event.signal);
          if (!narrative?.trim()) return undefined;

          return {
            compaction: {
              summary: `${factsBlock}\n\n${narrative.trim()}`,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: { finworkFacts: facts },
            },
          };
        } catch (error) {
          log.warn("compaction customization failed, falling back to pi default", {
            traceId: context.traceId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      });

      // L2c：provider 层可观测性。design-pi-agent-runtime §8 把这项列为「无落点」——
      // 一次性 session 下确实没有，extension 就是它的落点。
      pi.on("before_provider_headers", (event) => {
        // 网关侧按会话归因需要一个稳定 id；顺带让 Finwork 的日志与网关日志能对上。
        if (context.traceId) event.headers["x-finwork-trace-id"] = context.traceId;
      });

      pi.on("after_provider_response", (event) => {
        const traced: Record<string, string> = {};
        for (const name of TRACED_RESPONSE_HEADERS) {
          const value = event.headers?.[name];
          if (typeof value === "string" && value) traced[name] = value;
        }
        // 只在异常或确有可归因信息时落日志，正常回合不刷屏。
        const abnormal = event.status >= 400;
        if (!abnormal && Object.keys(traced).length === 0) return;
        const entry = { traceId: context.traceId ?? null, status: event.status, ...traced };
        if (abnormal) log.warn("provider response abnormal", entry);
        else log.info("provider response", entry);
      });
    },
  };
}

function readStringField(input: unknown, field: string): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}
