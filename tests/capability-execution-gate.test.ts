import assert from "node:assert/strict";
import {
  CapabilityExecutionLedger,
  capabilityIdsForTool,
  evaluateExecutionRequirements,
  executionRequirementsFromToolGroups,
  executionRequirementsForSpreadsheetTask,
} from "../lib/capability/execution-gate.ts";

export const capabilityExecutionGateTestPromise = (async () => {
  const ledger = new CapabilityExecutionLedger();
  ledger.seed("agent.turn");
  ledger.record({
    type: "tool_started",
    toolName: "patch_workbook",
    toolCallId: "write-1",
  });
  let gate = evaluateExecutionRequirements(
    executionRequirementsForSpreadsheetTask({
      hasSpreadsheet: true,
      needsWrite: true,
      needsValidation: true,
    }),
    ledger.snapshot(),
  );
  assert.equal(gate.ok, false, "tool_started must not satisfy an execution contract");

  ledger.record({
    type: "tool_completed",
    toolCallId: "write-1",
    isError: true,
  });
  gate = evaluateExecutionRequirements(
    [{ id: "write", anyOf: ["spreadsheet.write"] }],
    ledger.snapshot(),
  );
  assert.equal(gate.ok, false, "failed tools must not satisfy an execution contract");

  ledger.record({
    type: "tool_completed",
    toolCallId: "write-1",
    isError: false,
  });
  gate = evaluateExecutionRequirements(
    [
      { id: "read", anyOf: ["spreadsheet.read"] },
      { id: "write", anyOf: ["spreadsheet.write"] },
    ],
    ledger.snapshot(),
  );
  assert.equal(gate.ok, true, "successful patch_workbook must prove read and write semantics");

  ledger.record({
    type: "tool_started",
    toolName: "finalize_deliverable",
    toolCallId: "validate-1",
  });
  ledger.record({
    type: "tool_completed",
    toolCallId: "validate-1",
    isError: false,
  });
  gate = evaluateExecutionRequirements(
    [{ id: "validate", anyOf: ["spreadsheet.validate"] }],
    ledger.snapshot(),
  );
  assert.equal(gate.ok, true, "finalize_deliverable must prove validation semantics");

  const grouped = executionRequirementsFromToolGroups([
    "check_reimbursement|analyze_tabular|search|read",
  ]);
  gate = evaluateExecutionRequirements(grouped, ledger.snapshot());
  assert.equal(gate.ok, false);

  const readLedger = new CapabilityExecutionLedger();
  readLedger.record({ type: "tool_started", toolName: "Read", toolCallId: "read-1" });
  readLedger.record({ type: "tool_completed", toolCallId: "read-1", isError: false });
  gate = evaluateExecutionRequirements(grouped, readLedger.snapshot());
  assert.equal(gate.ok, true, "OR tool groups must accept one successful alternative");

  assert.deepEqual(
    capabilityIdsForTool("check-workbook-ties"),
    [
      "check_workbook_ties",
      "finance-tool.check_workbook_ties",
      "spreadsheet.read",
      "spreadsheet.validate",
    ],
  );
  assert.ok(
    capabilityIdsForTool("search_knowledge").includes("retrieval.search"),
    "governed knowledge tools must prove the retrieval.search task capability",
  );

  console.log("capability-execution-gate: successful completion facts and semantic requirements passed ✓");
})();

if (process.argv[1]?.includes("capability-execution-gate.test")) {
  capabilityExecutionGateTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
