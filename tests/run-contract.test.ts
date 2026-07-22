/**
 * CR-R0 run-contract 纯函数测试。
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/run-contract.test.ts
 */

import assert from "node:assert/strict";

export const runContractTestPromise = (async () => {
  const {
    settledOutcomeForRunStatus,
    isTerminalRunStatus,
    nextRunStatus,
    buildSettledPayload,
    buildRunStateChanged,
    validateTaskContract,
    validateCompletionEvidence,
    completionGateSatisfied,
    validateRunCheckpoint,
    assertNotTerminationReason,
  } = await import("../lib/agent/run-contract.ts");

  // AR2a settled 三值映射
  assert.equal(settledOutcomeForRunStatus("completed"), "completed");
  assert.equal(settledOutcomeForRunStatus("canceled"), "aborted");
  assert.equal(settledOutcomeForRunStatus("failed"), "error");
  for (const s of ["queued", "running", "waiting_user", "waiting_dependency", "paused"] as const) {
    assert.equal(settledOutcomeForRunStatus(s), null, `${s} must not settle`);
    assert.equal(buildSettledPayload(s), null);
  }
  assert.deepEqual(buildSettledPayload("completed"), { type: "run_settled", outcome: "completed" });
  assert.deepEqual(buildSettledPayload("canceled"), { type: "run_settled", outcome: "aborted" });
  assert.deepEqual(buildSettledPayload("failed", "boom"), {
    type: "run_settled",
    outcome: "error",
    error: "boom",
  });

  assert.equal(isTerminalRunStatus("completed"), true);
  assert.equal(isTerminalRunStatus("running"), false);

  // 状态转换
  assert.equal(nextRunStatus("queued", "runtime_acquired"), "running");
  assert.equal(nextRunStatus("running", "question_created"), "waiting_user");
  assert.equal(nextRunStatus("running", "dependency_action_required"), "waiting_dependency");
  assert.equal(nextRunStatus("waiting_user", "answer_accepted"), "running");
  assert.equal(nextRunStatus("waiting_dependency", "capability_ready"), "running");
  assert.equal(nextRunStatus("running", "recoverable_guard"), "paused");
  assert.equal(nextRunStatus("paused", "explicit_resume"), "running");
  assert.equal(nextRunStatus("running", "completion_gate_passed"), "completed");
  assert.equal(nextRunStatus("paused", "explicit_stop_quiesced"), "canceled");
  assert.equal(nextRunStatus("completed", "explicit_resume"), null);
  assert.equal(nextRunStatus("running", "explicit_resume"), null);

  const changed = buildRunStateChanged("running", "recoverable_guard", {
    terminationReason: "budget_exhausted",
  });
  assert.equal(changed?.type, "run_state_changed");
  assert.equal(changed?.to, "paused");
  assert.equal(changed?.terminationReason, "budget_exhausted");

  assert.throws(() => assertNotTerminationReason("client_disconnected"));

  // TaskContract
  const badEmpty = validateTaskContract({
    version: 1,
    taskKind: "spreadsheet",
    requiredDeliverables: [],
    expectationSnapshot: {},
  });
  assert.equal(badEmpty.ok, false);

  const badProfile = validateTaskContract({
    version: 1,
    taskKind: "spreadsheet",
    requiredDeliverables: [{ id: "d1", mime: "xlsx", count: 1, qualityProfile: "other" }],
    expectationSnapshot: {},
  });
  assert.equal(badProfile.ok, false);

  const good = validateTaskContract({
    version: 1,
    taskKind: "financial_consolidation",
    spreadsheetRequirement: {
      needsLegacyXlsRead: true,
      needsWrite: true,
      needsRecalc: true,
      needsRender: true,
      needsMacroPreservation: false,
    },
    requiredDeliverables: [
      { id: "wb", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", count: 1, qualityProfile: "financial_consolidation" },
    ],
    expectationSnapshot: {
      company: "都森",
      period: "2024Q4",
      assertions: [{ type: "cells_balance", leftName: "FW_TOTAL_ASSETS", rightName: "FW_TOTAL_LIAB_EQUITY", tolerance: 0.01 }],
    },
  });
  assert.equal(good.ok, true);

  // CompletionEvidence
  const badEv = validateCompletionEvidence({
    runId: "r1",
    contractDeliverableId: "wb",
    deliveredPath: "/x",
    deliveredSha256: "",
    mime: "x",
    validatorId: "v",
    qualityProfile: "generic",
    validationStatus: "failed",
    validatedAt: "2026-01-01T00:00:00Z",
    reportId: "rep",
  });
  assert.equal(badEv.ok, false);

  const hash = "a".repeat(64);
  const okEv = validateCompletionEvidence({
    runId: "r1",
    contractDeliverableId: "wb",
    deliveredPath: "/delivered/out.xlsx",
    deliveredSha256: hash,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    validatorId: "generic-xlsx",
    qualityProfile: "financial_consolidation",
    validationStatus: "passed",
    validatedAt: "2026-01-01T00:00:00Z",
    reportId: "rep-1",
  });
  assert.equal(okEv.ok, true);

  if (good.ok && okEv.ok) {
    assert.equal(completionGateSatisfied(good.contract, [okEv.evidence]).ok, true);
    assert.equal(completionGateSatisfied(good.contract, []).ok, false);
  }

  // Checkpoint：禁止权限 grant
  const badCp = validateRunCheckpoint({
    version: 1,
    completedToolCallIds: [],
    generatedFiles: [],
    capturedAt: "2026-01-01T00:00:00Z",
    capabilityGrant: { tool: "run_python" },
  });
  assert.equal(badCp.ok, false);

  const okCp = validateRunCheckpoint({
    version: 1,
    completedToolCallIds: ["t1"],
    generatedFiles: [{ path: "a.xlsx", sha256: hash, status: "working" }],
    capturedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(okCp.ok, true);

  // runtime-events：run_state_changed 不进 chat_agent_events；settled 三值不变
  const { contractToLegacyEvents, createEmitter } = await import("../lib/agent/runtime-events.ts");
  const emitter = createEmitter("trace-r0", 1);
  const stateEnv = emitter.wrap({
    type: "run_state_changed",
    from: "running",
    to: "paused",
    trigger: "recoverable_guard",
  });
  assert.deepEqual(contractToLegacyEvents(stateEnv), []);

  for (const outcome of ["completed", "aborted", "error"] as const) {
    const settled = emitter.wrap({ type: "run_settled", outcome });
    assert.deepEqual(contractToLegacyEvents(settled), []);
    assert.equal(settled.event.type, "run_settled");
    if (settled.event.type === "run_settled") {
      assert.equal(settled.event.outcome, outcome);
    }
  }

  console.log("run-contract: all checks passed ✓");
})();

if (process.argv[1]?.includes("run-contract.test")) {
  runContractTestPromise.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
