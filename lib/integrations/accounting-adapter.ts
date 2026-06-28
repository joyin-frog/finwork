export type VoucherDraft = {
  sourceId: string;
  summary: string;
  amount: number;
};

export interface AccountingAdapter {
  createVoucherDraft(input: VoucherDraft): Promise<{ externalId: string; status: string }>;
  pushExpenseBatch(batchId: string): Promise<{ status: string }>;
}

export class DraftAccountingAdapter implements AccountingAdapter {
  async createVoucherDraft(input: VoucherDraft) {
    return {
      externalId: `draft-${input.sourceId}`,
      status: "draft"
    };
  }

  async pushExpenseBatch(batchId: string) {
    // 预留：后续接金蝶 API。第一版不写入正式凭证，只返回草稿状态。
    return {
      status: `batch ${batchId} exported as draft`
    };
  }
}
