import { z } from "zod/v4";
import { upsertBusinessMetrics } from "@/lib/db/finance-store";
import type { SdkLike } from "./sdk-types";
import { withIdempotency } from "@/lib/agent/tools/idempotency";

type Sdk = SdkLike;

const rowSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  revenue: z.number().finite(),
  cost: z.number().finite().nullish(),
  expense: z.number().finite().nullish(),
  profit: z.number().finite(), // 允许为负
  note: z.string().max(200).nullish(),
});

export function createRecordBusinessMetricsTool(sdk: Sdk) {
  return sdk.tool(
    "record_business_metrics",
    [
      "登记月度经营数据（收入/利润等）到本地数据库。",
      "调用前必须先向用户复述解析出的数字（如：「您说的是 2026 年 5 月，收入 50 万，利润 8 万，对吗？」），",
      "经用户明确确认后再调用。只收月度数；如用户提供季度或年度数，引导其按月拆分提供。",
      "同一 (year, month) 重复调用为更新（upsert）。profit 允许为负数。"
    ].join("\n"),
    {
      rows: z.array(rowSchema).min(1).max(24).describe("月度数据列表，每条对应一个自然月"),
      conversationId: z.number().nullish().describe("当前会话 ID，用于溯源"),
    },
    withIdempotency("record_business_metrics", async (args: { rows: Array<z.infer<typeof rowSchema>>; conversationId?: number | null }) => {
      try {
        // 验证每条数据
        for (const row of args.rows) {
          rowSchema.parse(row);
        }
        // source 默认 'user_dictated'（spec §4.3：口述数据标签；此工具全部为用户口述）
        upsertBusinessMetrics(args.rows.map((r) => ({ ...r, source: "user_dictated" })));
        const summary = args.rows
          .map((r) => `${r.year}年${r.month}月 收入${r.revenue} 利润${r.profit}`)
          .join("；");
        return {
          content: [{
            type: "text" as const,
            text: `已登记 ${args.rows.length} 条经营数据：${summary}。可在总览页查看汇总。`
          }],
          structuredContent: { recorded: args.rows.length }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `经营数据登记失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }, { riskLevel: "medium" })
  );
}
