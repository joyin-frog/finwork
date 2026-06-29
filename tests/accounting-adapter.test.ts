import assert from "node:assert/strict";
import { DraftAccountingAdapter } from "../lib/integrations/accounting-adapter.ts";

// 第一版适配器只产草稿、不写正式凭证。这里把"草稿契约"钉住:
// 一旦有人接金蝶正式 API 改了返回形态,下游依赖会先被这些断言挡下。
export const accountingAdapterTestPromise = (async () => {
  const adapter = new DraftAccountingAdapter();

  // ── 1. createVoucherDraft:externalId 由 sourceId 派生,状态为 draft ───
  {
    const res = await adapter.createVoucherDraft({
      sourceId: "exp-2026-001",
      summary: "差旅报销",
      amount: 1280.5,
    });
    assert.equal(res.externalId, "draft-exp-2026-001", "externalId 应为 draft-<sourceId>");
    assert.equal(res.status, "draft", "第一版只产草稿");
  }

  // ── 2. pushExpenseBatch:回执含批次号且标注 exported as draft ──────────
  {
    const res = await adapter.pushExpenseBatch("batch-42");
    assert.equal(res.status, "batch batch-42 exported as draft", "批量导出应为草稿状态且带批次号");
  }

  console.log("accounting-adapter: all 2 checks passed ✓");
})();
