import { z } from "zod/v4";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = { tool: (name: string, desc: string, schema: any, handler: (args: any) => any) => any };

export function createKingdeeTool(sdk: Sdk) {

  return sdk.tool(
    "export_kingdee_draft",
    "生成金蝶凭证导入草稿（JSON 格式）。当前为模拟模式，不写入金蝶系统，仅供人工审核后手动导入。",
    {
      batchId: z.string().describe("批次 ID，用于标识本次导入"),
      entries: z.array(z.object({
        subject: z.string().describe("科目名称"),
        debit: z.number().nullish().describe("借方金额（元）"),
        credit: z.number().nullish().describe("贷方金额（元）"),
        summary: z.string().describe("摘要说明"),
      })).describe("凭证分录列表"),
    },
    async (args: {
      batchId: string;
      entries: Array<{ subject: string; debit?: number | null; credit?: number | null; summary: string }>;
    }) => {
      const totalDebit = args.entries.reduce((sum, e) => sum + (e.debit ?? 0), 0);
      const totalCredit = args.entries.reduce((sum, e) => sum + (e.credit ?? 0), 0);
      const draft = {
        batchId: args.batchId,
        status: "draft" as const,
        createdAt: new Date().toISOString(),
        entries: args.entries,
        totalDebit,
        totalCredit,
      };

      return {
        content: [{
          type: "text" as const,
          text: [
            `金蝶草稿已生成（批次：${args.batchId}）`,
            `⚠ 当前为模拟模式，未写入金蝶系统，请人工审核后手动导入`,
            `共 ${args.entries.length} 条分录，借方合计 ¥${totalDebit.toFixed(2)}，贷方合计 ¥${totalCredit.toFixed(2)}`,
          ].join("\n"),
        }],
        structuredContent: draft,
      };
    }
  );
}
