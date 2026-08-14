import assert from "node:assert/strict";
import {
  BenchmarkPredictionSchema,
  NormalizedBenchmarkCaseSchema,
  type NormalizedBenchmarkCase,
} from "../lib/evaluation/benchmarks/contracts.ts";
import { partitionBenchmarkCase } from "../lib/evaluation/benchmarks/case-boundary.ts";
import { createBenchmarkTaskContract } from "../lib/evaluation/benchmarks/task-contract.ts";
import {
  createModelMatrixPlan,
  prepareCasesForEvaluationLayer,
  selectCasesForEvaluationLayer,
} from "../lib/evaluation/benchmarks/evaluation-layers.ts";
import { createDirectModelBenchmarkExecutor } from "../lib/evaluation/benchmarks/model-executor.ts";
import type { AgentSettings } from "../lib/settings/agent-settings.ts";

const SHA = "b".repeat(64);

function benchmarkCase(id: string, kind: "model" | "agent"): NormalizedBenchmarkCase {
  return NormalizedBenchmarkCaseSchema.parse({
    schemaVersion: 1,
    id: `finqa:v1:${id}`,
    datasetId: "finqa",
    datasetVersion: "v1",
    upstreamCaseId: id,
    split: "test",
    locale: "en-US",
    taskKind: kind === "model" ? "qa" : "rag",
    prompt: "What is six times seven?",
    context: { textBlocks: [{ id: "source", text: "Six times seven is 42." }], tables: [], conversation: [], files: [] },
    expected: {
      answers: ["42"], numericAnswers: [42], programs: [],
      citations: [{ sourceId: "source" }],
      assertions: kind === "model" ? ["agent-only-source-assertion"] : [],
    },
    capabilities: kind === "model" ? ["financial_qa"] : ["retrieval", "citation"],
    tags: ["test"],
    provenance: {
      sourceSha256: SHA,
      sourceRecordIndex: 0,
      homepage: "https://example.invalid/benchmark",
      upstreamRef: "fixture",
      licenseStatus: "verified",
    },
  });
}

async function main(): Promise<void> {
const modelCase = benchmarkCase("model", "model");
const agentCase = benchmarkCase("agent", "agent");
assert.deepEqual(selectCasesForEvaluationLayer([modelCase, agentCase], "model").map((item) => item.id), [modelCase.id]);
assert.deepEqual(selectCasesForEvaluationLayer([modelCase, agentCase], "agent").map((item) => item.id), [agentCase.id]);
const [preparedModelCase] = prepareCasesForEvaluationLayer([modelCase, agentCase], "model");
assert.ok(preparedModelCase);
assert.deepEqual(preparedModelCase.expected.citations, [], "Layer 3 must not score imported provenance locators");
assert.deepEqual(preparedModelCase.expected.assertions, [], "Layer 3 must not score Agent-only deterministic assertions");
assert.equal(modelCase.expected.citations.length, 1, "Layer projection must not mutate the imported case");

const plan = createModelMatrixPlan({
  candidates: ["model-a", "model-b"],
  repetitions: 2,
  cases: [modelCase, agentCase],
});
assert.equal(plan.runs.length, 4, "2 models × 2 repetitions × 1 answer-only case");
assert.throws(() => createModelMatrixPlan({ candidates: ["model-a"], repetitions: 1, cases: [modelCase] }));

const settings: AgentSettings = {
  apiUrl: "https://provider.invalid",
  apiKey: "test-key",
  companyName: "",
  agentName: "Test",
  userName: "",
  userAvatar: "",
  fastModel: "fast",
  reasoningModel: "reasoning",
  roleMode: "tech",
  telemetryEnabled: false,
  telemetryEndpoint: "",
  telemetryToken: "",
  telemetryInstallId: "test",
};
let requestBody: Record<string, unknown> | undefined;
let clock = 100;
const executor = createDirectModelBenchmarkExecutor({
  model: "model-a",
  readSettings: async () => settings,
  now: () => ++clock,
  fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "model-a-actual",
      content: [{ type: "text", text: "42" }],
      usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
const { executionCase } = partitionBenchmarkCase(preparedModelCase);
const task = createBenchmarkTaskContract(executionCase, { tokenLimit: 100, wallTimeMs: 1_000 });
const prediction = BenchmarkPredictionSchema.parse(await executor(executionCase, {
  taskContract: task.contract,
  missingExternalInputs: [],
}));
assert.equal(prediction.answer, "42");
assert.equal(prediction.metrics.toolCalls, 0);
assert.equal(prediction.execution?.inputTokens, 9);
assert.equal(prediction.execution?.cacheReadInputTokens, 5);
assert.equal(prediction.execution?.cacheCreationInputTokens, 2);
assert.equal(prediction.metrics.tokens, 17);
assert.equal(requestBody?.model, "model-a");
const dependencyExecutor = createDirectModelBenchmarkExecutor({
  model: "model-a",
  readSettings: async () => settings,
  fetchImpl: async () => new Response("upstream unavailable", { status: 503 }),
});
const dependencyPrediction = BenchmarkPredictionSchema.parse(await dependencyExecutor(executionCase, {
  taskContract: task.contract,
  missingExternalInputs: [],
}));
assert.deepEqual(dependencyPrediction.failure, {
  kind: "transient_external_failure",
  code: "provider_response_failed",
  source: "dependency",
  details: {},
});
assert.throws(() => createDirectModelBenchmarkExecutor({ model: " " }));
await assert.rejects(() => executor(partitionBenchmarkCase(agentCase).executionCase, {
  taskContract: createBenchmarkTaskContract(partitionBenchmarkCase(agentCase).executionCase).contract,
  missingExternalInputs: [],
}));

console.log("benchmark-evaluation-layers: disjoint Agent/model cases, repeated matrix and direct model boundary passed ✓");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
