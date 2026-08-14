import assert from "node:assert/strict";
import {
  mineBenchmarkGapProposals,
  parseBenchmarkGapCliArgs,
} from "../lib/evaluation/benchmarks/gap-miner.ts";
import { BenchmarkCaseResultV2Schema } from "../lib/evaluation/benchmarks/contracts.ts";

const failed = BenchmarkCaseResultV2Schema.parse({
  caseId: "spreadsheetbench_v2:v1:case-1",
  datasetId: "spreadsheetbench_v2",
  status: "failed",
  faultDomain: "validator",
  scores: {
    exactMatch: null,
    numericAccuracy: null,
    tokenF1: null,
    citationPrecision: null,
    citationRecall: null,
    artifact: 0,
    contract: 0,
    performance: 1,
  },
  failures: ["artifact_check_failed:spreadsheetbench_v2_cells"],
  capabilities: ["spreadsheet_editing"],
  metrics: { wallTimeMs: 10, tokens: 3, retries: 0, toolCalls: 2 },
  details: {},
  execution: {
    traceId: "trace-1",
    caseId: "spreadsheetbench_v2:v1:case-1",
    taskId: "task-1",
    runId: "run-1",
    conversationId: 1,
    inputTokens: 2,
    outputTokens: 1,
    latencyMs: 10,
    retries: 0,
    costUsd: null,
    artifactRefs: [],
    evidenceRefs: [],
    validation: {
      assertions: { total: 1, passed: 0, failed: 1 },
      delivery: { required: true, delivered: 0, passed: false },
    },
    termination: { cancelled: false, aborted: false, timedOut: false },
    stableFailureCode: null,
  },
});

assert.deepEqual(parseBenchmarkGapCliArgs(["--", "report.json", "proposals.json"]), {
  reportArgument: "report.json",
  outputArgument: "proposals.json",
});
assert.deepEqual(parseBenchmarkGapCliArgs(["report.json"]), { reportArgument: "report.json" });
assert.throws(() => parseBenchmarkGapCliArgs(["--"]), /Usage:/);
assert.throws(() => parseBenchmarkGapCliArgs(["one", "two", "three"]), /Usage:/);

const proposals = mineBenchmarkGapProposals([failed]);
assert.equal(proposals.length, 1);
assert.equal(proposals[0]?.status, "proposal");
assert.equal(proposals[0]?.faultDomain, "validator");
assert.match(proposals[0]?.recommendedFixture ?? "", /deterministic artifact assertion/);

console.log("benchmark-gap-miner: v2 results and pnpm positional CLI parsing passed ✓");
