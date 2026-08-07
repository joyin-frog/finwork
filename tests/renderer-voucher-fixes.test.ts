import assert from "node:assert/strict";
import { getToolSummary } from "../lib/agent/tools/renderers.ts";

/**
 * 覆盖三项修改:
 * 1. process_voucher_batch 量词改为"笔业务"而不是"张"
 * 2. export_voucher_list 新增 renderer
 */
export const rendererVoucherFixesTestPromise = (async () => {
  // ── 1. process_voucher_batch: 9 笔应含"笔"不含"张" ──
  const batchResult = getToolSummary(
    "process_voucher_batch",
    { slips: new Array(9).fill({}) },
  );
  assert.ok(
    batchResult.includes("9") && batchResult.includes("笔"),
    `process_voucher_batch FAIL: 应含"9 笔",实际:${batchResult}`,
  );
  assert.ok(
    !batchResult.includes("张"),
    `process_voucher_batch FAIL: 不应含"张",实际:${batchResult}`,
  );

  // 零笔时不崩溃,回落兜底文案
  const batchZero = getToolSummary("process_voucher_batch", { slips: [] });
  assert.ok(typeof batchZero === "string" && batchZero.length > 0, "process_voucher_batch FAIL: 空输入应返回非空字符串");

  // ── 2. export_voucher_list: 新 renderer ──
  const exportResult = getToolSummary(
    "export_voucher_list",
    { vouchers: new Array(5).fill({}) },
  );
  assert.ok(
    exportResult.includes("5") && exportResult.includes("笔"),
    `export_voucher_list FAIL: 应含"5 笔",实际:${exportResult}`,
  );
  assert.ok(
    /导出凭证清单/.test(exportResult),
    `export_voucher_list FAIL: 应含"导出凭证清单",实际:${exportResult}`,
  );

  // 零凭证时
  const exportZero = getToolSummary("export_voucher_list", { vouchers: [] });
  assert.ok(/导出凭证清单/.test(exportZero), `export_voucher_list FAIL: 零凭证应含"导出凭证清单",实际:${exportZero}`);

  console.log("renderer-voucher-fixes: all checks passed ✓");
})();
