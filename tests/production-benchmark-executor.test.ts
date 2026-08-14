import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSettings } from "../lib/settings/agent-settings.ts";
import type { FinworkAgentRequest, FinworkAgentResult } from "../lib/agent/contracts.ts";
import type { PiAgentServiceOptions } from "../lib/agent/pi/agent-service.ts";
import {
  BenchmarkPredictionSchema,
  NormalizedBenchmarkCaseSchema,
  type NormalizedBenchmarkCase,
} from "../lib/evaluation/benchmarks/contracts.ts";
import { partitionBenchmarkCase } from "../lib/evaluation/benchmarks/case-boundary.ts";
import { createBenchmarkTaskContract } from "../lib/evaluation/benchmarks/task-contract.ts";
import {
  createProductionBenchmarkExecutor,
  formatBenchmarkAgentPrompt,
} from "../lib/evaluation/benchmarks/production-executor.ts";
import { closeProductionBenchmarkRuntime } from "../lib/evaluation/benchmarks/runtime-cleanup.ts";
import { getDb } from "../lib/db/sqlite.ts";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import type { ArtifactRef } from "../lib/artifacts/contracts.ts";

const SOURCE_SHA = "a".repeat(64);

function benchmarkCase(id: string, expectedAnswer = "42"): NormalizedBenchmarkCase {
  return NormalizedBenchmarkCaseSchema.parse({
    schemaVersion: 1,
    id: `finqa:v1:${id}`,
    datasetId: "finqa",
    datasetVersion: "v1",
    upstreamCaseId: id,
    split: "test",
    locale: "en-US",
    taskKind: "qa",
    prompt: "What is six times seven?",
    context: { textBlocks: [], tables: [], conversation: [], files: [] },
    expected: {
      answers: [expectedAnswer],
      numericAnswers: [42],
      programs: [],
      citations: [],
      assertions: [],
    },
    capabilities: ["financial_qa"],
    tags: ["test"],
    provenance: {
      sourceSha256: SOURCE_SHA,
      sourceRecordIndex: 0,
      homepage: "https://example.invalid/finqa",
      upstreamRef: "fixture",
      licenseStatus: "verified",
    },
  });
}

const settings: AgentSettings = {
  apiUrl: "https://fake-provider.invalid",
  apiKey: "test-only-key",
  companyName: "",
  agentName: "Test Agent",
  userName: "",
  userAvatar: "",
  fastModel: "fake-fast",
  reasoningModel: "fake-reasoning",
  roleMode: "tech",
  telemetryEnabled: false,
  telemetryEndpoint: "",
  telemetryToken: "",
  telemetryInstallId: "benchmark-test",
};

const route = async () => ({
  path: "main" as const,
  decision: {
    intent: "complex_workflow" as const,
    needsRag: false,
    reasoning: "fake provider integration route",
  },
  latencyMs: 1,
});

function successfulProvider(
  content: string,
  inspect?: (request: FinworkAgentRequest, options: PiAgentServiceOptions) => void,
) {
  return async (request: FinworkAgentRequest, options: PiAgentServiceOptions): Promise<FinworkAgentResult> => {
    inspect?.(request, options);
    request.emit?.({ type: "message_delta", channel: "text", delta: content });
    return {
      mode: "agent",
      content,
      runtimeSessionId: null,
      modelUsage: {
        "fake-reasoning": {
          inputTokens: 11,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      totalCostUsd: 0.001,
    };
  };
}

function providerError(status: number) {
  const error = Object.assign(new Error(`provider HTTP ${status}`), { status });
  (error as Error & { __collector?: unknown }).__collector = {
    collectedChunks: [],
    collectedEvents: [],
  };
  return error;
}

async function executeCase(
  value: NormalizedBenchmarkCase,
  agentRunner: NonNullable<Parameters<typeof createProductionBenchmarkExecutor>[0]>["agentRunner"],
  signal?: AbortSignal,
  materializedInputs?: readonly ArtifactRef[],
) {
  const { executionCase } = partitionBenchmarkCase(value, materializedInputs);
  const materialized = createBenchmarkTaskContract(executionCase, {
    tokenLimit: 321,
    wallTimeMs: 12_345,
    memoryBytes: 64 * 1024 * 1024,
  });
  const executor = createProductionBenchmarkExecutor({
    route,
    readSettings: async () => settings,
    agentRunner,
    sleep: async () => undefined,
  });
  const prediction = await executor(executionCase, {
    signal,
    taskContract: materialized.contract,
    missingExternalInputs: [],
  });
  return { prediction: BenchmarkPredictionSchema.parse(prediction), executionCase, contract: materialized.contract };
}

export const productionBenchmarkExecutorTestPromise = (async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-production-benchmark-"));
  const previousAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const previousDbPath = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_APP_DATA_DIR = dataRoot;
  process.env.FINANCE_AGENT_DB_PATH = path.join(dataRoot, "benchmark.db");
  try {
    const sentinelCase = benchmarkCase("oracle-boundary", "PRIVATE_ORACLE_SENTINEL");
    const { executionCase: publicCase } = partitionBenchmarkCase(sentinelCase);
    assert.doesNotMatch(formatBenchmarkAgentPrompt(publicCase), /PRIVATE_ORACLE_SENTINEL/);

    let observedBudget: FinworkAgentRequest["foundation"];
    const success = await executeCase(
      benchmarkCase("success"),
      successfulProvider("42", (request, options) => {
        observedBudget = request.foundation;
        assert.equal(options.hardTimeoutMs, 12_345);
      }),
    );
    assert.equal(success.prediction.answer, "42");
    assert.equal(success.prediction.failure, undefined);
    assert.equal(success.prediction.metrics.tokens, 13);
    assert.equal(success.prediction.execution?.validation.delivery.passed, true);
    assert.deepEqual(observedBudget?.budget, success.contract.budget, "V3 budget must reach the production Agent unchanged");
    const persisted = getDb().prepare(`
      SELECT content FROM chat_messages
      WHERE conversation_id = ? AND role = 'assistant'
    `).get(success.prediction.execution?.conversationId) as { content: string };
    assert.equal(persisted.content, success.prediction.answer, "prediction answer must come from the persisted assistant result");

    let fixedRouteCalls = 0;
    let fixedMainModel: string | undefined;
    let fixedSubagentModel: string | undefined;
    const fixedCase = benchmarkCase("fixed-agent");
    const fixedPartition = partitionBenchmarkCase(fixedCase);
    const fixedTask = createBenchmarkTaskContract(fixedPartition.executionCase, {
      tokenLimit: 321,
      wallTimeMs: 12_345,
    });
    const fixedExecutor = createProductionBenchmarkExecutor({
      evaluationMode: "fixed-agent",
      fixedModel: "one-model-only",
      route: async () => {
        fixedRouteCalls += 1;
        return route();
      },
      readSettings: async () => settings,
      agentRunner: successfulProvider("42", (request, options) => {
        fixedMainModel = request.modelOverride;
        fixedSubagentModel = options.nestedModelOverride;
      }),
      sleep: async () => undefined,
    });
    const fixedPrediction = await fixedExecutor(fixedPartition.executionCase, {
      taskContract: fixedTask.contract,
      missingExternalInputs: [],
    });
    assert.equal(fixedRouteCalls, 0, "fixed Agent evaluation must skip the paid/adaptive Router");
    assert.equal(fixedMainModel, "one-model-only");
    assert.equal(fixedSubagentModel, "one-model-only", "nested Agent workers must inherit the fixed model");
    assert.equal(fixedPrediction.answer, "42");

    const accountedExecutor = createProductionBenchmarkExecutor({
      route: async () => ({
        ...(await route()),
        usage: {
          modelId: "fake-fast",
          inputTokens: 5,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
      readSettings: async () => settings,
      agentRunner: successfulProvider("42"),
      sleep: async () => undefined,
    });
    const accounted = await accountedExecutor(fixedPartition.executionCase, {
      taskContract: fixedTask.contract,
      missingExternalInputs: [],
    });
    assert.equal(accounted.metrics.tokens, 19, "paid Router and Agent usage must share the benchmark ledger");

    const retrievalContractCase = NormalizedBenchmarkCaseSchema.parse({
      ...benchmarkCase("retrieval-contract"),
      taskKind: "rag",
      context: {
        textBlocks: [{ id: "source-1", text: "The governed answer is 42." }],
        tables: [], conversation: [], files: [],
      },
      expected: {
        answers: ["42"], numericAnswers: [42], programs: [], assertions: [],
        citations: [{ sourceId: "source-1" }],
      },
      capabilities: ["retrieval", "citation"],
    });
    const retrievalPartition = partitionBenchmarkCase(retrievalContractCase);
    const retrievalTask = createBenchmarkTaskContract(retrievalPartition.executionCase);
    let retrievalAgentCalls = 0;
    const governedExecutor = createProductionBenchmarkExecutor({
      route: async () => ({
        path: "cheap",
        latencyMs: 1,
        decision: {
          intent: "trivial_qa",
          directAnswer: "42",
          needsRag: false,
          reasoning: "misclassified by adaptive router",
        },
      }),
      readSettings: async () => settings,
      agentRunner: async (request, options) => {
        retrievalAgentCalls += 1;
        return successfulProvider("42")(request, options);
      },
      sleep: async () => undefined,
    });
    await governedExecutor(retrievalPartition.executionCase, {
      taskContract: retrievalTask.contract,
      missingExternalInputs: [],
    });
    assert.equal(retrievalAgentCalls, 1, "retrieval/citation contracts must not be bypassed by a cheap direct route");

    await assert.rejects(
      () => createProductionBenchmarkExecutor({ evaluationMode: "fixed-agent" })(fixedPartition.executionCase, {
        taskContract: fixedTask.contract,
        missingExternalInputs: [],
      }),
      /requires fixedModel/,
    );

    const repeated = await executeCase(
      benchmarkCase("success"),
      successfulProvider("42"),
    );
    assert.notEqual(
      repeated.prediction.execution?.caseId,
      success.prediction.execution?.caseId,
      "re-running a normalized benchmark case must create a fresh production case",
    );
    assert.notEqual(
      repeated.prediction.execution?.taskId,
      success.prediction.execution?.taskId,
      "re-running a normalized benchmark case must create a fresh production task",
    );

    let transientCalls = 0;
    const transient = await executeCase(benchmarkCase("bounded-retry"), async (request, options) => {
      transientCalls += 1;
      if (transientCalls === 1) throw providerError(503);
      return successfulProvider("42")(request, options);
    });
    assert.equal(transientCalls, 2, "5xx must receive at most one side-effect-free retry");
    assert.equal(transient.prediction.metrics.retries, 1);
    assert.equal(transient.prediction.failure, undefined);

    let authCalls = 0;
    const auth = await executeCase(benchmarkCase("auth-failure"), async () => {
      authCalls += 1;
      throw providerError(401);
    });
    assert.equal(authCalls, 1, "authentication failures must not retry");
    assert.equal(auth.prediction.failure?.code, "provider_auth_failed");
    assert.equal(auth.prediction.failure?.source, "dependency");

    let invalidModelCalls = 0;
    const invalidModel = await executeCase(benchmarkCase("invalid-model"), async () => {
      invalidModelCalls += 1;
      throw providerError(404);
    });
    assert.equal(invalidModelCalls, 1, "model/endpoint 404 failures must not retry");
    assert.equal(invalidModel.prediction.failure?.code, "provider_model_or_endpoint_invalid");
    assert.equal(invalidModel.prediction.failure?.source, "dependency");

    let rateLimitCalls = 0;
    const rateLimited = await executeCase(benchmarkCase("rate-limited"), async () => {
      rateLimitCalls += 1;
      throw providerError(429);
    });
    assert.equal(rateLimitCalls, 2, "429 failures receive exactly one bounded side-effect-free retry");
    assert.equal(rateLimited.prediction.failure?.code, "provider_rate_limited");
    assert.equal(rateLimited.prediction.failure?.source, "dependency");

    let terminatedCalls = 0;
    const providerTerminated = await executeCase(benchmarkCase("provider-terminated"), async () => {
      terminatedCalls += 1;
      const error = Object.assign(new Error("terminated"), { code: "PROVIDER_RESPONSE_ERROR" });
      (error as Error & { __collector?: unknown }).__collector = {
        collectedChunks: [],
        collectedEvents: [],
      };
      throw error;
    });
    assert.equal(terminatedCalls, 2, "provider terminal responses receive one side-effect-free retry");
    assert.equal(providerTerminated.prediction.failure?.code, "transient_transport_provider_response_error");
    assert.equal(providerTerminated.prediction.failure?.source, "dependency");

    let timeoutCalls = 0;
    const timedOut = await executeCase(benchmarkCase("timeout"), async () => {
      timeoutCalls += 1;
      const error = new Error("fake provider timed out");
      error.name = "TimeoutError";
      (error as Error & { __collector?: unknown }).__collector = {
        collectedChunks: [],
        collectedEvents: [],
      };
      throw error;
    });
    assert.equal(timeoutCalls, 2, "provider timeout receives at most one side-effect-free retry");
    assert.equal(timedOut.prediction.failure?.code, "benchmark_wall_time_exceeded");
    assert.equal(timedOut.prediction.failure?.source, "resource");
    assert.equal(timedOut.prediction.execution?.termination.timedOut, true);

    const evidenceBase = benchmarkCase("missing-evidence");
    const evidenceCase = NormalizedBenchmarkCaseSchema.parse({
      ...evidenceBase,
      context: {
        ...evidenceBase.context,
        textBlocks: [{ id: "annual-report:p1", text: "Six times seven is 42." }],
      },
    });
    const artifacts = new ArtifactStore(getDb(), path.join(dataRoot, "artifacts", "cas"));
    const evidenceArtifact = artifacts.put({
      kind: "benchmark_source_context",
      logicalName: "annual-report-p1.md",
      classification: "public",
      retention: { policyId: "benchmark-ephemeral" },
      mediaType: "text/markdown",
      producer: { component: "benchmark-test", version: "1" },
      metadata: { sourceId: "annual-report:p1" },
      content: new TextEncoder().encode("Six times seven is 42."),
      state: "candidate",
    });
    let observedQaAttachments = -1;
    const seededEvidence = await executeCase(
      evidenceCase,
      successfulProvider("42", (request) => {
        observedQaAttachments = request.attachments?.length ?? 0;
      }),
      undefined,
      [evidenceArtifact],
    );
    assert.equal(seededEvidence.prediction.failure, undefined);
    assert.equal(observedQaAttachments, 0, "generated QA context artifacts must not become spreadsheet/file attachments");
    assert.ok((seededEvidence.prediction.execution?.evidenceRefs.length ?? 0) >= 1, "materialized inputs must seed source evidence");

    const inlineCitationCase = NormalizedBenchmarkCaseSchema.parse({
      ...evidenceCase,
      id: "finqa:v1:inline-citation",
      upstreamCaseId: "inline-citation",
      expected: {
        ...evidenceCase.expected,
        citations: [{ sourceId: "annual-report:p1", locator: "node:annual-report:p1" }],
      },
    });
    const inlineCitation = await executeCase(
      inlineCitationCase,
      successfulProvider('42\n\n[[cite sourceId="annual-report:p1" locator="node:annual-report:p1"]]'),
      undefined,
      [evidenceArtifact],
    );
    assert.equal(inlineCitation.prediction.failure, undefined);
    assert.deepEqual(inlineCitation.prediction.citations, [{
      sourceId: "annual-report:p1",
      locator: "node:annual-report:p1",
    }]);

    const retrievalLocator = { kind: "node" as const, nodeId: evidenceArtifact.versionId };
    const retrievalCase = NormalizedBenchmarkCaseSchema.parse({
      ...evidenceCase,
      id: "financebench:v1:governed-retrieval",
      datasetId: "financebench",
      upstreamCaseId: "governed-retrieval",
      taskKind: "rag",
      expected: {
        ...evidenceCase.expected,
        citations: [{ sourceId: "annual-report:p1", locator: `node:${evidenceArtifact.versionId}` }],
      },
      capabilities: ["financial_qa", "retrieval", "citation"],
    });
    let observedRetrievalIntent = "";
    const retrieval = await executeCase(
      retrievalCase,
      async (request, options) => {
        observedRetrievalIntent = request.intent ?? "";
        request.emit?.({ type: "tool_started", toolName: "search_knowledge", toolCallId: "search-1" });
        request.emit?.({
          type: "tool_completed",
          toolName: "search_knowledge",
          toolCallId: "search-1",
          isError: false,
          content: [
            "【引用 1｜annual-report:p1】",
            "Six times seven is 42.",
            `来源版本：${evidenceArtifact.versionId}`,
            `定位：${JSON.stringify(retrievalLocator)}`,
            `内容哈希：${evidenceArtifact.sha256}`,
          ].join("\n"),
        });
        return successfulProvider("42")(request, options);
      },
      undefined,
      [evidenceArtifact],
    );
    assert.equal(observedRetrievalIntent, "rag_qa", "retrieval contracts must expose governed knowledge tools");
    assert.equal(retrieval.prediction.failure, undefined);
    assert.deepEqual(retrieval.prediction.citations, [{
      sourceId: "annual-report:p1",
      locator: `node:${evidenceArtifact.versionId}`,
    }]);

    const artifactBase = benchmarkCase("missing-artifact");
    const artifactCase = NormalizedBenchmarkCaseSchema.parse({
      ...artifactBase,
      taskKind: "spreadsheet",
      expected: {
        ...artifactBase.expected,
        artifact: {
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          logicalName: "result.xlsx",
          validatorIds: ["validator.workbook"],
        },
      },
      capabilities: ["spreadsheet_editing"],
    });
    const { executionCase: publicArtifactCase } = partitionBenchmarkCase(artifactCase);
    assert.match(
      formatBenchmarkAgentPrompt(publicArtifactCase),
      /输出文件名必须精确为："result\.xlsx"/,
      "artifact contracts must tell the headless Agent the exact required logical name",
    );
    assert.match(
      formatBenchmarkAgentPrompt(publicArtifactCase),
      /Reported.*预测期.*留空/,
      "Spreadsheet Agent contracts must preserve historical-only Reported rows",
    );
    const missingArtifact = await executeCase(artifactCase, async (request, options) => {
      request.emit?.({ type: "tool_started", toolName: "patch_workbook", toolCallId: "patch-artifact" });
      request.emit?.({ type: "tool_completed", toolCallId: "patch-artifact", isError: false });
      request.emit?.({ type: "tool_started", toolName: "finalize_deliverable", toolCallId: "finalize-artifact" });
      request.emit?.({ type: "tool_completed", toolCallId: "finalize-artifact", isError: false });
      return successfulProvider("done")(request, options);
    });
    assert.equal(missingArtifact.prediction.artifact, undefined);
    assert.equal(missingArtifact.prediction.failure?.code, "foundation_delivery_artifact_missing");
    assert.equal(missingArtifact.prediction.execution?.validation.delivery.passed, false);
    assert.equal(missingArtifact.prediction.metrics.tokens, 13, "post-turn contract failures must retain paid usage");
    const failedTurnMessages = getDb().prepare(`
      SELECT COUNT(*) AS count FROM chat_messages
      WHERE conversation_id = ? AND role = 'assistant'
    `).get(missingArtifact.prediction.execution?.conversationId) as { count: number };
    assert.equal(failedTurnMessages.count, 1, "post-turn contract failures must not duplicate assistant messages");

    const abortController = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let backgroundRequests = 0;
    const cancellationPromise = executeCase(benchmarkCase("cancellation"), async (request) => {
      backgroundRequests += 1;
      startedResolve();
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          const error = new Error("fake provider aborted");
          error.name = "AbortError";
          (error as Error & { __collector?: unknown }).__collector = {
            collectedChunks: [],
            collectedEvents: [],
          };
          reject(error);
        }, { once: true });
      });
    }, abortController.signal);
    await started;
    abortController.abort();
    const cancellation = await cancellationPromise;
    assert.equal(cancellation.prediction.failure?.code, "benchmark_aborted");
    assert.equal(cancellation.prediction.execution?.termination.cancelled, true);
    assert.equal(backgroundRequests, 1, "abort must not start another provider attempt");

    const cleanupCalls: string[] = [];
    await closeProductionBenchmarkRuntime({
      closeRetrieval: async () => { cleanupCalls.push("retrieval"); },
      closeDocuments: async () => { cleanupCalls.push("documents"); },
    });
    assert.deepEqual(cleanupCalls.sort(), ["documents", "retrieval"]);
    const failingCleanupCalls: string[] = [];
    await assert.rejects(() => closeProductionBenchmarkRuntime({
      closeRetrieval: async () => {
        failingCleanupCalls.push("retrieval");
        throw new Error("retrieval cleanup failed");
      },
      closeDocuments: async () => { failingCleanupCalls.push("documents"); },
    }), AggregateError);
    assert.deepEqual(
      failingCleanupCalls.sort(),
      ["documents", "retrieval"],
      "one cleanup failure must not skip the other process-owned pool",
    );

    console.log("production-benchmark-executor: production runtime, retry, auth and cancellation gates passed ✓");
  } finally {
    if (previousAppData === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = previousAppData;
    if (previousDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = previousDbPath;
    rmSync(dataRoot, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("production-benchmark-executor.test")) {
  productionBenchmarkExecutorTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
