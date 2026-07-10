/**
 * emit_checklist: WP14a 把清单产物物化为工件，返回 structured 渲染成卡片。
 *
 * 职责：
 *   - 接收 title + items（1-50 项），分配稳定 id，落库 artifacts 表
 *   - 返回 structuredContent {kind:'artifact_checklist', artifactId, title, items}
 *   - 接线：safe/finance，无角色白名单（v1 主对话专用）
 *
 * conversationId 经 createFinanceMcpServer 既有参数拿到（参见 index.ts:22）。
 */

import { z } from "zod/v4";
import type { DatabaseSync } from "node:sqlite";
import { jsonCoercible } from "./coerce-json";
import type { SdkLike } from "./sdk-types";
import { createArtifact, getArtifact } from "@/lib/db/artifact-store";

type Sdk = SdkLike;

const MAX_ITEMS = 50;

export function createEmitChecklistTool(
  sdk: Sdk,
  /** 注入 db（测试用）；生产路径传 undefined，工具内部 lazy getDb() */
  dbOverride: DatabaseSync | undefined,
  conversationId: string | undefined
) {
  return sdk.tool(
    "emit_checklist",
    [
      "把复核清单或催款清单物化为可勾选工件（工件会以卡片形式展示在对话中，每项可标记 待办/已处理/忽略）。",
      "适用于 filing-precheck 技能的 ⚠️/❓ 项汇总，以及 receivables-ledger 技能的逾期催款项。",
      "正文 Markdown 表格保留不变，工件是操作层（用于记录处理进度），不替代阅读层。",
      "每次回答最多调用一次；勾选只记录处理进度，不改变实际申报/业务状态。"
    ].join("\n"),
    {
      title: z.string().min(1).max(200).describe("清单标题，如「申报前复核清单 2026-07」"),
      items: jsonCoercible(
        z
          .array(
            z.object({
              label: z.string().min(1).max(500).describe("清单项文字"),
              detail: z.string().max(2000).optional().describe("补充说明（可选）"),
              severity: z.enum(["warn", "info"]).optional().describe("风险等级：warn=需处理 info=提示"),
            })
          )
          .min(1)
          .max(MAX_ITEMS)
          .describe(`清单项列表，1-${MAX_ITEMS} 项`)
      ),
    },
    async (args: {
      title: string;
      items: Array<{ label: string; detail?: string; severity?: "warn" | "info" }>;
    }) => {
      try {
        if (args.items.length > MAX_ITEMS) {
          return {
            content: [{ type: "text" as const, text: `清单项数量超过上限（${MAX_ITEMS}），请精简后重试。` }],
            isError: true as const,
          };
        }

        // 生产路径：lazy getDb()；测试路径：dbOverride
        let db: DatabaseSync;
        if (dbOverride) {
          db = dbOverride;
        } else {
          const { getDb } = await import("@/lib/db/sqlite");
          db = getDb();
        }

        // 解析 conversationId（字符串转整数）
        const convId = conversationId != null ? Number(conversationId) : null;
        const dbConvId = (convId != null && Number.isFinite(convId)) ? convId : null;

        const artifactId = createArtifact(db, {
          title: args.title,
          items: args.items,
          conversationId: dbConvId,
        });

        // 重新读取 items（含稳定 id）
        const artifact = getArtifact(db, artifactId);
        if (!artifact) {
          throw new Error(`createArtifact 落库后 getArtifact 返回 null，工件写入失败（id: ${artifactId}）`);
        }
        const itemsWithId = artifact.items;

        const structuredContent = {
          kind: "artifact_checklist" as const,
          artifactId,
          title: args.title,
          items: itemsWithId,
        };

        return {
          content: [{
            type: "text" as const,
            text: `清单已物化为工件（artifactId: ${artifactId}），共 ${args.items.length} 项，可在卡片中逐项勾选处理进度。`,
          }],
          structuredContent,
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `物化清单失败：${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true as const,
        };
      }
    }
  );
}
