export type KnowledgeCategory = "expense_policy" | "contract" | "finance_spec" | "tax" | "general";

/** P1 合同归纳:文档结构化提炼 metadata 形状 */
export type KeyDate = { kind: "签订" | "付款" | "开票" | "到期" | "交付"; date: string };

export type DocMetadata = {
  docType?: string;           // 合同/订单/发票/水电/票据…
  counterparty?: string;      // 对方（甲/乙方択一或两列）
  amount?: number;            // 金额(元)
  amountCurrency?: string;    // 默认 CNY
  keyDates?: KeyDate[];
  recurrence?: "一次" | "月" | "季" | "年" | "分期";
  status?: string;            // 待付/已付/待开票/已开票/待收/已收…（业务状态）
  sourceFile?: string;        // 来源文件名
  fields?: Record<string, unknown>; // 每类卡片的灵活附加字段
};

export type MetaStatus = "none" | "draft" | "confirmed";

export type KnowledgeDocument = {
  id: number;
  title: string;
  fileName: string;
  mimeType: string;
  category: KnowledgeCategory;
  sizeBytes: number;
  chunkCount: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  metadata?: DocMetadata;
  metaStatus: MetaStatus;
};
