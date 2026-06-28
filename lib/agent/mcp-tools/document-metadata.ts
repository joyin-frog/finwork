import { z } from "zod/v4";
import { getKnowledgeDocumentById, setKnowledgeDocumentMeta } from "@/lib/db/sqlite";
import type { SdkLike } from "./sdk-types";
import { withIdempotency } from "@/lib/agent/tools/idempotency";

type Sdk = SdkLike;

const keyDateSchema = z.object({
  kind: z.enum(["签订", "付款", "开票", "到期", "交付"]),
  date: z.string().describe("日期，格式 YYYY-MM-DD 或自然语言（如'2026年底'），拿不准留空"),
});

const metadataSchema = z.object({
  docType: z.string().max(20).nullish().describe("文档类型：合同/订单/发票/水电/票据等"),
  counterparty: z.string().max(100).nullish().describe("对方名称（甲方/乙方，拿不准留空）"),
  amount: z.number().finite().nullish().describe("金额（元），拿不准留空，禁止估算"),
  amountCurrency: z.string().max(10).nullish().describe("货币，默认 CNY"),
  keyDates: z.array(keyDateSchema).max(10).nullish().describe("关键日期列表，每项含 kind 和 date"),
  recurrence: z.enum(["一次", "月", "季", "年", "分期"]).nullish().describe("周期性，拿不准留空"),
  status: z.string().max(20).nullish().describe("业务状态：待付/已付/待开票/已开票/待收/已收等"),
  sourceFile: z.string().max(200).nullish().describe("来源文件名"),
  fields: z.record(z.string(), z.unknown()).nullish().describe("每类卡片的灵活附加字段"),
}).describe("提炼的结构化 metadata，拿不准的字段留 null，不编造");

export function createRecordDocumentMetadataTool(sdk: Sdk) {
  return sdk.tool(
    "record_document_metadata",
    [
      "起草/更新某知识库文档的结构化 metadata（合同要点、金额、日期、对方等）。",
      "写入后 meta_status='draft'，用户在知识库目录确认后变为 confirmed。",
      "红线 4：拿不准的字段留 null，禁止估算或编造；只认 confirmed 为最终数据。",
      "红线 7：全程本地提炼，不外发敏感原文；只把提炼结果（不含原文）写入 metadata。",
      "仅在上传含合同/订单/发票/票据相关文档后、或用户主动要求提炼时调用。",
    ].join("\n"),
    {
      documentId: z.number().int().positive().describe("知识库文档 ID"),
      metadata: metadataSchema,
      idempotency_key: z.string().min(8).max(64).nullish().describe("幂等 key，重试时传同一 key"),
    },
    withIdempotency(
      "record_document_metadata",
      async (args: {
        documentId: number;
        metadata: z.infer<typeof metadataSchema>;
        idempotency_key?: string | null;
      }) => {
        try {
          const doc = getKnowledgeDocumentById(args.documentId);
          if (!doc) {
            return {
              content: [{ type: "text" as const, text: `文档 ID ${args.documentId} 不存在，无法写入 metadata。` }],
              isError: true as const,
            };
          }
          // 写入 draft；确认由前端 PATCH 触发
          setKnowledgeDocumentMeta(args.documentId, args.metadata as Record<string, unknown>, "draft");
          const docType = args.metadata.docType ?? "文档";
          const counterparty = args.metadata.counterparty ? `、对方：${args.metadata.counterparty}` : "";
          const amountStr = args.metadata.amount != null ? `、金额：${args.metadata.amount} ${args.metadata.amountCurrency ?? "CNY"}` : "";
          return {
            content: [{
              type: "text" as const,
              text: `已起草「${docType}」要点（status=draft）${counterparty}${amountStr}。请在知识库目录确认后生效（confirmed）。`,
            }],
            structuredContent: { documentId: args.documentId, metaStatus: "draft" },
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `metadata 写入失败：${error instanceof Error ? error.message : String(error)}` }],
            isError: true as const,
          };
        }
      },
      { riskLevel: "medium" }
    )
  );
}
