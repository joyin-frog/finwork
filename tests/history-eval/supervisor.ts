/**
 * Per-case out-of-process supervisor for real history evaluations.
 *
 * Each case gets its own detached child and wall-clock deadline. This is
 * intentionally one level above run.ts: createAgentSession/model setup can
 * hang before runPiAgent has installed its AbortController listener, so a
 * batch-level watchdog is not sufficient.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const baseRunId = process.env.HISTORY_RUN_ID ?? `supervised-${Date.now()}`;
const baseReportRoot = path.resolve("tests/history-eval/real-reports", baseRunId);
const caseTimeoutMs = Number(
  process.env.HISTORY_CASE_TIMEOUT_MS ?? process.env.HISTORY_TIMEOUT_MS ?? 1_800_000,
);
const supervisorCaseTimeoutMs = Number(
  process.env.HISTORY_SUPERVISOR_CASE_TIMEOUT_MS ?? caseTimeoutMs + 60_000,
);
const supervisorConcurrency = Math.max(
  1,
  Math.min(4, Number(process.env.HISTORY_SUPERVISOR_CONCURRENCY ?? 2)),
);
const caseIds = (process.env.HISTORY_CASE_ID ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const selectedCases = caseIds.length ? caseIds : [
  "HISTORY-001", "HISTORY-002", "HISTORY-003", "HISTORY-004",
  "HISTORY-005", "HISTORY-006", "HISTORY-007",
];

mkdirSync(baseReportRoot, { recursive: true });

type CaseResult = {
  id: string;
  runId: string;
  reportRoot: string;
  outcome: string;
  terminationReason: string;
  childExitCode?: number | null;
};

function killGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function markOpenCaseResult(reportRoot: string, id: string, runId: string): void {
  if (!existsSync(reportRoot)) return;
  for (const runName of readdirSync(reportRoot, { withFileTypes: true })) {
    if (!runName.isDirectory()) continue;
    const runDir = path.join(reportRoot, runName.name);
    const outputDir = path.join(runDir, "generate");
    const resultPath = path.join(runDir, "result.json");
    if (existsSync(outputDir) && !existsSync(resultPath)) {
      writeFileSync(resultPath, JSON.stringify({
        id,
        runId,
        outcome: "timeout",
        terminationReason: "supervisor_case_timeout",
        watchdogFired: true,
        outputDir,
        finishedAt: new Date().toISOString(),
      }, null, 2), "utf8");
    }
  }
}

function runCase(id: string): Promise<CaseResult> {
  const runId = `${baseRunId}-${id.toLowerCase()}`;
  const reportRoot = path.resolve("tests/history-eval/real-reports", runId);
  mkdirSync(reportRoot, { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, "tests/history-eval/run.ts")],
    {
      cwd: repoRoot,
      env: { ...process.env, HISTORY_CASE_ID: id, HISTORY_RUN_ID: runId },
      detached: true,
      stdio: "inherit",
    },
  );
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CaseResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      killGroup(child);
      markOpenCaseResult(reportRoot, id, runId);
      writeFileSync(path.join(reportRoot, "supervisor-result.json"), JSON.stringify({
        id, runId, outcome: "timeout", terminationReason: "supervisor_case_timeout",
        killedProcessGroup: true, timeoutMs: supervisorCaseTimeoutMs,
        finishedAt: new Date().toISOString(),
      }, null, 2), "utf8");
      finish({ id, runId, reportRoot, outcome: "timeout", terminationReason: "supervisor_case_timeout" });
    }, supervisorCaseTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ id, runId, reportRoot, outcome: "harness_error", terminationReason: "child_spawn_failed", childExitCode: null });
      console.error(`[${id}] child spawn failed`, error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({
        id,
        runId,
        reportRoot,
        outcome: code === 0 ? "completed" : signal ? "terminated" : "failed",
        terminationReason: signal ? `child_${signal.toLowerCase()}` : "child_exit",
        childExitCode: code,
      });
    });
  });
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(supervisorConcurrency, selectedCases.length) }, async () => {
    while (true) {
      const index = next++;
      const id = selectedCases[index];
      if (!id) return;
      results[index] = await runCase(id);
    }
  }));
  const failed = results.filter((result) => result.outcome !== "completed");
  writeFileSync(path.join(baseReportRoot, "supervisor-result.json"), JSON.stringify({
    outcome: failed.length ? "failed" : "completed",
    terminationReason: failed.length ? "case_failures" : "all_cases_completed",
    cases: results,
    concurrency: supervisorConcurrency,
    finishedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
