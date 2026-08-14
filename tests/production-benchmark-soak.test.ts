import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FinworkAgentRequest, FinworkAgentResult } from "../lib/agent/contracts.ts";
import type { AgentSettings } from "../lib/settings/agent-settings.ts";
import {
  NormalizedBenchmarkCaseSchema,
  RealBenchmarkRunConfigSchema,
  type NormalizedBenchmarkCase,
} from "../lib/evaluation/benchmarks/contracts.ts";
import { createProductionBenchmarkExecutor } from "../lib/evaluation/benchmarks/production-executor.ts";
import { runRealBenchmarkSuite } from "../lib/evaluation/benchmarks/real-runner.ts";
import { getDb } from "../lib/db/sqlite.ts";

const CASES = 100;
const SOURCE_SHA = "d".repeat(64);
const MANIFEST_SHA = "e".repeat(64);

const settings: AgentSettings = {
  apiUrl: "https://fake-provider.invalid",
  apiKey: "test-only-key",
  companyName: "",
  agentName: "Soak Agent",
  userName: "",
  userAvatar: "",
  fastModel: "fake-fast",
  reasoningModel: "fake-reasoning",
  roleMode: "tech",
  telemetryEnabled: false,
  telemetryEndpoint: "",
  telemetryToken: "",
  telemetryInstallId: "benchmark-soak-test",
};

function makeCase(index: number): NormalizedBenchmarkCase {
  return NormalizedBenchmarkCaseSchema.parse({
    schemaVersion: 1,
    id: `finqa:soak:case-${index}`,
    datasetId: "finqa",
    datasetVersion: "soak-v1",
    upstreamCaseId: `case-${index}`,
    split: "test",
    locale: "en-US",
    taskKind: "qa",
    prompt: `What is six times seven? Case ${index}`,
    context: { textBlocks: [], tables: [], conversation: [], files: [] },
    expected: { answers: ["42"], numericAnswers: [42], programs: [], citations: [], assertions: [] },
    capabilities: ["financial_qa"],
    tags: ["production-soak"],
    provenance: {
      sourceSha256: SOURCE_SHA,
      sourceRecordIndex: index,
      homepage: "https://example.invalid/finqa",
      upstreamRef: `soak-${index}`,
      licenseStatus: "verified",
    },
  });
}

const route = async () => ({
  path: "main" as const,
  decision: {
    intent: "complex_workflow" as const,
    needsRag: false,
    reasoning: "production benchmark soak",
  },
  latencyMs: 0,
});

const provider = async (request: FinworkAgentRequest): Promise<FinworkAgentResult> => {
  request.emit?.({ type: "message_delta", channel: "text", delta: "42" });
  return {
    mode: "agent",
    content: "42",
    runtimeSessionId: null,
    modelUsage: {
      "fake-reasoning": {
        inputTokens: 2,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    totalCostUsd: 0,
  };
};

export const productionBenchmarkSoakTestPromise = (async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-production-benchmark-soak-"));
  const previousAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const previousDbPath = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_APP_DATA_DIR = dataRoot;
  process.env.FINANCE_AGENT_DB_PATH = path.join(dataRoot, "benchmark-soak.db");
  try {
    const cases = Array.from({ length: CASES }, (_, index) => makeCase(index));
    const configuration = RealBenchmarkRunConfigSchema.parse({
      kind: "real",
      profile: "full",
      datasets: [{
        datasetId: "finqa",
        split: "test",
        manifestSha256: MANIFEST_SHA,
        sourceSha256: SOURCE_SHA,
        licenseStatus: "verified",
      }],
      sampleSeed: "production-soak-v1",
      maxCases: CASES,
      maxInputTokens: 10_000,
      maxOutputTokens: 5_000,
      maxWallTimeMs: 120_000,
      pricingKnown: true,
      maxCostUsd: 1,
      consent: { environmentGate: true, cliConfirmed: true, explicitBudgets: true },
      providerHost: "fake-provider.invalid",
      models: { fast: "fake-fast", reasoning: "fake-reasoning" },
      modelTierSeparated: true,
      commitSha: "production-soak-test",
      runnerVersion: "production-soak-v1",
      nodeVersion: process.version,
      pnpmVersion: "test",
      appVersion: "test",
    });
    const executor = createProductionBenchmarkExecutor({
      route,
      readSettings: async () => settings,
      agentRunner: provider,
      sleep: async () => undefined,
    });
    const memorySamples: Array<{ rss: number; heapUsed: number }> = [];
    globalThis.gc?.();
    const baseline = process.memoryUsage();
    const report = await runRealBenchmarkSuite({
      suiteName: "production benchmark 100-case soak",
      runId: "production-benchmark-soak",
      selectedCases: cases,
      inputArtifactsByCaseId: {},
      executor,
      configuration,
      onCaseResult: ({ ordinal }) => {
        if ((ordinal + 1) % 10 === 0) {
          globalThis.gc?.();
          const memory = process.memoryUsage();
          memorySamples.push({ rss: memory.rss, heapUsed: memory.heapUsed });
        }
      },
    });
    globalThis.gc?.();
    const finalMemory = process.memoryUsage();
    const db = getDb();
    const activeWorkspaces = (db.prepare("SELECT COUNT(*) AS count FROM resource_temp_workspaces WHERE state='active'").get() as { count: number }).count;
    const activeWorkers = (db.prepare("SELECT COUNT(*) AS count FROM worker_jobs WHERE status IN ('queued','running')").get() as { count: number }).count;
    const activeReservations = (db.prepare("SELECT COUNT(*) AS count FROM resource_reservations WHERE status='active'").get() as { count: number }).count;
    const dbBytes = fs.statSync(process.env.FINANCE_AGENT_DB_PATH!).size;

    assert.equal(report.runStatus, "completed");
    assert.equal(report.totals.cases, CASES);
    assert.equal(report.totals.passed, CASES);
    assert.equal(memorySamples.length, 10);
    assert(finalMemory.rss - baseline.rss < 96 * 1024 * 1024, "100 sequential cases must have bounded RSS growth");
    assert(finalMemory.heapUsed - baseline.heapUsed < 48 * 1024 * 1024, "100 sequential cases must have bounded heap growth");
    assert(dbBytes / CASES < 512 * 1024, "persistent evidence growth must remain bounded per case");
    assert.equal(activeWorkspaces, 0, "no temporary workspace may remain active");
    assert.equal(activeWorkers, 0, "no worker may remain queued or running");
    assert.equal(activeReservations, 0, "no resource reservation may remain active");

    console.log(`production-benchmark-soak: ${CASES} cases, bounded memory/DB, zero active workers/workspaces/reservations ✓`);
  } finally {
    if (previousAppData === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = previousAppData;
    if (previousDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = previousDbPath;
    rmSync(dataRoot, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("production-benchmark-soak.test")) {
  productionBenchmarkSoakTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
