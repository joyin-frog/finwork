/**
 * WP15: undo_last_write MCP 工具
 *
 * 两段式防撤错对象：
 *   - 无参调用：只查不执行，返回最近一条可撤销记录的描述
 *     （表/行数/原写入时间/auditId）；工具描述指示 agent 先向用户复述确认
 *   - 带 auditId 调用：执行撤销并返回撤销明细
 *
 * 接线：category=finance，riskLevel=high（confirm gate 会触发确认卡）
 * 不挂子代理角色白名单——撤销是主对话动作
 */

import { z } from "zod/v4";
import type { DatabaseSync } from "node:sqlite";
import type { SdkLike } from "./sdk-types";
import { listAuditEntries, undoAuditEntry } from "@/lib/db/audit-store";
import type { UndoOp } from "@/lib/db/audit-store";

type Sdk = SdkLike;

export function createUndoLastWriteTool(sdk: Sdk, dbOverride?: DatabaseSync) {
  return sdk.tool(
    "undo_last_write",
    [
      "撤销最近一次 agent 事实写操作（发票台账或经营指标）。",
      "【两段式防误操作】：",
      "  1. 不带 auditId 调用 → 只查询，返回最近一条可撤销记录的描述（表名、影响行数、写入时间）；",
      "     agent 应先向用户复述确认（如「您是要撤销 2026-07-07 写入的 3 张发票吗？」），等用户明确说「是」后再继续。",
      "  2. 带 auditId 调用 → 执行撤销，返回撤销明细。",
      "注意：payroll 确认等业务动作不可撤销，调用会返回明确的不可撤销提示。",
    ].join("\n"),
    {
      auditId: z.number().int().positive().nullish().describe("要撤销的审计记录 id（不传 = 只查询最近可撤销记录，不执行撤销）"),
    },
    async (args: { auditId?: number | null }) => {
      const db = dbOverride;
      try {
        if (args.auditId == null) {
          // 查询模式：只返回最近一条可撤销记录的描述
          const list = db
            ? listAuditEntries({ limit: 1, undoableOnly: true }, db)
            : listAuditEntries({ limit: 1, undoableOnly: true });

          if (list.length === 0) {
            return {
              content: [{ type: "text" as const, text: "当前没有可撤销的 agent 写操作记录。" }],
            };
          }
          const entry = list[0];
          const ops = JSON.parse(JSON.stringify(entry)) as typeof entry; // typed copy
          const undoOps = ops.undoable && entry.undoable ? (() => {
            try {
              const rawEntry = db
                ? db.prepare("SELECT undo FROM audit_logs WHERE id=?").get(entry.id) as { undo: string }
                : undefined;
              if (!rawEntry?.undo) return null;
              return JSON.parse(rawEntry.undo) as UndoOp[];
            } catch { return null; }
          })() : null;

          const tables = undoOps ? [...new Set(undoOps.map((o) => o.table))].join("、") : "未知";
          const rowCount = undoOps ? undoOps.reduce((s, o) => {
            if (o.op === "delete_rows") return s + o.keys.length;
            if (o.op === "restore_rows") return s + o.rows.length;
            return s;
          }, 0) : 0;

          const desc = `最近一条可撤销记录：\n- 操作类型：${entry.eventType}\n- 写入时间：${entry.createdAt}\n- 影响表：${tables}\n- 影响行数：${rowCount}\n- auditId：${entry.id}\n\n如需撤销，请带 auditId=${entry.id} 再次调用此工具。`;

          return {
            content: [{ type: "text" as const, text: desc }],
            structuredContent: {
              mode: "preview",
              auditId: entry.id,
              eventType: entry.eventType,
              createdAt: entry.createdAt,
              tables,
              rowCount,
            },
          };
        }

        // 执行模式
        const result = db
          ? undoAuditEntry(args.auditId, db)
          : undoAuditEntry(args.auditId);

        const opsDesc = result.ops.map((o) => {
          if (o.op === "delete_rows") return `删除 ${o.table} 中 ${o.keys.length} 行（键：${o.keys.slice(0, 5).join("、")}${o.keys.length > 5 ? "…" : ""}）`;
          if (o.op === "restore_rows") return `恢复 ${o.table} 中 ${o.rows.length} 行`;
          return "未知操作";
        }).join("\n");

        return {
          content: [{ type: "text" as const, text: `已成功撤销 auditId=${result.auditId} 的写操作：\n${opsDesc}` }],
          structuredContent: { undone: true, auditId: result.auditId },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `撤销失败：${err instanceof Error ? err.message : String(err)}` }],
          isError: true as const,
        };
      }
    }
  );
}
