import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadManifest } from "./manifest";
import {
  buildTaskContract,
  evaluateAttempt,
  fileMime,
  fileSize,
  redactSessionId,
  sha256,
  snapshotSideEffects,
} from "./harness-core";
import { seedAttempt } from "./seed";
import type {
  AttemptEvidence,
  GoldenTask,
  RuntimeEventRecord,
  RuntimeTurnResult,
  RuntimeUsage,
  WorkerPayload,
} from "./types";

function emptyUsage(): RuntimeUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    totalCostUsd: null,
    turns: null,
    models: [],
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left == null && right == null) return null;
  return (left ?? 0) + (right ?? 0);
}

function mergeUsage(target: RuntimeUsage, value: RuntimeUsage): RuntimeUsage {
  return {
    inputTokens: addNullable(target.inputTokens, value.inputTokens),
    outputTokens: addNullable(target.outputTokens, value.outputTokens),
    cacheReadInputTokens: addNullable(target.cacheReadInputTokens, value.cacheReadInputTokens),
    cacheCreationInputTokens: addNullable(target.cacheCreationInputTokens, value.cacheCreationInputTokens),
    totalCostUsd: addNullable(target.totalCostUsd, value.totalCostUsd),
    turns: addNullable(target.turns, value.turns),
    models: [...new Set([...target.models, ...value.models])],
  };
}

function safeError(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/\b(sk-ant-|sk-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

function taskById(taskId: string): { task: GoldenTask; fixtureRoot: string } {
  const loaded = loadManifest();
  const task = loaded.manifest.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`未知 task ${taskId}`);
  return { task, fixtureRoot: loaded.fixtureRoot };
}

async function execute(payload: WorkerPayload): Promise<void> {
  const startedAt = new Date();
  const { task, fixtureRoot } = taskById(payload.taskId);
  const inputDir = path.join(payload.attemptDir, "input");
  const filesRoot = path.join(payload.attemptDir, "files");
  const outputDir = path.join(filesRoot, "generate");
  const appDataDir = process.env.FINANCE_AGENT_APP_DATA_DIR;
  if (!appDataDir) throw new Error("worker 缺少 FINANCE_AGENT_APP_DATA_DIR");
  mkdirSync(outputDir, { recursive: true });

  const copiedFixtures = await seedAttempt({ task, fixtureRoot, inputDir });
  const { getDb } = await import("@/lib/db/sqlite");
  const { getMemoryPath } = await import("@/lib/runtime/paths");
  const { SqliteDeliverableStore } = await import("@/lib/deliverable");
  const { ClaudePhaseBRuntime } = await import("./claude-runtime");
  const db = getDb();
  const before = snapshotSideEffects({
    appDataDir,
    outputRoot: filesRoot,
    db,
    memoryPath: getMemoryPath(),
  });

  const runtime = new ClaudePhaseBRuntime();
  const allEvents: RuntimeEventRecord[] = [];
  const allConfirmations: RuntimeTurnResult["confirmations"] = [];
  const allRunIds: string[] = [];
  const capabilityGaps: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const responses: string[] = [];
  let usage = emptyUsage();
  let sessionId: string | null = null;
  let finalOutcome: RuntimeTurnResult["outcome"] = "completed";
  let terminationReason: string | null = null;
  let runtimeError: string | undefined;
  let turnIndex = 0;

  if (task.setup?.forceCompaction && !runtime.capabilities.forcedCompaction) {
    capabilityGaps.push("forced_compaction_not_supported_by_claude_adapter");
  }
  if (task.expected.delivery?.required) {
    capabilityGaps.push("task_contract_ids_not_injected_into_model_context");
  }

  for (const turn of task.turns) {
    if (turn.control) continue;
    if (!turn.user) continue;
    turnIndex += 1;
    messages.push({ role: "user", content: turn.user });
    const attachments = (turn.attachments ?? []).map((relative) => {
      const storagePath = copiedFixtures.get(relative);
      if (!storagePath) throw new Error(`${task.id}: 未复制附件 ${relative}`);
      return {
        name: path.basename(storagePath),
        mimeType: fileMime(storagePath),
        size: fileSize(storagePath),
        storagePath,
        dataUrl: "",
      };
    });
    const runId = `${task.id.toLowerCase()}-a${payload.attempt}-t${turnIndex}`;
    allRunIds.push(runId);
    const result = await runtime.runTurn({
      runId,
      messages,
      attachments,
      outputDir,
      sessionId,
      resumeSession: sessionId != null,
      taskContract: buildTaskContract(task),
      model: payload.model,
      confirmation: task.expected.confirmation,
      abortControl: task.mode === "controlled_abort" ? task.control : undefined,
    });
    allEvents.push(...result.events);
    allConfirmations.push(...result.confirmations);
    usage = mergeUsage(usage, result.usage);
    sessionId = result.sessionId;
    finalOutcome = result.outcome;
    terminationReason = result.terminationReason;
    runtimeError = safeError(result.error);
    if (result.content) {
      responses.push(result.content);
      messages.push({ role: "assistant", content: result.content });
    }
    if (result.outcome !== "completed") break;
  }

  if (
    finalOutcome === "aborted" &&
    usage.inputTokens == null &&
    usage.outputTokens == null &&
    usage.totalCostUsd == null
  ) {
    capabilityGaps.push("aborted_usage_unavailable");
  }

  const store = new SqliteDeliverableStore(db);
  const completionEvidence = allRunIds.flatMap((runId) => store.list(runId));
  const deliverables = allRunIds.flatMap((runId) => store.listByRun(runId));
  const atSettlement = snapshotSideEffects({
    appDataDir,
    outputRoot: filesRoot,
    db,
    memoryPath: getMemoryPath(),
  });
  if (task.mode === "controlled_abort") {
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const after = snapshotSideEffects({
    appDataDir,
    outputRoot: filesRoot,
    db,
    memoryPath: getMemoryPath(),
  });
  const evaluated = evaluateAttempt({
    task,
    events: allEvents,
    confirmations: allConfirmations,
    completionEvidence,
  });

  if (task.mode === "controlled_abort") {
    evaluated.assertions.push({
      id: "runtime.aborted",
      description: "controlled abort 必须以 aborted 收口",
      status: finalOutcome === "aborted" ? "pass" : "fail",
      actual: finalOutcome,
    });
    const settled = allEvents.filter((record) => record.event.type === "run_settled");
    evaluated.assertions.push({
      id: "runtime.settled_once",
      description: "controlled abort 只有一个 canonical run_settled",
      status: settled.length === 1 ? "pass" : "fail",
      actual: settled.length,
    });
    let settledIndex = -1;
    for (let index = allEvents.length - 1; index >= 0; index--) {
      if (allEvents[index].event.type === "run_settled") {
        settledIndex = index;
        break;
      }
    }
    evaluated.assertions.push({
      id: "runtime.no_events_after_settled",
      description: "canonical run_settled 后不得再产生 runtime 事件",
      status: settledIndex === allEvents.length - 1 ? "pass" : "fail",
      actual: allEvents.slice(settledIndex + 1).map((record) => record.event.type),
    });
    evaluated.assertions.push({
      id: "side_effect.quiescent_after_settled",
      description: "settled 后静默窗口内文件、数据库和记忆不得继续变化",
      status: JSON.stringify(atSettlement) === JSON.stringify(after) ? "pass" : "fail",
      actual: { atSettlement, after },
    });
  }
  if (task.setup?.forceCompaction && !runtime.capabilities.forcedCompaction) {
    evaluated.assertions.push({
      id: "runtime.force_compaction_supported",
      description: "Runtime 必须支持可控 compaction 才能完成该断言",
      status: "fail",
      actual: runtime.capabilities,
    });
  }
  const forbidsLongTermMemory = task.expected.forbiddenTools.some((expression) =>
    expression.split("|").includes("remember_convention")
  );
  if (task.expected.confirmation === "reject" || forbidsLongTermMemory) {
    evaluated.assertions.push({
      id: "side_effect.memory_unchanged",
      description: "拒绝或禁止长期记忆时，记忆文件不得变化",
      status: before.memorySha256 === after.memorySha256 ? "pass" : "fail",
      actual: { before: before.memorySha256, after: after.memorySha256 },
    });
  }
  if (task.id === "AS0-15") {
    const beforeFiles = JSON.stringify(before.files);
    const afterFiles = JSON.stringify(after.files);
    evaluated.assertions.push({
      id: "side_effect.files_unchanged",
      description: "拒绝导出后不得生成文件",
      status: beforeFiles === afterFiles ? "pass" : "fail",
      actual: after.files,
    });
  }

  const response = responses.join("\n\n");
  const attemptPath = path.join(payload.attemptDir, `attempt-${String(payload.attempt).padStart(2, "0")}.json`);
  const eventsPath = path.join(payload.attemptDir, "events.jsonl");
  const responsePath = path.join(payload.attemptDir, "response.txt");
  writeFileSync(eventsPath, allEvents.map((record) => JSON.stringify(record)).join("\n") + (allEvents.length ? "\n" : ""), "utf8");
  writeFileSync(responsePath, response, "utf8");

  const invalidRunReason =
    finalOutcome === "error"
      ? runtimeError ?? "runtime_error"
      : null;
  const evidence: AttemptEvidence = {
    schemaVersion: 1,
    taskId: task.id,
    attempt: payload.attempt,
    runtime: runtime.id,
    providerProtocol: runtime.providerProtocol,
    model: payload.model || null,
    sessionIdRedacted: redactSessionId(sessionId),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    outcome: finalOutcome,
    terminationReason,
    toolCalls: evaluated.toolCalls,
    skillLoads: evaluated.skillLoads,
    confirmations: allConfirmations,
    usage,
    assertions: evaluated.assertions,
    completionEvidence,
    deliverables,
    sideEffects: { before, atSettlement, after },
    responseSha256: sha256(response),
    evidencePaths: [
      path.relative(payload.attemptDir, attemptPath),
      path.relative(payload.attemptDir, eventsPath),
      path.relative(payload.attemptDir, responsePath),
    ],
    invalidRunReason,
    capabilityGaps,
  };
  writeFileSync(attemptPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("usage: worker.ts <payload.json>");
  const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as WorkerPayload;
  await execute(payload);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(safeError(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exit(1);
  });
}
