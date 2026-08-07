import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "../../../lib/agent/runtime-events.ts";

async function main(): Promise<void> {
  if (process.env.AR10_ALLOW_REAL !== "1") {
    throw new Error("Refusing real gateway call without AR10_ALLOW_REAL=1");
  }

  const root = await mkdtemp(path.join(tmpdir(), "finwork-ar10-subagent-"));
  const mode = process.argv[2] === "abort" ? "abort" : "success";
  const priorDatabasePath = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "isolated.db");
  const events: Array<{ type: AgentRuntimeEvent["type"]; at: number }> = [];
  try {
    const { runPiSubagent } = await import(
      "../../../lib/agent/pi/subagent-runner.ts"
    );
    const controller = new AbortController();
    const resultPromise = runPiSubagent(
      {
        roleId: "analyst",
        instructions: mode === "abort"
          ? "Write a very long numbered financial analysis with at least 100 sections. Do not stop early."
          : "Reply with exactly AR10_PI_SUBAGENT_OK and nothing else.",
        label: "ar10-pi-subagent",
      },
      {
        parentOutputDir: root,
        traceId: "ar10-pi-subagent",
        signal: controller.signal,
        onEvent: (event) => {
          events.push({ type: event.type, at: Date.now() });
          if (mode === "abort" && event.type === "run_started") {
            setTimeout(() => controller.abort(), 150);
          }
        },
      },
    );
    const result = await resultPromise;
    const countAtReturn = events.length;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const settledIndexes = events.flatMap((event, index) =>
      event.type === "run_settled" ? [index] : [],
    );
    const assertions = {
      expectedOutcome: mode === "abort" ? !result.success : result.success,
      expectedText: mode === "abort"
        ? /取消/.test(result.content)
        : result.content.trim() === "AR10_PI_SUBAGENT_OK",
      oneSettled: settledIndexes.length === 1,
      settledLast:
        settledIndexes.length === 1 && settledIndexes[0] === events.length - 1,
      quiescent750ms: events.length === countAtReturn,
    };
    const passed = Object.values(assertions).every(Boolean);
    console.log(JSON.stringify({
      passed,
      provider: "anthropic-messages",
      mode,
      roleId: "analyst",
      assertions,
      eventTypes: events.map((event) => event.type),
      durationMs: result.durationMs,
    }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    if (priorDatabasePath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = priorDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

void main();
