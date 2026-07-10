/**
 * recap-summary.ts  –  AR1a 结构化重建回顾 + AR1b PostCompact hook 回调工厂
 *
 * AR1a：把 stale 重建时的对话回顾从「全量压平」升级为
 *   「较早历史 → 一次 mainModel 结构化摘要（四段）+ 保留最近 RECENT_KEEP 条原文」。
 *   失败/SKIP_LLM → 优雅降级回全量压平（fallbackFlatRecap）。
 *
 * AR1b：createPostCompactHookCallback — 供 claude-adapter 的 SDK hooks.PostCompact 使用，
 *   把 compact_summary 全文落进 agent_spans.metadata_json。
 *
 * 设计约定：
 * - 本模块不调用 readClaudeSettings（settings 由 runClaudeAgent 透传，N1）。
 * - fallbackFlatRecap 输出与改造前 yieldMessages 的 recap 段逐字一致（快照锁死）。
 */

import { buildMessagesUrl } from "@/lib/agent/router";
import type { AgentMessage } from "./claude-adapter";
import type { SpanInput } from "@/lib/observability/spans";

// ─── 常量 ──────────────────────────────────────────────────────────────────────

/** 摘要 + 保留最近 K 条原文的阈值。≤阈值时不调 LLM。 */
export const RECENT_KEEP = 8;

/** summarizeHistory 的请求超时（毫秒）。 */
const SUMMARIZE_TIMEOUT_MS = 15_000;

// ─── 类型 ──────────────────────────────────────────────────────────────────────

/** recap-summary 所需的最小设置子集（由 runClaudeAgent 透传，不在此处 readClaudeSettings）。 */
export type SummarySettings = {
  apiKey: string;
  apiUrl: string;
  mainModel?: string;
  model?: string;
};

// ─── AR1a: fallbackFlatRecap ────────────────────────────────────────────────────

/**
 * 与改造前 yieldMessages 的 recap 段逐字等价的全量压平实现。
 * 用于：① history.length ≤ RECENT_KEEP（不值得摘要），② summarizeHistory 失败降级。
 *
 * @param history  已切好的历史段（messages.slice(0,-1)）
 * @param lastPromptText  当前 user 消息文本
 */
export function fallbackFlatRecap(
  history: AgentMessage[],
  lastPromptText: string
): string {
  const recap = history.length
    ? `<对话回顾>\n${history
        .map((m) => `${m.role === "user" ? "用户" : "助手"}:${m.content}`)
        .join("\n")}\n</对话回顾>\n\n当前请求:\n`
    : "";
  return `${recap}${lastPromptText}`;
}

// ─── AR1a: summarizeHistory ─────────────────────────────────────────────────────

/**
 * 用 mainModel 对较早历史生成结构化四段摘要。
 * 返回 null 的情况（全部优雅降级，不抛出）：
 *   SKIP_LLM / 无 apiKey / 无可用模型 / fetch 非 2xx / 网络异常 / 空响应
 *
 * @param older    history 中较早的那段消息（不含最近 RECENT_KEEP 条）
 * @param settings 由调用方透传，不在此处读取配置
 */
export async function summarizeHistory(
  older: AgentMessage[],
  settings: SummarySettings
): Promise<string | null> {
  // SKIP_LLM 守卫（CI / 单测环境）
  if (process.env.SKIP_LLM) return null;
  if (!settings.apiKey.trim()) return null;

  const model = settings.mainModel || settings.model;
  if (!model) return null;

  const url = buildMessagesUrl(settings.apiUrl);

  const olderText = older
    .map((m) => `${m.role === "user" ? "用户" : "助手"}:${m.content}`)
    .join("\n");

  const systemPrompt = "你是财务对话摘要器，只输出结构化摘要";

  const userPrompt = [
    "请将以下财务对话历史浓缩为结构化摘要，严格按以下四段格式输出，每段一个标题和内容：",
    "",
    "## 目标",
    "（对话要完成什么）",
    "",
    "## 进展",
    "（已完成的步骤；若对话中提到具体文件/单据/报表名，在此带上）",
    "",
    "## 关键决策",
    "（重要选择或已确认的方向）",
    "",
    "## 下一步",
    "（剩余待完成事项）",
    "",
    "对话历史：",
    olderText,
  ].join("\n");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    return text || null;
  } catch {
    return null;
  }
}

// ─── AR1a: buildStructuredRecap ─────────────────────────────────────────────────

/**
 * 组装最终传给 SDK 的 recap 文本段。
 *
 * 决策树：
 * - history.length ≤ RECENT_KEEP → fallbackFlatRecap（不调 LLM）
 * - history.length > RECENT_KEEP：
 *     older → summarizeHistory → 成功 → 结构化（摘要 + 最近 K 条原文）
 *                               → null  → fallbackFlatRecap（全量降级）
 *
 * @param history        messages.slice(0,-1)
 * @param lastPromptText 当前 user 消息文本
 * @param settings       可选；未传或 SKIP_LLM 时走 fallback
 */
export async function buildStructuredRecap(
  history: AgentMessage[],
  lastPromptText: string,
  settings?: SummarySettings
): Promise<string> {
  // 短 history：直接 fallback，不调 LLM
  if (history.length <= RECENT_KEEP) {
    return fallbackFlatRecap(history, lastPromptText);
  }

  const older = history.slice(0, -RECENT_KEEP);
  const recent = history.slice(-RECENT_KEEP);

  // 没有 settings 时无法调 LLM → fallback
  const summary = settings ? await summarizeHistory(older, settings) : null;

  // 摘要失败 → 整段降级（含最早部分）
  if (summary === null) {
    return fallbackFlatRecap(history, lastPromptText);
  }

  const recentText = recent
    .map((m) => `${m.role === "user" ? "用户" : "助手"}:${m.content}`)
    .join("\n");

  return (
    `<历史摘要>\n${summary}\n</历史摘要>\n` +
    `<最近对话>\n${recentText}\n</最近对话>\n\n` +
    `当前请求:\n${lastPromptText}`
  );
}

// ─── AR1b: createPostCompactHookCallback ────────────────────────────────────────

/**
 * 工厂函数：生成 SDK PostCompact hook 的回调，把 compact_summary 全文
 * 落进 agent_spans.metadata_json（不截断，因 writeSpan 对 metadata 不做截断）。
 *
 * 这是与原 compact_boundary span（pre/post tokens）**并列新增**的一条 summary span，
 * 不替换原有 span。
 *
 * @param requestId   当前请求 trace id
 * @param writeSpanFn writeSpan 依赖注入（便于单测，生产传实际 writeSpan）
 */
export function createPostCompactHookCallback(
  requestId: string,
  writeSpanFn: (span: SpanInput) => void
) {
  return async (
    input: unknown,
    _toolUseID: string | undefined,
    _opts: { signal: AbortSignal }
  ): Promise<{ continue: boolean }> => {
    const i = input as { compact_summary?: string; trigger?: string };
    writeSpanFn({
      traceId: requestId,
      spanType: "compact",
      name: `compact:summary:${i.trigger ?? "?"}`,
      startedAt: Date.now(),
      durationMs: 0,
      metadata: {
        compactSummary: i.compact_summary,
        trigger: i.trigger,
      },
    });
    return { continue: true };
  };
}
