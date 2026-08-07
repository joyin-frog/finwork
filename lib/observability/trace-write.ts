import { getDb } from "@/lib/db/sqlite";
import { redact } from "@/lib/safety/pii";
import type { AgentModelUsage } from "@/lib/agent/contracts";

export function writeAgentTrace(params: {
  traceId: string;
  conversationId?: number;
  startedAt: number;
  modelUsed: string;
  routerPath: string | null;
  errorMessage: string | null;
  userMessage: string;
  finalAnswer: string;
  roleMode: string;
  modelUsage?: Record<string, AgentModelUsage>;
  totalCostUsd?: number;
  numTurns?: number;
  toolCallCount: number;
  /** CR-R1：写入 model_usage_json 供用量按 executionTier 归档 */
  executionTier?: "fast" | "reasoning";
}) {
  try {
    const { traceId, conversationId, startedAt, modelUsed, routerPath, errorMessage, userMessage, finalAnswer, roleMode, modelUsage, totalCostUsd, numTurns, toolCallCount, executionTier } = params;
    const totalMs = Date.now() - startedAt;
    const status = errorMessage ? "error" : (totalMs > 5000 ? "slow" : "ok");
    const inputTokens = modelUsage ? Object.values(modelUsage).reduce((sum, m) => sum + m.inputTokens, 0) : 0;
    const outputTokens = modelUsage ? Object.values(modelUsage).reduce((sum, m) => sum + m.outputTokens, 0) : 0;
    const cacheRead = modelUsage ? Object.values(modelUsage).reduce((sum, m) => sum + m.cacheReadInputTokens, 0) : 0;
    const cacheWrite = modelUsage ? Object.values(modelUsage).reduce((sum, m) => sum + m.cacheCreationInputTokens, 0) : 0;

    let modelUsageJson: string | null = null;
    if (modelUsage) {
      if (executionTier) {
        const annotated: Record<string, AgentModelUsage & { executionTier?: "fast" | "reasoning" }> = {};
        for (const [k, v] of Object.entries(modelUsage)) {
          annotated[k] = { ...v, executionTier };
        }
        modelUsageJson = JSON.stringify(annotated);
      } else {
        modelUsageJson = JSON.stringify(modelUsage);
      }
    }

    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO agent_traces (
        trace_id, conversation_id, started_at, ended_at, total_ms, model_used, router_path,
        tool_call_count, error_message, user_message, final_answer, status, role_mode,
        total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        prompt_tokens, completion_tokens, llm_call_count, num_turns, model_usage_json
      ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      traceId, conversationId ?? null, new Date(startedAt).toISOString(), totalMs, modelUsed, routerPath,
      toolCallCount, errorMessage ? redact(errorMessage) : null,
      redact(userMessage).slice(0, 500), redact(finalAnswer).slice(0, 300), status, roleMode,
      totalCostUsd ?? null, inputTokens || null, outputTokens || null, cacheRead || null, cacheWrite || null,
      inputTokens || null, outputTokens || null, 1, numTurns ?? null,
      modelUsageJson,
    );
  } catch (err) {
    console.warn("[trace] write failed", err);
  }
}
