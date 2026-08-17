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
    deriveTaskContractForTurn,
    spreadsheetOutputRequested,
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

  const textEmpty = validateTaskContract({
    version: 1,
    taskKind: "text",
    requiredDeliverables: [],
    expectationSnapshot: {},
  });
  assert.equal(textEmpty.ok, true);

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

  // deriveTaskContractForTurn
  {
    const text = deriveTaskContractForTurn({ intent: "direct", attachments: [] });
    assert.equal(text.taskKind, "text");
    assert.equal(text.requiredDeliverables.length, 0);
    assert.equal(validateTaskContract(text).ok, true);

    const sheet = deriveTaskContractForTurn({
      intent: "tool_use",
      attachments: [{ name: "a.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
    });
    assert.equal(sheet.taskKind, "spreadsheet");
    assert.equal(sheet.requiredDeliverables[0]?.id, "workbook");
    assert.equal(sheet.requiredDeliverables[0]?.qualityProfile, "generic");
    assert.equal(sheet.spreadsheetRequirement?.needsRecalc, false);
    assert.equal(validateTaskContract(sheet).ok, true);

    const readOnlyAnalysis = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [{ name: "财务报表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
      userMessage: "分析下这个报表",
    });
    assert.equal(readOnlyAnalysis.taskKind, "spreadsheet");
    assert.equal(readOnlyAnalysis.spreadsheetRequirement?.needsWrite, false);
    assert.equal(readOnlyAnalysis.spreadsheetRequirement?.needsRecalc, false);
    assert.equal(readOnlyAnalysis.requiredDeliverables.length, 0);
    assert.equal(validateTaskContract(readOnlyAnalysis).ok, true);

    const requestedWorkbook = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [{ name: "财务报表.xlsx" }],
      userMessage: "分析后生成一份 Excel 分析表",
    });
    assert.equal(requestedWorkbook.taskKind, "spreadsheet");
    assert.equal(requestedWorkbook.spreadsheetRequirement?.needsWrite, true);
    assert.equal(requestedWorkbook.requiredDeliverables[0]?.id, "workbook");

    assert.equal(spreadsheetOutputRequested("可以做成 Excel 么"), true);
    assert.equal(spreadsheetOutputRequested("你生成的 Excel 都没有公式"), false);

    const acceptedWorkbookContinuation = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [],
      priorAttachments: [{ name: "财务报表.xlsx" }],
      userMessage: "好",
      messages: [
        { role: "user", content: "可以做成Excel么，里面有数据，也可以做成条状图和饼图" },
        { role: "assistant", content: "可以，我可以直接生成带图表的 Excel 工作簿。" },
        { role: "user", content: "好" },
      ],
    });
    assert.equal(acceptedWorkbookContinuation.taskKind, "spreadsheet");
    assert.equal(acceptedWorkbookContinuation.spreadsheetRequirement?.needsWrite, true);
    assert.equal(acceptedWorkbookContinuation.requiredDeliverables.length, 1);

    const generatedWorkbookQuestion = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [],
      priorAttachments: [{ name: "财务报表.xlsx" }],
      userMessage: "你为什么不能插入图表？",
      messages: [{ role: "user", content: "你为什么不能插入图表？" }],
    });
    assert.equal(generatedWorkbookQuestion.taskKind, "spreadsheet");
    assert.equal(generatedWorkbookQuestion.spreadsheetRequirement?.needsWrite, false);
    assert.equal(generatedWorkbookQuestion.requiredDeliverables.length, 0);

    const acceptedFormulaRepair = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [],
      priorAttachments: [{ name: "财务报表.xlsx" }, { name: "管理层分析.xlsx" }],
      userMessage: "可以",
      messages: [
        { role: "user", content: "你生成的Excel都没有公式，我不敢置信" },
        { role: "assistant", content: "我可以直接重做一版公式化分析 Excel。" },
        { role: "user", content: "可以" },
      ],
    });
    assert.equal(acceptedFormulaRepair.spreadsheetRequirement?.needsWrite, true);
    assert.equal(acceptedFormulaRepair.requiredDeliverables.length, 1);

    const staleWorkbookOffer = deriveTaskContractForTurn({
      intent: "direct",
      attachments: [],
      priorAttachments: [{ name: "财务报表.xlsx" }],
      userMessage: "好",
      messages: [
        { role: "assistant", content: "我可以生成一份 Excel 分析表。" },
        { role: "user", content: "先解释一下亏损原因。" },
        { role: "assistant", content: "需要我再展开说明销售费用吗？" },
        { role: "user", content: "好" },
      ],
    });
    assert.equal(staleWorkbookOffer.taskKind, "text");
    assert.equal(staleWorkbookOffer.requiredDeliverables.length, 0);

    const requestedTextReport = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [{ name: "财务报表.xlsx" }],
      userMessage: "分析并生成一份文字报告",
    });
    assert.equal(requestedTextReport.taskKind, "spreadsheet");
    assert.equal(requestedTextReport.spreadsheetRequirement?.needsWrite, false);
    assert.equal(requestedTextReport.requiredDeliverables.length, 0);

    const requestedEdit = deriveTaskContractForTurn({
      intent: "tool_use",
      attachments: [{ name: "财务报表.xlsx" }],
      userMessage: "把错误公式修复一下",
    });
    assert.equal(requestedEdit.spreadsheetRequirement?.needsWrite, true);
    assert.equal(requestedEdit.requiredDeliverables.length, 1);

    const complex = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [{ name: "legacy.xls" }],
    });
    assert.equal(complex.taskKind, "financial_consolidation");
    assert.equal(complex.spreadsheetRequirement?.needsLegacyXlsRead, true);
    assert.equal(complex.spreadsheetRequirement?.needsRecalc, true);
    assert.equal(complex.requiredDeliverables[0]?.qualityProfile, "financial_consolidation");
    assert.equal(validateTaskContract(complex).ok, true);

    // CR-R2：无表格附件时，complex intent 也不得强加 workbook
    const complexTextOnly = deriveTaskContractForTurn({
      intent: "complex_workflow",
      attachments: [],
    });
    assert.equal(complexTextOnly.taskKind, "text");
    assert.equal(complexTextOnly.requiredDeliverables.length, 0);
  }

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
