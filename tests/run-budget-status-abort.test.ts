import assert from "node:assert/strict";
import { runBudgetForTier } from "../lib/agent/run-budget.ts";
import {
  canShowFileTaskSuccess,
  runStatusLabel,
  attachmentQualityLabel,
} from "../lib/agent/run-status-labels.ts";
import {
  abortRunById,
  registerRunAbort,
  unregisterRunAbort,
  _resetRunAbortRegistryForTests,
} from "../lib/agent/run-abort-registry.ts";

(async () => {
  assert.equal(runBudgetForTier("fast").maxTurns, 50);
  assert.equal(runBudgetForTier("fast").hardTimeoutMs, 20 * 60_000);
  assert.equal(runBudgetForTier("reasoning").maxTurns, 80);
  assert.equal(runBudgetForTier("reasoning").hardTimeoutMs, 60 * 60_000);
  assert.equal(runBudgetForTier(null).maxTurns, 50);

  assert.equal(runStatusLabel("running"), "正在执行");
  assert.equal(runStatusLabel("canceled"), "用户已停止");
  assert.equal(attachmentQualityLabel("delivered"), "已验证交付");

  assert.equal(
    canShowFileTaskSuccess({ runStatus: "completed", qualityStatus: "passed", hasRequiredDeliverables: true }),
    true,
  );
  assert.equal(
    canShowFileTaskSuccess({ runStatus: "completed", qualityStatus: "failed", hasRequiredDeliverables: true }),
    false,
    "旧 done + 质量失败不得显示文件任务成功",
  );
  assert.equal(
    canShowFileTaskSuccess({ runStatus: "completed", qualityStatus: null, hasRequiredDeliverables: true }),
    false,
  );

  _resetRunAbortRegistryForTests();
  const c = new AbortController();
  registerRunAbort("run-1", c);
  assert.equal(abortRunById("run-1"), true);
  assert.equal(c.signal.aborted, true);
  unregisterRunAbort("run-1");
  assert.equal(abortRunById("missing"), false);

  console.log("run-budget-status-abort: all checks passed ✓");
})();
