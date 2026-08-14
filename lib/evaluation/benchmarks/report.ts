import { createHash } from "node:crypto";
import type { JsonValue } from "@/lib/capability/common";
import {
  BenchmarkRunReportSchema,
  BenchmarkRunReportV1Schema,
  BenchmarkRunReportV2Schema,
  type BenchmarkExecutionSummary,
  type BenchmarkRunReport,
  type BenchmarkRunReportV1,
  type BenchmarkRunReportV2,
  type NormalizedBenchmarkCase,
} from "./contracts";

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|auth[-_]?header|secret|password|token$)/i;
const USER_PATH = /(?:\/Users\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/g;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeBenchmarkReportValue(
  value: unknown,
  secretValues: readonly string[] = [],
): JsonValue {
  const secrets = secretValues.filter((secret) => secret.length > 0);
  const sanitizeString = (input: string) => {
    let output = input.replace(USER_PATH, "<redacted-user-path>");
    for (const secret of secrets) output = output.split(secret).join("<redacted-secret>");
    return output;
  };
  const visit = (input: unknown): JsonValue => {
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") return sanitizeString(input);
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "<redacted-secret>" : visit(item),
      ]));
    }
    return sanitizeString(String(input));
  };
  return visit(value);
}

export function createEmptyExecutionSummary(input: {
  runId: string;
  benchmarkCase: NormalizedBenchmarkCase;
  failureCode?: string | null;
  aborted?: boolean;
  timedOut?: boolean;
}): BenchmarkExecutionSummary {
  const traceId = `trace-${sha256Text(`${input.runId}:${input.benchmarkCase.id}`).slice(0, 20)}`;
  return {
    traceId,
    caseId: `case-${traceId}`,
    taskId: `task-${traceId}`,
    runId: input.runId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    latencyMs: 0,
    retries: 0,
    costUsd: null,
    artifactRefs: [],
    evidenceRefs: [],
    validation: {
      assertions: { total: 0, passed: 0, failed: input.failureCode ? 1 : 0 },
      delivery: { required: Boolean(input.benchmarkCase.expected.artifact), delivered: 0, passed: !input.benchmarkCase.expected.artifact },
    },
    termination: {
      cancelled: Boolean(input.aborted),
      aborted: Boolean(input.aborted),
      timedOut: Boolean(input.timedOut),
    },
    stableFailureCode: input.failureCode ?? null,
  };
}

export function migrateBenchmarkRunReportV1(report: BenchmarkRunReportV1): BenchmarkRunReportV2 {
  return BenchmarkRunReportV2Schema.parse({
    ...report,
    schemaVersion: 2,
    realApi: false,
    configuration: { kind: "legacy-v1" },
    sources: report.sources.map((source) => ({
      ...source,
      manifestSha256: sha256Text(JSON.stringify(source)),
    })),
    results: report.results.map((result) => ({
      ...result,
      execution: {
        traceId: `trace-${sha256Text(`${report.runId}:${result.caseId}`).slice(0, 20)}`,
        caseId: result.caseId,
        taskId: `legacy-task-${sha256Text(result.caseId).slice(0, 16)}`,
        runId: report.runId,
        inputTokens: result.metrics.tokens,
        outputTokens: 0,
        latencyMs: result.metrics.wallTimeMs,
        retries: result.metrics.retries,
        costUsd: null,
        artifactRefs: [],
        evidenceRefs: [],
        validation: {
          assertions: { total: 0, passed: 0, failed: result.status === "passed" ? 0 : 1 },
          delivery: { required: result.scores.artifact !== null, delivered: 0, passed: result.scores.artifact === 1 },
        },
        termination: { cancelled: false, aborted: false, timedOut: false },
        stableFailureCode: result.failures[0] ?? null,
      },
    })),
  });
}

export function parseBenchmarkRunReport(input: unknown): BenchmarkRunReportV2 {
  const parsed = BenchmarkRunReportSchema.parse(input);
  return parsed.schemaVersion === 1 ? migrateBenchmarkRunReportV1(parsed) : parsed;
}

export function serializeBenchmarkRunReport(
  report: BenchmarkRunReport,
  secretValues: readonly string[] = [],
): string {
  const safe = sanitizeBenchmarkReportValue(report, secretValues);
  return `${JSON.stringify(parseBenchmarkRunReport(safe), null, 2)}\n`;
}

export function formatBenchmarkRunLog(report: BenchmarkRunReportV2): string {
  const real = report.configuration.kind === "real" ? report.configuration : null;
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    runId: report.runId,
    suiteName: report.suiteName,
    realApi: report.realApi,
    providerHost: real?.providerHost ?? null,
    profile: real?.profile ?? report.configuration.kind,
    totals: report.totals,
  });
}

export function deterministicallySampleBenchmarkCases(
  cases: readonly NormalizedBenchmarkCase[],
  manifestSha256: string,
  seed: string,
  maxCases: number,
): NormalizedBenchmarkCase[] {
  if (!Number.isInteger(maxCases) || maxCases <= 0) throw new Error("maxCases must be a positive integer");
  return [...cases]
    .sort((left, right) => {
      const leftKey = sha256Text(`${manifestSha256}:${seed}:${left.id}`);
      const rightKey = sha256Text(`${manifestSha256}:${seed}:${right.id}`);
      return leftKey.localeCompare(rightKey) || left.id.localeCompare(right.id);
    })
    .slice(0, maxCases);
}

export function sanitizeBenchmarkDetails(value: unknown): JsonValue {
  return sanitizeBenchmarkReportValue(value);
}
