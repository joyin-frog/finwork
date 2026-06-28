import { createHash } from "node:crypto";
import { getDb, insertAuditLog } from "@/lib/db/sqlite";

type ToolHandler<A = Record<string, unknown>> = (args: A) => Promise<unknown>;

/**
 * 包装写库/高风险工具:
 * - 幂等:agent 显式传 idempotency_key(8–64 字符)时,同 key+tool 命中则返回缓存结果(安全重试)。
 * - 审计:medium/high 工具每次执行都写 audit_logs("tool_exec"),不依赖 key —— 财务变更可追溯。
 * 不自动按 input 缓存(很多写库工具结果依赖当前 DB 状态,自动缓存会出错)。
 */
export function withIdempotency<H extends ToolHandler<any>>(
  toolName: string,
  handler: H,
  opts?: { riskLevel?: "low" | "medium" | "high"; traceId?: string }
): H {
  const wrapped = async (rawArgs: Parameters<H>[0]) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const db = getDb();
    const key = typeof args.idempotency_key === "string" ? args.idempotency_key : undefined;

    if (key && key.length >= 8 && key.length <= 64) {
      const existing = db
        .prepare("SELECT result_json, is_error FROM tool_executions WHERE idempotency_key = ? AND tool_name = ?")
        .get(key, toolName) as { result_json: string; is_error: number } | undefined;
      if (existing) {
        const cached = JSON.parse(existing.result_json);
        if (existing.is_error) throw cached;
        return cached;
      }
    }

    const inputHash = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
    let result: unknown;
    let isError = false;
    try {
      result = await handler(rawArgs);
      return result;
    } catch (error) {
      isError = true;
      result = error instanceof Error ? { message: error.message } : error;
      throw error;
    } finally {
      // 显式 key 才落 tool_executions(供安全重试去重)
      if (key && key.length >= 8 && key.length <= 64) {
        try {
          db.prepare(
            "INSERT OR REPLACE INTO tool_executions (idempotency_key, tool_name, input_hash, result_json, is_error, trace_id) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(key, toolName, inputHash, JSON.stringify(result), isError ? 1 : 0, opts?.traceId ?? null);
        } catch { /* best-effort */ }
      }
      // medium/high 工具每次都审计(财务变更可追溯,不依赖 key)
      if (opts?.riskLevel === "high" || opts?.riskLevel === "medium") {
        insertAuditLog("tool_exec", { toolName, inputHash, isError, traceId: opts?.traceId ?? null });
      }
    }
  };
  return wrapped as H;
}
