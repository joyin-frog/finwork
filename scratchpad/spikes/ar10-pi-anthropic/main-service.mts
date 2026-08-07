import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "../../../lib/agent/runtime-events.ts";

type Mode = "text" | "confirm" | "timeout";

async function main(): Promise<void> {
  if (process.env.AR10_ALLOW_REAL !== "1") {
    throw new Error("Refusing real gateway call without AR10_ALLOW_REAL=1");
  }
  const mode = (process.argv[2] ?? "text") as Mode;
  if (!["text", "confirm", "timeout"].includes(mode)) {
    throw new Error(`Unknown main-service mode: ${mode}`);
  }

  const root = await mkdtemp(path.join(tmpdir(), "finwork-ar10-main-"));
  const previous = snapshotEnvironment();
  const { getSettingsPath } = await import("../../../lib/runtime/paths.ts");
  const realSettingsPath = getSettingsPath();
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "isolated.db");
  process.env.FINANCE_AGENT_MEMORY_PATH = path.join(root, "memory.md");
  process.env.FINANCE_AGENT_SETTINGS_PATH = realSettingsPath;
  const sessionRoot = path.join(root, "sessions");
  const outputDir = path.join(root, "output");
  const events: AgentRuntimeEvent[] = [];
  let settledAtReturn = 0;
  let sessionFile: string | null = null;
  let thrownName: string | null = null;
  try {
    const [{ runPiAgent }, trust] = await Promise.all([
      import("../../../lib/agent/pi/agent-service.ts"),
      import("../../../lib/agent/hooks/session-trust.ts"),
    ]);
    const conversationId = 98101;
    try {
      const result = await runPiAgent(
        {
          messages: [{
            role: "user",
            content:
              mode === "text"
                ? "Reply with exactly AR10_PI_MAIN_OK and nothing else."
                : mode === "confirm"
                  ? "Call mcp__finance_worker__remember_convention exactly once with text \"AR10 isolated confirmation convention\". Then reply exactly AR10_PI_CONFIRM_OK."
                  : "Write a numbered financial explanation with at least 200 sections and do not stop early.",
          }],
          requestId: `ar10-main-${mode}`,
          traceId: `ar10-main-${mode}`,
          conversationId,
          outputDir,
          emit: (event) => events.push(event),
          resolveUserQuestion:
            mode === "confirm"
              ? async () => trust.SESSION_TRUST_CONFIRM_ANSWER
              : undefined,
        },
        {
          sessionRoot,
          agentDir: path.join(root, "agent"),
          hardTimeoutMs: mode === "timeout" ? 100 : 120_000,
        },
      );
      sessionFile = result.runtimeSessionId;
      if (mode !== "timeout") {
        const expected = mode === "text" ? "AR10_PI_MAIN_OK" : "AR10_PI_CONFIRM_OK";
        if (!result.content.includes(expected)) throw new Error(`missing marker ${expected}`);
        if (!result.usage || result.usage.inputTokens + result.usage.outputTokens <= 0) {
          throw new Error("missing main service usage");
        }
      }
    } catch (error) {
      thrownName = error instanceof Error ? error.name : "unknown";
      if (mode !== "timeout") throw error;
    }
    settledAtReturn = events.length;
    const sizeAtReturn = sessionFile ? (await stat(sessionFile)).size : 0;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const sizeAfter = sessionFile ? (await stat(sessionFile)).size : 0;
    const files = await listFiles(root);
    const canonicalSessionRoot = await realpath(sessionRoot);
    const types = events.map((event) => event.type);
    const assertions = {
      noServiceTerminal: !types.some((type) =>
        type === "run_started" || type === "run_ended" || type === "run_settled"),
      controlledSession:
        mode === "timeout" || Boolean(sessionFile?.startsWith(`${canonicalSessionRoot}${path.sep}`)),
      noAuthFile: !files.some((file) => /(^|\/)auth\.json$/.test(file)),
      quiescent750ms: events.length === settledAtReturn && sizeAtReturn === sizeAfter,
      expectedTimeout: mode !== "timeout" || thrownName === "TimeoutError",
      confirmTimeline:
        mode !== "confirm" ||
        ordered(types, ["tool_started", "ask_user", "ask_user_answered", "tool_completed"]),
      trustScoped:
        mode !== "confirm" ||
        (
          trust.listTrustedTools(conversationId).includes(
            "mcp__finance_worker__remember_convention",
          ) &&
          trust.listTrustedTools(conversationId + 1).length === 0
        ),
      isolatedMemory:
        mode !== "confirm" ||
        (await readFile(path.join(root, "memory.md"), "utf8")).includes(
          "AR10 isolated confirmation convention",
        ),
    };
    const passed = Object.values(assertions).every(Boolean);
    console.log(JSON.stringify({
      mode,
      passed,
      assertions,
      eventTypes: types,
      eventTimelineSha256: createHash("sha256").update(types.join("\n")).digest("hex"),
      sessionFileCount: files.filter((file) => file.endsWith(".jsonl")).length,
      thrownName,
    }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    restoreEnvironment(previous);
    await rm(root, { recursive: true, force: true });
  }
}

function ordered(actual: string[], expected: string[]): boolean {
  let cursor = -1;
  for (const value of expected) {
    cursor = actual.indexOf(value, cursor + 1);
    if (cursor < 0) return false;
  }
  return true;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(root, absolute));
    }
  }
  await walk(root);
  return files.sort();
}

function snapshotEnvironment(): Record<string, string | undefined> {
  return {
    FINANCE_AGENT_APP_DATA_DIR: process.env.FINANCE_AGENT_APP_DATA_DIR,
    FINANCE_AGENT_DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
    FINANCE_AGENT_MEMORY_PATH: process.env.FINANCE_AGENT_MEMORY_PATH,
    FINANCE_AGENT_SETTINGS_PATH: process.env.FINANCE_AGENT_SETTINGS_PATH,
  };
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

void main();
