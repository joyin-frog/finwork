// 逐条 assistant 消息累计分模型 usage(SDK result 消息的 modelUsage 才是权威值;
// 此累计仅为兜底:回合被超时/中断/出错掐掉时 result 永远不来,没有它这些回合的消耗就整体丢失,
// 用量配额(lib/usage)会漏记——正是"跑了 10 分钟被超时,却一点没入账"的来源)。

import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

/** SDK assistant 消息里 message.usage 的字段(API snake_case;网关可能缺字段/给 null)。 */
type ApiUsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** 把一条 assistant 消息的 usage 累加进分模型累计器(原地修改)。model/usage 缺失时 no-op。 */
export function accumulateModelUsage(
  acc: Record<string, ModelUsage>,
  model: string | undefined,
  usage: ApiUsageLike | undefined
): void {
  if (!model || !usage) return;
  const entry = (acc[model] ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  });
  entry.inputTokens += usage.input_tokens ?? 0;
  entry.outputTokens += usage.output_tokens ?? 0;
  entry.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  entry.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
}
