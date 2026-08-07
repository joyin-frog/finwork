import { buildMessagesUrl } from "@/lib/agent/router";
import type { AgentSettings } from "@/lib/settings/agent-settings";

/**
 * 压缩叙述生成器（L8）。
 *
 * 形状照 `conversation-title.ts`：直接打网关的 messages 接口，不碰 pi-ai 内部。
 * 只负责「叙述」那一半——金额/口径/期间由 `compaction-facts.ts` 确定性提取后拼在前面。
 *
 * **一切失败都返回 undefined**，让 extension 回落 pi 自带摘要。压缩失败会让整个回合
 * 失败，这段增强绝不能成为新的失败源。
 */

const SUMMARY_TIMEOUT_MS = 30_000;
const MAX_INPUT_CHARS = 24_000;

const SYSTEM_PROMPT = [
  "你是财务对话的上下文压缩器。把给定对话压成简明叙述，供助手继续工作时参考。",
  "要求：",
  "1. 保留任务目标、已确认的事实、待办与未决问题。",
  "2. 涉及金额、口径、科目、期间时，原样复述数字与口径名，不要改写或四舍五入。",
  "3. 不要编造对话里没有的信息；不确定的写「未确认」。",
  "4. 只输出叙述本身，不要标题、不要前后缀。",
].join("\n");

export function createCompactionSummarizer(
  settings: AgentSettings,
  modelId: string,
): (texts: string[], signal?: AbortSignal) => Promise<string | undefined> {
  return async (texts, signal) => {
    if (!settings.apiKey.trim() || !modelId.trim()) return undefined;
    const joined = texts.join("\n").trim();
    if (!joined) return undefined;

    try {
      const response = await fetch(buildMessagesUrl(settings.apiUrl), {
        method: "POST",
        headers: {
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          // 超长时保留尾部：越靠近当前回合的内容越可能仍然相关。
          messages: [{ role: "user", content: joined.slice(-MAX_INPUT_CHARS) }],
        }),
        signal: signal ?? AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      return data.content?.find((block) => block.type === "text")?.text?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
}
