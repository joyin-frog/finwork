import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { getModelConfigReadiness } from "@/lib/settings/model-config";
import { buildMessagesUrl } from "@/lib/agent/router";
import { runPiAgent } from "@/lib/agent/pi/agent-service";
import type { AgentMessage } from "@/lib/agent/contracts";
import { SqliteDeliverableStore } from "@/lib/deliverable/store";
import { getDb } from "@/lib/db/sqlite";
import {
  HISTORICAL_FINANCE_CASES,
  HISTORICAL_FIXTURE_SHA256,
  type HistoricalFinanceCase,
} from "./cases";
import { sha256File } from "@/lib/deliverable/hash";
import {
  artifactSummaryForJudge,
  inspectDeliveredArtifacts,
  scoreArtifactAssertions,
  selectLatestCompletionEvidence,
  verifyDeliveryContract,
} from "./scoring";
import { checkMinimumDeliverables } from "./minimum-deliverable";
import { getFileWorkspaceStore } from "@/lib/file-workspace";
import { beginDeliveryRun } from "@/lib/task/production-runtime";

const SKIP_LLM = process.env.SKIP_LLM === "true";
const CASE_IDS = new Set(
  (process.env.HISTORY_CASE_ID || "").split(",").map((s) => s.trim()).filter(Boolean),
);
const CASES = CASE_IDS.size === 0
  ? HISTORICAL_FINANCE_CASES
  : HISTORICAL_FINANCE_CASES.filter((c) => CASE_IDS.has(c.id));
const FIXTURE_ROOT = path.resolve(
  process.env.HISTORY_FIXTURE_ROOT ?? "tests/history-eval/real-fixtures",
);
const USE_REAL_FIXTURES = process.env.HISTORY_REAL_FIXTURES !== "false";
const CASE_TIMEOUT_MS = Number(
  process.env.HISTORY_CASE_TIMEOUT_MS ?? process.env.HISTORY_TIMEOUT_MS ?? 1_800_000,
);
const AGENT_TIMEOUT_MS = Number(
  process.env.HISTORY_AGENT_TIMEOUT_MS ?? Math.max(60_000, CASE_TIMEOUT_MS - 120_000),
);
const VERIFICATION_TIMEOUT_MS = Number(
  process.env.HISTORY_VERIFICATION_TIMEOUT_MS ?? 60_000,
);
const JUDGE_TIMEOUT_MS = Number(
  process.env.HISTORY_JUDGE_TIMEOUT_MS ?? 45_000,
);
const MAX_REPAIR_ROUNDS = Math.max(
  0,
  Math.min(5, Number(process.env.HISTORY_MAX_REPAIR_ROUNDS ?? 2)),
);
const CONCURRENCY = Math.max(
  1,
  Math.min(7, Number(process.env.HISTORY_CONCURRENCY ?? 1)),
);
const QUALITY_THRESHOLD = Number(process.env.HISTORY_QUALITY_THRESHOLD ?? 0.85);
const TOOL_BUDGET_FACTOR = Number(process.env.HISTORY_TOOL_BUDGET_FACTOR ?? 1.5);
const MAX_TOOL_CALLS = Math.max(1, Number(process.env.HISTORY_MAX_TOOL_CALLS ?? 15));
const MAX_MODEL_CALLS = Math.max(1, Number(process.env.HISTORY_MAX_MODEL_CALLS ?? 8));
const TARGET_DURATION_MS = Math.max(1, Number(process.env.HISTORY_TARGET_DURATION_MS ?? 600_000));
const ENFORCE_PERFORMANCE_BUDGETS = process.env.HISTORY_ENFORCE_PERFORMANCE_BUDGETS === "true";
const BATCH_ID =
  process.env.HISTORY_RUN_ID ??
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const REPORT_ROOT = path.resolve("tests/history-eval/real-reports", BATCH_ID);

// 评测证据与生产数据完全隔离；显式配置仍优先。
process.env.FINANCE_AGENT_DB_PATH ??= path.join(REPORT_ROOT, "eval.db");
process.env.FINANCE_AGENT_PROFILE_PATH ??= path.join(REPORT_ROOT, "profile.json");

function mimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
    ".png": "image/png",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}


const managedFixtureAttachments = new Map<string, Awaited<ReturnType<typeof buildManagedFixtureAttachment>>>();

async function buildManagedFixtureAttachment(relative: string) {
  const storagePath = path.join(FIXTURE_ROOT, relative);
  const workspace = await getFileWorkspaceStore();
  const asset = workspace.ingestManagedBuffer({
    name: path.basename(relative),
    mediaType: mimeType(relative),
    content: readFileSync(storagePath),
    // Historical fixtures are copied into the isolated evaluation workspace.
    // `upload` is a UI provenance label, not a persisted workspace source kind;
    // managed assets are the production representation for uploaded files.
    sourceKind: "managed",
  });
  return {
    name: path.basename(relative),
    mimeType: mimeType(relative),
    size: statSync(storagePath).size,
    dataUrl: "",
    assetId: asset.assetId,
    versionId: asset.versionId,
  };
}

async function attachmentsFor(gc: HistoricalFinanceCase) {
  if (!USE_REAL_FIXTURES) return [];
  const expected = gc.fixtureFiles ?? [];
  const missing = expected.filter((relative) => !existsSync(path.join(FIXTURE_ROOT, relative)));
  if (missing.length) {
    throw new Error(
      `${gc.id} fixture_missing: ${missing.map((relative) => path.join(FIXTURE_ROOT, relative)).join(", ")}`,
    );
  }
  const changed = expected.flatMap((relative) => {
    const expectedHash = HISTORICAL_FIXTURE_SHA256[relative];
    if (!expectedHash) return [`${relative}: missing frozen hash`];
    const actualHash = sha256File(path.join(FIXTURE_ROOT, relative));
    return actualHash === expectedHash
      ? []
      : [`${relative}: expected ${expectedHash}, actual ${actualHash}`];
  });
  if (changed.length) {
    throw new Error(`${gc.id} fixture_integrity_failed: ${changed.join("; ")}`);
  }
  return Promise.all(expected.map(async (relative) => {
    const cached = managedFixtureAttachments.get(relative);
    if (cached) return cached;
    const attachment = await buildManagedFixtureAttachment(relative);
    managedFixtureAttachments.set(relative, attachment);
    return attachment;
  }));
}

type JudgeResult = { score: number; reason: string; blocking: boolean };

async function judgeCase(
  gc: HistoricalFinanceCase,
  task: string,
  artifactSummary: string,
  response: string,
  settings: Awaited<ReturnType<typeof readAgentSettings>>,
): Promise<JudgeResult | null> {
  if (SKIP_LLM || !settings.apiKey.trim()) return null;
  const prompt = [
    '你是财务工作流质量裁判。只输出 JSON：{"score":0到1之间的小数,"blocking":true或false,"reason":"简洁理由"}。',
    `任务：${task}`,
    `质量标准：${gc.judgeRubric}`,
    `已通过的系统交付证据和产物内容：\n${artifactSummary.slice(0, 24_000)}`,
    `Agent 最终说明（仅作辅助，不得覆盖产物事实）：${response.slice(0, 3_000)}`,
    "只评价难以用确定性规则覆盖的完整性、可追溯性、正式程度和风险说明。",
    "只有在产物明确出现重大业务矛盾、违反任务核心约束、用无依据数字代替待确认项，或虽有文件但不能完成核心用途时，blocking 才能为 true；确定性断言已覆盖且通过的事实不得仅因摘录未展示、无法完全排除风险、排版或措辞问题而标记 blocking。若只是可追溯性不足或建议补充证据，blocking 必须为 false。",
    "不得根据工具名称、调用次数、回复长度或措辞华丽程度评分。",
  ].join("\n\n");
  try {
    const res = await fetch(buildMessagesUrl(settings.apiUrl), {
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.fastModel || settings.reasoningModel,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const match = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      score?: unknown;
      blocking?: unknown;
      reason?: unknown;
    };
    if (typeof parsed.score !== "number" || typeof parsed.blocking !== "boolean") return null;
    return {
      score: Math.max(0, Math.min(1, parsed.score)),
      blocking: parsed.blocking,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

async function runCase(
  gc: HistoricalFinanceCase,
  settings: Awaited<ReturnType<typeof readAgentSettings>>,
) {
  const toolCalls: string[] = [];
  const started = Date.now();
  const runId = randomUUID();
  const caseRoot = path.join(REPORT_ROOT, gc.id, runId);
  const outputDir = path.join(caseRoot, "generate");
  mkdirSync(outputDir, { recursive: true });
  const attachments = await attachmentsFor(gc);
  const task = USE_REAL_FIXTURES && attachments.length ? (gc.realInput ?? gc.input) : gc.input;
  const controller = new AbortController();
  // The historical evaluator uses the same governed delivery boundary as the
  // product. Every tool receives one run context; no second planner is added.
  const productionRun = beginDeliveryRun({
    db: getDb(),
    traceId: runId,
    goal: task,
    attachments,
    deliverySpec: gc.deliverySpec,
    principalId: "history-eval-runner",
    tenantId: "history-eval",
    intent: gc.deliverySpec.taskKind === "financial_consolidation"
      ? "complex_workflow"
      : "tool_task",
    casRoot: path.join(caseRoot, "artifacts", "cas"),
  });
  let watchdogFired = false;
  let toolBudgetExceeded = false;
  let lastProgressAt = new Date().toISOString();
  const writeWatchdogResult = () => {
    watchdogFired = true;
    lastProgressAt = new Date().toISOString();
    // This is intentionally written before runPiAgent returns. If a provider/tool
    // promise ignores abort, the report still proves that the harness deadline fired.
    writeFileSync(
      path.join(caseRoot, "result.json"),
      JSON.stringify({
        id: gc.id,
        runId,
        outcome: "timeout",
        terminationReason: "watchdog_timeout",
        watchdogFired: true,
        timeoutMs: CASE_TIMEOUT_MS,
        lastProgressAt,
        outputDir,
      }, null, 2),
      "utf8",
    );
    controller.abort();
  };
  const timeout = setTimeout(writeWatchdogResult, CASE_TIMEOUT_MS);
  let response = "";
  let error: string | undefined;
  let numTurns: number | undefined;
  let terminationReason: string | undefined;
  let repairRounds: number | undefined;
  let repairStopReason: string | undefined;
  let verificationStatus: string | undefined;
  try {
    const result = await runPiAgent({
      messages: [{ role: "user", content: task }] as AgentMessage[],
      requestId: runId,
      attachments,
      outputDir,
      deliverySpec: gc.deliverySpec,
      runContext: productionRun.runContext,
      workPlan: productionRun.plan,
      intent: gc.deliverySpec.taskKind === "financial_consolidation"
        ? "complex_workflow"
        : "tool_task",
      signal: controller.signal,
      emit: (event) => {
        lastProgressAt = new Date().toISOString();
        productionRun.recordRuntimeEvent(event);
        if (event.type === "tool_started") {
          toolCalls.push(event.toolName);
          const budget = Math.min(
            MAX_TOOL_CALLS,
            Math.max(1, Math.ceil(gc.historicalToolCalls * TOOL_BUDGET_FACTOR)),
          );
          if (toolCalls.length > budget && !toolBudgetExceeded) {
            toolBudgetExceeded = true;
            if (ENFORCE_PERFORMANCE_BUDGETS) controller.abort();
          }
        }
      },
    }, {
      hardTimeoutMs: AGENT_TIMEOUT_MS,
      maxRepairRounds: MAX_REPAIR_ROUNDS,
      verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
      sessionRoot: path.join(caseRoot, "pi-sessions"),
      agentDir: path.join(caseRoot, "pi-agent"),
      minimumDeliverableCheck: () => checkMinimumDeliverables(gc.deliverySpec, outputDir),
      maxTransientContinuationAttempts: Math.max(
        0,
        Math.min(3, Number(process.env.HISTORY_TRANSIENT_CONTINUATION_ATTEMPTS ?? 2)),
      ),
      abortTimeoutMs: Number(process.env.HISTORY_ABORT_TIMEOUT_MS ?? 2_000),
      completionVerifier: async ({ runId: verifierRunId, deliverySpec }) => {
        const verifierStore = new SqliteDeliverableStore(getDb());
        const verifierEvidence = selectLatestCompletionEvidence(
          deliverySpec,
          verifierStore.list(verifierRunId),
        );
        const verifierArtifacts = await inspectDeliveredArtifacts(
          verifierEvidence,
          gc.artifactAssertions,
          USE_REAL_FIXTURES ? FIXTURE_ROOT : undefined,
        );
        const verifierDelivery = verifyDeliveryContract(deliverySpec, verifierArtifacts);
        const verifierScore = scoreArtifactAssertions(
          gc,
          verifierArtifacts,
          USE_REAL_FIXTURES,
        );
        const failedAssertions = verifierScore.assertionResults.filter(
          (assertion) => !assertion.passed,
        );
        const ok =
          verifierDelivery.passed &&
          verifierScore.criticalPassed &&
          verifierScore.deterministicScore >= 0.85;
        return {
          ok,
          message: ok
            ? undefined
            : [
                "任务级产物断言未通过：",
                ...verifierDelivery.failures.map((failure) => `- 交付: ${failure}`),
                ...failedAssertions.map(
                  (assertion) =>
                    `- ${assertion.description}: ${assertion.actual}；要求 ${assertion.expected}`,
                ),
              ].join("\n"),
          fingerprint: [
            ...verifierArtifacts.map((artifact) =>
              `${artifact.deliverableId}:${artifact.sha256}`
            ),
            ...failedAssertions.map((assertion) => assertion.id),
          ].sort().join("|"),
        };
      },
    });
    response = result.content;
    numTurns = result.numTurns;
    terminationReason = result.terminationReason;
    repairRounds = result.repairRounds;
    repairStopReason = result.repairStopReason;
    verificationStatus = result.verificationStatus;
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    const meta = caught as Error & {
      __repairRounds?: number;
      __repairStopReason?: string;
      __verificationStatus?: string;
      __terminationReason?: string;
    };
    repairRounds = meta.__repairRounds;
    repairStopReason = meta.__repairStopReason;
    verificationStatus = meta.__verificationStatus;
    terminationReason =
      meta.__terminationReason ??
      (caught instanceof Error ? terminationReasonForError(caught) : undefined);
  } finally {
    clearTimeout(timeout);
  }

  const store = new SqliteDeliverableStore(getDb());
  const completionEvidence = selectLatestCompletionEvidence(
    gc.deliverySpec,
    store.list(runId),
  );
  const artifacts = await inspectDeliveredArtifacts(
    completionEvidence,
    gc.artifactAssertions,
    USE_REAL_FIXTURES ? FIXTURE_ROOT : undefined,
  );
  const delivery = verifyDeliveryContract(gc.deliverySpec, artifacts);
  const artifactScore = scoreArtifactAssertions(gc, artifacts, USE_REAL_FIXTURES);
  const hardGatePassed = !error && delivery.passed && verificationStatus === "passed";
  const artifactSummary = artifactSummaryForJudge(artifacts);
  const judge = hardGatePassed
    ? await judgeCase(gc, task, artifactSummary, response, settings)
    : null;
  const semanticRequired = !SKIP_LLM;
  const semanticAvailable = judge != null;
  const qualityScore = hardGatePassed
    ? SKIP_LLM
      ? artifactScore.deterministicScore
      : judge
        ? artifactScore.deterministicScore * 0.85 + judge.score * 0.15
        : null
    : null;
  // 有未验证断言时不得判 passed:那是「没测」,不是「测过了」。
  const hasUnverified = artifactScore.unverifiableCount > 0;
  const passed =
    hardGatePassed &&
    artifactScore.criticalPassed &&
    !hasUnverified &&
    artifactScore.deterministicScore >= 0.85 &&
    qualityScore != null &&
    qualityScore >= QUALITY_THRESHOLD &&
    !judge?.blocking &&
    (!semanticRequired || semanticAvailable);
  const outcome = watchdogFired
    ? "timeout"
    : toolBudgetExceeded && ENFORCE_PERFORMANCE_BUDGETS
      ? "failed"
    : error && terminationReason === "user_stop"
      ? "cancelled"
      : error && terminationReason === "hard_timeout"
        ? "timeout"
        : error
          ? "failed"
          : !hardGatePassed || !artifactScore.criticalPassed
            ? "failed"
            // 缺 Provider 导致的未验证项 → needs_review,不记模型失败。
            : hasUnverified
              ? "needs_review"
              : !semanticAvailable && semanticRequired
                ? "needs_review"
                : passed
                  ? "passed"
                  : "failed";
  const toolReduction = 1 - toolCalls.length / gc.historicalToolCalls;
  const toolCounts = Object.fromEntries(
    [...new Set(toolCalls)].map((tool) => [
      tool,
      toolCalls.filter((call) => call === tool).length,
    ]),
  );
  const result = {
    id: gc.id,
    title: gc.title,
    sourceSessionId: gc.sourceSessionId,
    runId,
    taskMode: USE_REAL_FIXTURES ? "real" : "synthetic",
    passed,
    outcome,
    hardGatePassed,
    deliveryFailures: delivery.failures,
    deterministicScore: artifactScore.deterministicScore,
    criticalPassed: artifactScore.criticalPassed,
    unverifiableCount: artifactScore.unverifiableCount,
    assertionResults: artifactScore.assertionResults,
    judgeScore: judge?.score ?? null,
    judgeBlocking: judge?.blocking ?? null,
    judgeReason: judge?.reason ?? null,
    semanticStatus: SKIP_LLM ? "skipped" : judge ? "available" : "unavailable",
    judgeStatus: SKIP_LLM ? "skipped" : judge ? "available" : "unavailable",
    qualityScore,
    qualityThreshold: QUALITY_THRESHOLD,
    error,
    response,
    numTurns,
    terminationReason: watchdogFired
      ? "watchdog_timeout"
      : toolBudgetExceeded && ENFORCE_PERFORMANCE_BUDGETS
        ? "tool_budget_exceeded"
        : terminationReason,
    repairRounds,
    repairStopReason,
    verificationStatus,
    historicalToolCalls: gc.historicalToolCalls,
    currentToolCalls: toolCalls.length,
    toolReduction,
    toolCounts,
    hasFinalize: toolCalls.includes("finalize_deliverable"),
    durationMs: Date.now() - started,
    watchdogFired,
    toolBudgetExceeded,
    lastProgressAt,
    timeoutMs: CASE_TIMEOUT_MS,
    agentTimeoutMs: AGENT_TIMEOUT_MS,
    verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
    judgeTimeoutMs: JUDGE_TIMEOUT_MS,
    outputDir,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      text: undefined,
      textExcerpt: artifact.text.slice(0, 4_000),
    })),
  };
  writeFileSync(path.join(caseRoot, "result.json"), JSON.stringify(result, null, 2), "utf8");
  const qualityLabel = qualityScore == null ? "n/a" : qualityScore.toFixed(2);
  console.log(
    `${gc.id} ${outcome.toUpperCase()} quality=${qualityLabel} deterministic=${artifactScore.deterministicScore.toFixed(2)} unverified=${artifactScore.unverifiableCount} tools=${toolCalls.length}/${gc.historicalToolCalls} reduction=${(toolReduction * 100).toFixed(0)}%`,
  );
  return result;
}

async function main() {
  mkdirSync(REPORT_ROOT, { recursive: true });
  const settings = await readAgentSettings();
  if (!SKIP_LLM) {
    if (!settings.apiKey.trim() || !getModelConfigReadiness(settings).modelConfigReady) {
      throw new Error(
        "历史财务评测需要完整真实模型配置；如只做结构与产物断言，请设置 SKIP_LLM=true",
      );
    }
  }
  if (CASES.length === 0) throw new Error("没有匹配的 HISTORY_CASE_ID");
  // 真实模式必须在启动 Agent 前一次性确认附件齐全，禁止静默降级为合成任务。
  if (USE_REAL_FIXTURES) for (const gc of CASES) await attachmentsFor(gc);

  const results = await mapWithConcurrency(
    CASES,
    CONCURRENCY,
    (gc) => runCase(gc, settings),
  );
  const qualityPass = results.filter((result) => result.passed).length;
  const qualityScores = results.flatMap((result) =>
    typeof result.qualityScore === "number" ? [result.qualityScore] : []
  );
  const summary = {
    total: results.length,
    qualityPass,
    avgQuality: qualityScores.length
      ? qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length
      : null,
    avgToolReduction:
      results.reduce((sum, result) => sum + result.toolReduction, 0) / results.length,
    skipLLM: SKIP_LLM,
    realFixtures: USE_REAL_FIXTURES,
    fixtureRoot: FIXTURE_ROOT,
    reportRoot: REPORT_ROOT,
    concurrency: CONCURRENCY,
    timeoutMs: CASE_TIMEOUT_MS,
    agentTimeoutMs: AGENT_TIMEOUT_MS,
    verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
    judgeTimeoutMs: JUDGE_TIMEOUT_MS,
    maxRepairRounds: MAX_REPAIR_ROUNDS,
    toolBudgetFactor: TOOL_BUDGET_FACTOR,
    maxToolCalls: MAX_TOOL_CALLS,
    maxModelCalls: MAX_MODEL_CALLS,
    targetDurationMs: TARGET_DURATION_MS,
    performanceBudgetsEnforced: ENFORCE_PERFORMANCE_BUDGETS,
    qualityThreshold: QUALITY_THRESHOLD,
    casesWithFinalize: results.filter((result) => result.hasFinalize).length,
    casesWithVerificationPass: results.filter(
      (result) => result.verificationStatus === "passed",
    ).length,
    casesMeetingPerformanceTarget: results.filter((result) =>
      (result.numTurns ?? Number.POSITIVE_INFINITY) <= MAX_MODEL_CALLS
      && result.currentToolCalls <= MAX_TOOL_CALLS
      && result.durationMs <= TARGET_DURATION_MS
    ).length,
    outcomes: Object.fromEntries(
      [...new Set(results.map((result) => result.outcome))].map((outcome) => [
        outcome,
        results.filter((result) => result.outcome === outcome).length,
      ]),
    ),
  };
  const report = { summary, results };
  writeFileSync(path.join(REPORT_ROOT, "summary.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exit(qualityPass === results.length ? 0 : 1);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function terminationReasonForError(error: Error): string | undefined {
  if (error.name === "TimeoutError") return "hard_timeout";
  if (error.name === "AbortError") return "user_stop";
  if (error.name === "ValidationError") return "validation_failed";
  if (error.name === "MinimumDeliverableError") return "minimum_deliverable_missing";
  return undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
