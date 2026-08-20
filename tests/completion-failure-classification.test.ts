import assert from "node:assert/strict";
import { classifyCompletionFailure } from "../lib/agent/completion-gate-settle.ts";

export const completionFailureClassificationTestPromise = (async () => {
  assert.equal(classifyCompletionFailure(["CONSOLIDATION_BALANCE_FAILED"]), "business");
  assert.equal(classifyCompletionFailure(["formula_cache_empty", "recalc_unavailable"]), "environment");
  assert.equal(classifyCompletionFailure(["stale_base_version"]), "version");
  assert.equal(classifyCompletionFailure(["commit_failed"]), "tool");
  console.log("completion-failure-classification: model repairs business failures only ✓");
})();
