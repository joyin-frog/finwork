/**
 * WP4b: CalcReceipt 落库。
 *
 * 设计原则：
 * - calc_receipts 独立表，无会话 FK（计算凭据须比会话长寿，同 audit_logs 设计）。
 * - 写入前过 validateCalcReceipt 校验；校验失败抛错，不写库。
 * - saveCalcReceiptSafe：降级包装——落库失败记 warn 不阻断调用方返回 undefined。
 */
import type { DatabaseSync } from "node:sqlite";
import { validateCalcReceipt, type CalcReceipt } from "@/lib/domain/receipt";

export type SaveReceiptParams = {
  toolName: string;
  conversationId?: number | null;
  traceId?: string | null;
  receipt: CalcReceipt;
};

/**
 * 落库并返回新行 id。
 * 校验失败抛出 Error（不写库）。
 */
export function saveCalcReceipt(db: DatabaseSync, params: SaveReceiptParams): number {
  // 校验——validateCalcReceipt 失败会抛出带"CalcReceipt"的 Error
  const validated = validateCalcReceipt(params.receipt);
  const json = JSON.stringify(validated);

  const result = db.prepare(
    `INSERT INTO calc_receipts (tool_name, conversation_id, trace_id, receipt)
     VALUES (?, ?, ?, ?)`
  ).run(
    params.toolName,
    params.conversationId ?? null,
    params.traceId ?? null,
    json
  );

  return result.lastInsertRowid as number;
}

/**
 * 降级版：落库失败 warn 不抛，返回 undefined。
 * 用于工具 handler 层——receipt 落库是增强，不能阻断主链路。
 */
export function saveCalcReceiptSafe(
  db: DatabaseSync,
  params: SaveReceiptParams,
  context = params.toolName
): number | undefined {
  try {
    return saveCalcReceipt(db, params);
  } catch (err) {
    console.warn(`[receipt-store] ${context} 落库失败（降级，不影响工具返回）:`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/**
 * 按 id 取回 CalcReceipt（供测试断言与历史回查）。
 * 不存在返回 null。
 */
export function getCalcReceipt(db: DatabaseSync, id: number): CalcReceipt | null {
  const row = db.prepare("SELECT receipt FROM calc_receipts WHERE id = ?").get(id) as
    | { receipt: string }
    | undefined;
  if (!row) return null;
  try {
    return validateCalcReceipt(JSON.parse(row.receipt));
  } catch {
    return null;
  }
}
