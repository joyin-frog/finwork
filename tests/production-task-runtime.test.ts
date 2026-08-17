import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskContract } from "../lib/agent/run-contract.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import { beginProductionTaskRun } from "../lib/task/production-runtime.ts";
import type { TaskContractV3 } from "../lib/task/contracts.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

function contract(taskKind: TaskContract["taskKind"]): TaskContract {
  return {
    version: 1,
    taskKind,
    ...(taskKind === "text" ? {} : {
      spreadsheetRequirement: {
        needsLegacyXlsRead: false,
        needsWrite: true,
        needsRecalc: true,
        needsRender: false,
        needsMacroPreservation: false,
      },
    }),
    requiredDeliverables: taskKind === "text" ? [] : [{
      id: "workbook",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      count: 1,
      qualityProfile: "generic",
    }],
    expectationSnapshot: {},
  };
}

function readOnlySpreadsheetContract(): TaskContract {
  return {
    version: 1,
    taskKind: "spreadsheet",
    spreadsheetRequirement: {
      needsLegacyXlsRead: false,
      needsWrite: false,
      needsRecalc: false,
      needsRender: false,
      needsMacroPreservation: false,
    },
    requiredDeliverables: [],
    expectationSnapshot: {},
  };
}

function recordSpreadsheetExecution(
  run: ReturnType<typeof beginProductionTaskRun>,
): void {
  run.recordRuntimeEvent({
    type: "tool_started",
    toolName: "patch_workbook",
    toolCallId: `${run.taskId}:patch`,
  });
  run.recordRuntimeEvent({
    type: "tool_completed",
    toolCallId: `${run.taskId}:patch`,
    isError: false,
  });
  run.recordRuntimeEvent({
    type: "tool_started",
    toolName: "finalize_deliverable",
    toolCallId: `${run.taskId}:finalize`,
  });
  run.recordRuntimeEvent({
    type: "tool_completed",
    toolCallId: `${run.taskId}:finalize`,
    isError: false,
  });
  recordAgentCompletion(run);
}

function recordAgentCompletion(run: ReturnType<typeof beginProductionTaskRun>): void {
  run.recordRuntimeEvent({ type: "message_started", channel: "text" });
  run.recordRuntimeEvent({ type: "message_completed", channel: "text", content: "done" });
  run.completeExecution();
}

function benchmarkArtifactContract(
  suffix: string,
  options: {
    logicalName?: string;
    mediaType?: string;
    evidenceRequirements?: TaskContractV3["evidenceRequirements"];
  } = {},
): TaskContractV3 {
  return {
    id: `benchmark-task:${suffix}`,
    version: 3,
    goal: `Produce benchmark artifact ${suffix}.`,
    caseId: `benchmark-case:${suffix}`,
    businessContext: {
      entities: [], counterparties: [], periods: [], currencies: [], units: [],
      accountingStandards: [], jurisdictions: [],
    },
    inputs: [],
    requiredCapabilities: [{ capabilityId: "agent.turn", versionRange: "^1.0.0", required: true }],
    invariants: [{
      id: "task-contract-delivery-gate",
      validatorId: "task-contract.delivery-gate",
      severity: "blocking",
      parameters: {},
    }],
    expectedOutputs: [{
      id: "benchmark-output",
      mediaType: options.mediaType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      logicalName: options.logicalName ?? "result.xlsx",
      count: 1,
      validatorIds: ["validator.workbook"],
      immutableDelivery: true,
    }],
    evidenceRequirements: options.evidenceRequirements ?? [],
    humanDecisionPoints: [],
    noGuess: ["Do not guess."],
    noDegrade: ["Do not self-report validation."],
    security: {
      classification: "public",
      allowedPrincipals: [{ id: "benchmark-runner", type: "service", tenantId: "benchmark" }],
      allowExternalEgress: false,
      allowedDomains: [],
      requireEncryptionAtRest: true,
      requireHumanApprovalForExport: false,
    },
    retention: {
      policyId: "benchmark-ephemeral",
      legalHold: false,
      allowUserDeletionRequest: true,
      gracePeriodDays: 0,
    },
    budget: {
      tokenLimit: 1000, wallTimeMs: 30_000, cpuTimeMs: null,
      memoryBytes: 64 * 1024 * 1024, diskBytes: 128 * 1024 * 1024,
      networkBytes: 1024, toolOutputBytes: 2048, concurrency: 1, retryLimit: 0,
    },
  };
}

export const productionTaskRuntimeTestPromise = (async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-production-task-"));
  const previousDataRoot = process.env.FINANCE_AGENT_APP_DATA_DIR;
  process.env.FINANCE_AGENT_APP_DATA_DIR = dataRoot;
  const db = makeDb();
  try {
    const inputRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000001",
      conversationId: 11,
      goal: "Explain the variance.",
      attachments: [{
        name: "variance.txt",
        mimeType: "text/plain",
        size: 12,
        dataUrl: "data:text/plain;base64,dmFyaWFuY2U=",
      }],
      legacyContract: contract("text"),
      casRoot: path.join(dataRoot, "cas"),
    });
    inputRun.recordRuntimeEvent({ type: "tool_started", toolName: "read_document", toolCallId: "read-input" });
    inputRun.recordRuntimeEvent({ type: "tool_completed", toolCallId: "read-input", isError: false });
    recordAgentCompletion(inputRun);
    inputRun.markValidating();
    inputRun.settle({ outcome: "completed" });
    assert.equal(
      (db.prepare("SELECT state FROM cases WHERE case_id = ?").get(inputRun.caseId) as { state: string }).state,
      "delivered",
    );
    assert.equal(inputRun.foundation.caseId, inputRun.caseId);
    assert.equal(inputRun.foundation.taskId, inputRun.taskId);
    const inputCase = db.prepare(
      "SELECT case_kind, run_id FROM cases WHERE case_id = ?",
    ).get(inputRun.caseId) as { case_kind: string; run_id: string };
    assert.equal(inputCase.case_kind, "general_finance");
    assert.equal(inputCase.run_id, inputRun.foundation.runId);
    const inputBinding = db.prepare(
      "SELECT state, role_id, capability_ids_json FROM case_run_bindings WHERE case_id = ? AND run_id = ?",
    ).get(inputRun.caseId, inputRun.foundation.runId) as {
      state: string;
      role_id: string;
      capability_ids_json: string;
    };
    assert.equal(inputBinding.state, "succeeded");
    assert.equal(inputBinding.role_id, "finance-primary");
    assert.deepEqual(JSON.parse(inputBinding.capability_ids_json), ["agent.turn"]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM artifact_refs WHERE owner_id = ? AND ref_type = 'case_input'")
        .get(inputRun.caseId) as { count: number }).count,
      1,
    );

    const readOnlyRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000009",
      conversationId: 12,
      goal: "分析下这个报表",
      attachments: [{
        name: "report.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 12,
        dataUrl: "data:application/octet-stream;base64,dGVzdA==",
      }],
      legacyContract: readOnlySpreadsheetContract(),
      casRoot: path.join(dataRoot, "cas"),
    });
    const persistedReadOnlyContract = JSON.parse((db.prepare(
      "SELECT contract_json FROM task_contracts WHERE task_id = ?",
    ).get(readOnlyRun.taskId) as { contract_json: string }).contract_json) as TaskContractV3;
    assert.deepEqual(
      persistedReadOnlyContract.requiredCapabilities.map((item) => item.capabilityId),
      ["agent.turn", "spreadsheet.read"],
    );
    assert.deepEqual(persistedReadOnlyContract.expectedOutputs, []);
    assert.ok(!persistedReadOnlyContract.noDegrade.includes("spreadsheet.write"));
    assert.ok(!persistedReadOnlyContract.noDegrade.includes("spreadsheet.validate"));
    readOnlyRun.recordRuntimeEvent({
      type: "tool_started",
      toolName: "read",
      toolCallId: "read-xlsx-skill",
      input: { path: "/opt/finwork/skills/xlsx/SKILL.md" },
    });
    readOnlyRun.recordRuntimeEvent({
      type: "tool_completed",
      toolName: "read",
      toolCallId: "read-xlsx-skill",
      isError: false,
    });
    readOnlyRun.recordRuntimeEvent({ type: "message_started", channel: "text" });
    readOnlyRun.recordRuntimeEvent({ type: "message_completed", channel: "text", content: "开始读取报表" });
    const persistedBeforeInput = db.prepare(`
      SELECT s.step_key,s.status FROM case_plan_steps s
      JOIN case_plan_versions p ON p.plan_id=s.plan_id
      WHERE p.case_id=?
    `).all(readOnlyRun.caseId) as Array<{ step_key: string; status: string }>;
    assert.notEqual(
      persistedBeforeInput.find((step) => step.step_key === "execute")?.status,
      "running",
      "读取 Skill 和中间说明文字不得提前启动 execute",
    );
    assert.notEqual(
      persistedBeforeInput.find((step) => step.step_key === "inspect_inputs")?.status,
      "succeeded",
      "读取 Skill 说明不得冒充已读取用户输入",
    );
    readOnlyRun.recordRuntimeEvent({
      type: "tool_started",
      toolName: "list_workspace_files",
      toolCallId: "list-read-only-sheet",
    });
    readOnlyRun.recordRuntimeEvent({
      type: "tool_completed",
      toolName: "list_workspace_files",
      toolCallId: "list-read-only-sheet",
      isError: false,
    });
    const persistedAfterList = db.prepare(`
      SELECT s.step_key,s.status FROM case_plan_steps s
      JOIN case_plan_versions p ON p.plan_id=s.plan_id
      WHERE p.case_id=?
    `).all(readOnlyRun.caseId) as Array<{ step_key: string; status: string }>;
    assert.equal(persistedAfterList.find((step) => step.step_key === "inspect_inputs")?.status, "running");
    assert.notEqual(persistedAfterList.find((step) => step.step_key === "execute")?.status, "running");
    readOnlyRun.recordRuntimeEvent({
      type: "tool_started",
      toolName: "read_workspace_file",
      toolCallId: "read-only-sheet",
    });
    readOnlyRun.recordRuntimeEvent({
      type: "tool_completed",
      toolName: "read_workspace_file",
      toolCallId: "read-only-sheet",
      isError: false,
    });
    readOnlyRun.recordRuntimeEvent({
      type: "tool_completed",
      toolName: "generate_business_analysis",
      toolCallId: "analyze-read-only-sheet",
      isError: false,
      structured: {
        provenance: {
          sources: [{ kind: "workbook", logicalName: "report.xlsx", factCount: 2 }],
          workbookFacts: [{
            field: "incomeStatement.revenue",
            value: 55_379_467.47,
            locator: { kind: "sheet_range", sheet: "利润表", range: "D5" },
          }, {
            field: "cashFlow.operatingCashFlow",
            value: -11_130_687.72,
            locator: { kind: "sheet_range", sheet: "现金流量表", range: "I12" },
          }],
        },
      },
    });
    recordAgentCompletion(readOnlyRun);
    readOnlyRun.markValidating();
    assert.equal(readOnlyRun.settle({ outcome: "completed" }).state, "delivered");
    const cellEvidence = db.prepare(`
      SELECT locator_json FROM evidence_records
      WHERE case_id=? AND evidence_type='extraction'
    `).all(readOnlyRun.caseId) as Array<{ locator_json: string }>;
    assert.deepEqual(new Set(cellEvidence.map((row) => {
      const locator = JSON.parse(row.locator_json) as { sheet: string; range: string };
      return `${locator.sheet}!${locator.range}`;
    })), new Set(["利润表!D5", "现金流量表!I12"]));
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM citation_records").get() as { count: number }).count,
      2,
      "经营分析字段必须形成单元格级 citation",
    );

    const benchmarkContract: TaskContractV3 = {
      id: "benchmark-task:budget-preserved",
      version: 3,
      goal: "Answer the private-oracle-free benchmark prompt.",
      caseId: "benchmark-case:budget-preserved",
      businessContext: {
        entities: [],
        counterparties: [],
        periods: [],
        currencies: [],
        units: [],
        accountingStandards: [],
        jurisdictions: [],
      },
      inputs: [],
      requiredCapabilities: [{ capabilityId: "agent.turn", versionRange: "^1.0.0", required: true }],
      invariants: [],
      expectedOutputs: [],
      evidenceRequirements: [],
      humanDecisionPoints: [],
      noGuess: ["Do not invent facts."],
      noDegrade: ["Do not replace evidence with self-report."],
      security: {
        classification: "public",
        allowedPrincipals: [{ id: "benchmark-runner", type: "service", tenantId: "benchmark" }],
        allowExternalEgress: false,
        allowedDomains: [],
        requireEncryptionAtRest: true,
        requireHumanApprovalForExport: false,
      },
      retention: {
        policyId: "benchmark-ephemeral",
        legalHold: false,
        allowUserDeletionRequest: true,
        gracePeriodDays: 0,
      },
      budget: {
        tokenLimit: 321,
        wallTimeMs: 12_345,
        cpuTimeMs: null,
        memoryBytes: 64 * 1024 * 1024,
        diskBytes: 128 * 1024 * 1024,
        networkBytes: 1024,
        toolOutputBytes: 2048,
        concurrency: 1,
        retryLimit: 0,
      },
    };
    const benchmarkRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000006",
      goal: benchmarkContract.goal,
      attachments: [],
      legacyContract: contract("text"),
      taskContract: benchmarkContract,
      principalId: "benchmark-runner",
      tenantId: "benchmark",
      casRoot: path.join(dataRoot, "cas"),
    });
    assert.equal(benchmarkRun.taskId, benchmarkContract.id);
    assert.equal(benchmarkRun.caseId, benchmarkContract.caseId);
    assert.deepEqual(benchmarkRun.foundation.budget, benchmarkContract.budget);
    const persistedBenchmarkContract = JSON.parse((db.prepare(
      "SELECT contract_json FROM task_contracts WHERE task_id = ?",
    ).get(benchmarkRun.taskId) as { contract_json: string }).contract_json) as TaskContractV3;
    assert.deepEqual(persistedBenchmarkContract.budget, benchmarkContract.budget);
    recordAgentCompletion(benchmarkRun);
    const benchmarkSettlement = benchmarkRun.settle({ outcome: "completed" });
    assert.equal(benchmarkSettlement.state, "delivered");
    assert.equal(benchmarkSettlement.stableFailureCode, null);
    assert.equal(benchmarkSettlement.validation.delivery.required, false);
    assert.equal(benchmarkSettlement.validation.delivery.passed, true);
    assert.ok(benchmarkSettlement.validation.assertions.passed >= 1);
    assert.deepEqual(benchmarkRun.getSettlement(), benchmarkSettlement);

    db.prepare("INSERT INTO chat_conversations(id, title) VALUES (?, ?)").run(11, "production task");
    const messageId = Number(db.prepare(
      "INSERT INTO chat_messages(conversation_id, role, content) VALUES (?, 'assistant', ?)"
    ).run(11, "Delivered workbook").lastInsertRowid);
    const outputDir = path.join(dataRoot, "files", "11", "generate");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, "result.xlsx"), Buffer.from("xlsx-fixture"));
    db.prepare(`
      INSERT INTO chat_attachments(id, message_id, file_name, mime_type, size_bytes, storage_path, role)
      VALUES (?, ?, ?, ?, ?, ?, 'assistant')
    `).run(
      "attachment-output",
      messageId,
      "result.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      12,
      "generate/result.xlsx",
    );

    const deliveredRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000002",
      conversationId: 11,
      goal: "Create a validated workbook.",
      attachments: [],
      legacyContract: contract("spreadsheet"),
      casRoot: path.join(dataRoot, "cas"),
    });
    recordSpreadsheetExecution(deliveredRun);
    deliveredRun.markValidating();
    deliveredRun.settle({ outcome: "completed", assistantMessageId: messageId });
    assert.equal(
      (db.prepare("SELECT state FROM cases WHERE case_id = ?").get(deliveredRun.caseId) as { state: string }).state,
      "delivered",
    );
    assert.equal(
      (db.prepare("SELECT state FROM case_run_bindings WHERE case_id = ? AND run_id = ?")
        .get(deliveredRun.caseId, deliveredRun.foundation.runId) as { state: string }).state,
      "succeeded",
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE owner_case_id = ? AND lifecycle_state = 'delivered'")
        .get(deliveredRun.caseId) as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM evidence_records WHERE case_id = ? AND evidence_type = 'delivery'")
        .get(deliveredRun.caseId) as { count: number }).count,
      1,
    );

    const wrongNameContract = benchmarkArtifactContract("wrong-name", { logicalName: "required.xlsx" });
    const wrongNameRun = beginProductionTaskRun({
      db, traceId: "00000000-0000-4000-8000-000000000011", conversationId: 11,
      goal: wrongNameContract.goal, attachments: [], legacyContract: contract("text"),
      taskContract: wrongNameContract, principalId: "benchmark-runner", tenantId: "benchmark",
      casRoot: path.join(dataRoot, "cas"),
    });
    recordAgentCompletion(wrongNameRun);
    assert.throws(
      () => wrongNameRun.settle({ outcome: "completed", assistantMessageId: messageId }),
      /foundation_delivery_artifact_missing/,
    );
    assert.equal(wrongNameRun.getSettlement()?.stableFailureCode, "foundation_delivery_artifact_missing");

    const missingValidatorContract = benchmarkArtifactContract("missing-validator");
    const missingValidatorRun = beginProductionTaskRun({
      db, traceId: "00000000-0000-4000-8000-000000000012", conversationId: 11,
      goal: missingValidatorContract.goal, attachments: [], legacyContract: contract("text"),
      taskContract: missingValidatorContract, principalId: "benchmark-runner", tenantId: "benchmark",
      casRoot: path.join(dataRoot, "cas"),
    });
    recordAgentCompletion(missingValidatorRun);
    assert.throws(
      () => missingValidatorRun.settle({ outcome: "completed", assistantMessageId: messageId }),
      /foundation_required_validator_missing/,
    );
    assert.equal(missingValidatorRun.getSettlement()?.stableFailureCode, "foundation_required_validator_missing");

    const missingEvidenceContract = benchmarkArtifactContract("missing-evidence", {
      evidenceRequirements: [{ evidenceType: "transform", minimumCount: 1, requiresLocator: true }],
    });
    const missingEvidenceRun = beginProductionTaskRun({
      db, traceId: "00000000-0000-4000-8000-000000000013", conversationId: 11,
      goal: missingEvidenceContract.goal, attachments: [], legacyContract: contract("text"),
      taskContract: missingEvidenceContract, principalId: "benchmark-runner", tenantId: "benchmark",
      casRoot: path.join(dataRoot, "cas"),
    });
    recordAgentCompletion(missingEvidenceRun);
    db.prepare(`
      INSERT INTO assertion_results
        (assertion_id, case_id, validator_id, status, blocking, details_json)
      VALUES (?, ?, 'validator.workbook', 'passed', 0, '{}')
    `).run("workbook-validator", missingEvidenceRun.caseId);
    assert.throws(
      () => missingEvidenceRun.settle({ outcome: "completed", assistantMessageId: messageId }),
      /foundation_required_evidence_missing/,
    );
    assert.equal(missingEvidenceRun.getSettlement()?.stableFailureCode, "foundation_required_evidence_missing");

    const strictSuccessContract = benchmarkArtifactContract("strict-success");
    const strictSuccessRun = beginProductionTaskRun({
      db, traceId: "00000000-0000-4000-8000-000000000014", conversationId: 11,
      goal: strictSuccessContract.goal, attachments: [], legacyContract: contract("text"),
      taskContract: strictSuccessContract, principalId: "benchmark-runner", tenantId: "benchmark",
      casRoot: path.join(dataRoot, "cas"),
    });
    recordAgentCompletion(strictSuccessRun);
    db.prepare(`
      INSERT INTO assertion_results
        (assertion_id, case_id, validator_id, status, blocking, details_json)
      VALUES (?, ?, 'validator.workbook', 'passed', 0, '{}')
    `).run("workbook-validator", strictSuccessRun.caseId);
    const strictSuccessSettlement = strictSuccessRun.settle({ outcome: "completed", assistantMessageId: messageId });
    assert.equal(strictSuccessSettlement.state, "delivered");
    assert.equal(strictSuccessSettlement.validation.delivery.delivered, 1);
    assert.equal(strictSuccessSettlement.validation.delivery.passed, true);

    const missingRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000003",
      conversationId: 11,
      goal: "Create another workbook.",
      attachments: [],
      legacyContract: contract("spreadsheet"),
      casRoot: path.join(dataRoot, "cas"),
    });
    recordSpreadsheetExecution(missingRun);
    assert.throws(
      () => missingRun.settle({ outcome: "completed", assistantMessageId: messageId + 999 }),
      /foundation delivery gate failed/,
    );
    assert.equal(
      (db.prepare("SELECT state FROM cases WHERE case_id = ?").get(missingRun.caseId) as { state: string }).state,
      "failed",
    );
    assert.equal(
      (db.prepare("SELECT state FROM case_run_bindings WHERE case_id = ? AND run_id = ?")
        .get(missingRun.caseId, missingRun.foundation.runId) as { state: string }).state,
      "failed",
    );

    const capabilityMissingRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000004",
      conversationId: 11,
      goal: "Do not accept an unverified workbook claim.",
      attachments: [],
      legacyContract: contract("spreadsheet"),
      casRoot: path.join(dataRoot, "cas"),
    });
    capabilityMissingRun.recordRuntimeEvent({
      type: "tool_started",
      toolName: "patch_workbook",
      toolCallId: "uncompleted-write",
    });
    recordAgentCompletion(capabilityMissingRun);
    assert.throws(
      () => capabilityMissingRun.settle({ outcome: "completed", assistantMessageId: messageId }),
      /foundation capability gate failed/,
    );
    assert.equal(
      (db.prepare("SELECT state FROM cases WHERE case_id = ?").get(capabilityMissingRun.caseId) as { state: string }).state,
      "failed",
    );

    const abortedRun = beginProductionTaskRun({
      db,
      traceId: "00000000-0000-4000-8000-000000000005",
      goal: "Cancel safely.",
      attachments: [],
      legacyContract: contract("text"),
      casRoot: path.join(dataRoot, "cas"),
    });
    abortedRun.settle({ outcome: "aborted", message: "user stop" });
    assert.equal(
      (db.prepare("SELECT state FROM cases WHERE case_id = ?").get(abortedRun.caseId) as { state: string }).state,
      "canceled",
    );
    assert.equal(
      (db.prepare("SELECT state FROM case_run_bindings WHERE case_id = ? AND run_id = ?")
        .get(abortedRun.caseId, abortedRun.foundation.runId) as { state: string }).state,
      "canceled",
    );
  } finally {
    db.close();
    if (previousDataRoot === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = previousDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  }
  console.log("production-task-runtime: real task, artifact and evidence settlement checks passed ✓");
})();

if (process.argv[1]?.includes("production-task-runtime.test")) {
  productionTaskRuntimeTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
