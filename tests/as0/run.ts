import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getAppDataDir, getSecretFallbackPath, getSettingsPath } from "@/lib/runtime/paths";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { defaultAttempts, loadManifest, selectTasks } from "./manifest";
import { sanitizeSettingsJson } from "./harness-core";
import type { AttemptEvidence, GoldenTask, WorkerPayload } from "./types";

type CliOptions = {
  live: boolean;
  allowDirty: boolean;
  taskIds: string[];
  attempts?: number;
  outputRoot?: string;
};

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { live: false, allowDirty: false, taskIds: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--live") options.live = true;
    else if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--cases") options.taskIds = (argv[++index] ?? "").split(",").filter(Boolean);
    else if (arg === "--attempts") options.attempts = Number(argv[++index]);
    else if (arg === "--output") options.outputRoot = argv[++index];
    else if (arg === "--plan") options.live = false;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (options.attempts != null && (!Number.isInteger(options.attempts) || options.attempts < 1)) {
    throw new Error("--attempts 必须是正整数");
  }
  return options;
}

export function buildPlan(tasks: GoldenTask[], attempts?: number) {
  return tasks.map((task) => ({
    taskId: task.id,
    capability: task.capability,
    attempts: attempts ?? defaultAttempts(task),
    estimatedRuntimeCalls:
      (attempts ?? defaultAttempts(task)) *
      task.turns.filter((turn) => typeof turn.user === "string").length,
  }));
}

export function assertLiveAuthorized(options: CliOptions, env = process.env): void {
  if (!options.live) return;
  if (env.AS0_ALLOW_LIVE !== "1") {
    throw new Error("真实 Phase B 被安全门阻止：需同时传 --live 并设置 AS0_ALLOW_LIVE=1");
  }
  if (env.FINANCE_AGENT_MOCK_AGENT === "1") {
    throw new Error("Phase B 基线禁止 FINANCE_AGENT_MOCK_AGENT=1");
  }
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

function safeOrigin(apiUrl: string): string {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return "[invalid-url]";
  }
}

function copySanitizedSettings(source: string, target: string): void {
  const parsed = existsSync(source) ? JSON.parse(readFileSync(source, "utf8")) : {};
  writeFileSync(target, `${JSON.stringify(sanitizeSettingsJson(parsed), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function redactLog(value: string, apiKey: string): string {
  return value
    .split(apiKey)
    .join("[REDACTED_API_KEY]")
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, "$1[REDACTED]");
}

function contextSnapshot(): unknown {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/as0/context-snapshot.ts"],
    { cwd: process.cwd(), encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) throw new Error(`context snapshot 失败: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function summarize(attempts: AttemptEvidence[]) {
  const valid = attempts.filter((attempt) => attempt.invalidRunReason == null);
  const machine = valid.flatMap((attempt) => attempt.assertions.filter((assertion) => assertion.status !== "not_observable"));
  return {
    attempts: attempts.length,
    validAttempts: valid.length,
    invalidAttempts: attempts.length - valid.length,
    machineAssertions: {
      passed: machine.filter((assertion) => assertion.status === "pass").length,
      failed: machine.filter((assertion) => assertion.status === "fail").length,
    },
    manualAssertionsPending: valid
      .flatMap((attempt) => attempt.assertions)
      .filter((assertion) => assertion.status === "not_observable").length,
    inputTokens: valid.reduce((sum, attempt) => sum + (attempt.usage.inputTokens ?? 0), 0),
    outputTokens: valid.reduce((sum, attempt) => sum + (attempt.usage.outputTokens ?? 0), 0),
    totalCostUsd: valid.reduce((sum, attempt) => sum + (attempt.usage.totalCostUsd ?? 0), 0),
  };
}

async function runLive(options: CliOptions, tasks: GoldenTask[]): Promise<string> {
  const settings = await readAgentSettings();
  if (!settings.apiKey.trim()) throw new Error("当前 Agent API key 未配置");
  if (!settings.mainModel.trim()) throw new Error("当前 mainModel 未配置");

  const dirtyFiles = git("status", "--short").split("\n").filter(Boolean);
  if (dirtyFiles.length > 0 && !options.allowDirty) {
    throw new Error("工作区非干净态，拒绝冻结基线；确认需要临时运行时显式传 --allow-dirty");
  }

  const commit = git("rev-parse", "HEAD");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const baselineId = `pi-${stamp}-${commit.slice(0, 8)}`;
  const baselineRoot = path.resolve(options.outputRoot ?? path.join("artifacts/evals/as0", baselineId));
  mkdirSync(path.join(baselineRoot, "cases"), { recursive: true });
  writeFileSync(path.join(baselineRoot, "context-snapshot.json"), `${JSON.stringify(contextSnapshot(), null, 2)}\n`);

  const sourceSettingsPath = getSettingsPath();
  const sourceSecretPath = getSecretFallbackPath();
  const sourceAppDataDir = getAppDataDir();
  const plan = buildPlan(tasks, options.attempts);
  const baselineManifest = {
    schemaVersion: 1,
    baselineId,
    gitCommit: commit,
    dirtyFiles,
    appVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
    runtime: "pi",
    providerProtocol: "anthropic-messages",
    gatewayOrigin: safeOrigin(settings.apiUrl),
    mainModel: settings.mainModel,
    routerModel: settings.routerModel,
    subagentModel: settings.subagentModel,
    os: process.platform,
    arch: process.arch,
    runStartedAt: new Date().toISOString(),
    plan,
    sourceAppDataDirHash: gitHash(sourceAppDataDir),
  };
  writeFileSync(path.join(baselineRoot, "manifest.json"), `${JSON.stringify(baselineManifest, null, 2)}\n`);

  const attempts: AttemptEvidence[] = [];
  for (const item of plan) {
    for (let attempt = 1; attempt <= item.attempts; attempt++) {
      const attemptDir = path.join(baselineRoot, "cases", item.taskId, `attempt-${String(attempt).padStart(2, "0")}`);
      mkdirSync(attemptDir, { recursive: true });
      const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), `finwork-as0-${item.taskId.toLowerCase()}-`));
      const appDataDir = path.join(isolatedRoot, "app-data");
      mkdirSync(appDataDir, { recursive: true });
      const settingsPath = path.join(appDataDir, "local-settings.json");
      copySanitizedSettings(sourceSettingsPath, settingsPath);
      const payload: WorkerPayload = {
        taskId: item.taskId,
        attempt,
        attemptDir,
        model: settings.mainModel,
      };
      const payloadPath = path.join(attemptDir, "worker-payload.json");
      writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        const worker = spawnSync(
          process.execPath,
          ["--import", "tsx", "tests/as0/worker.ts", payloadPath],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              AS0_PHASE_B_WORKER: "1",
              FINANCE_AGENT_APP_DATA_DIR: appDataDir,
              FINANCE_AGENT_SETTINGS_PATH: settingsPath,
              FINANCE_AGENT_DB_PATH: path.join(appDataDir, "finance-agent.db"),
              FINANCE_AGENT_FILES_DIR: path.join(attemptDir, "files"),
              FINANCE_AGENT_PI_SESSION_DIR: path.join(appDataDir, "pi-sessions"),
              FINANCE_AGENT_SECRET_FILE: process.env.FINANCE_AGENT_SECRET_FILE ?? sourceSecretPath,
              FINANCE_AGENT_MOCK_AGENT: "0",
            },
          },
        );
        writeFileSync(
          path.join(attemptDir, "stdout.log"),
          redactLog(`${worker.stdout}${worker.stderr ? `\n[stderr]\n${worker.stderr}` : ""}`, settings.apiKey),
          "utf8",
        );
        if (worker.status !== 0) {
          writeFileSync(
            path.join(attemptDir, `attempt-${String(attempt).padStart(2, "0")}.json`),
            `${JSON.stringify({
              schemaVersion: 1,
              taskId: item.taskId,
              attempt,
              runtime: "pi",
              providerProtocol: "anthropic-messages",
              model: settings.mainModel,
              invalidRunReason: `worker_exit_${worker.status}`,
            }, null, 2)}\n`,
          );
        }
      } finally {
        rmSync(isolatedRoot, { recursive: true, force: true });
      }
      const evidencePath = path.join(attemptDir, `attempt-${String(attempt).padStart(2, "0")}.json`);
      attempts.push(JSON.parse(readFileSync(evidencePath, "utf8")) as AttemptEvidence);
    }
  }

  writeFileSync(path.join(baselineRoot, "summary.json"), `${JSON.stringify(summarize(attempts), null, 2)}\n`);
  return baselineRoot;
}

function gitHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertLiveAuthorized(options);
  const { manifest } = loadManifest();
  const tasks = selectTasks(manifest, options.taskIds);
  const plan = buildPlan(tasks, options.attempts);
  if (!options.live) {
    console.log(JSON.stringify({ mode: "plan", liveCalls: false, plan }, null, 2));
    return;
  }
  const output = await runLive(options, tasks);
  console.log(`AS0 Phase B evidence: ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
