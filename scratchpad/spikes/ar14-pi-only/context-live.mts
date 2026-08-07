import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  if (process.env.AR14_ALLOW_REAL !== "1") {
    throw new Error("Refusing real Pi call without AR14_ALLOW_REAL=1");
  }
  const root = await mkdtemp(path.join(tmpdir(), "finwork-ar14-live-"));
  const previous = snapshotEnvironment();
  const { getSettingsPath } = await import("../../../lib/runtime/paths.ts");
  const realSettingsPath = getSettingsPath();
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "isolated.db");
  process.env.FINANCE_AGENT_MEMORY_PATH = path.join(root, "memory.md");
  process.env.FINANCE_AGENT_SETTINGS_PATH = realSettingsPath;
  delete process.env.FINANCE_AGENT_MOCK_AGENT;

  try {
    const [{ runPiAgent }, { resolveAgentContextPolicy }] = await Promise.all([
      import("../../../lib/agent/pi/agent-service.ts"),
      import("../../../lib/agent/context-policy.ts"),
    ]);
    const messages = [{
      role: "user" as const,
      content: "这是财务知识问答上下文精简验证。不调用工具，只回复准确文本 AR14_PI_CONTEXT_OK。",
    }];
    const policy = resolveAgentContextPolicy({ messages, intent: "rag_qa" });
    assert.equal(policy.skillNames?.length, 0);
    assert.equal(policy.toolIds?.length, 4);

    const result = await runPiAgent({
      messages,
      requestId: "ar14-context-live",
      traceId: "ar14-context-live",
      intent: "rag_qa",
    }, {
      sessionRoot: path.join(root, "sessions"),
      agentDir: path.join(root, "agent"),
      hardTimeoutMs: 60_000,
    });
    assert.equal(result.mode, "agent");
    assert.match(result.content, /AR14_PI_CONTEXT_OK/);
    assert.ok(result.runtimeSessionId);
    const sessionRoot = await realpath(path.join(root, "sessions"));
    const sessionFile = await realpath(result.runtimeSessionId);
    assert.ok(sessionFile.startsWith(`${sessionRoot}${path.sep}`));

    console.log(JSON.stringify({
      passed: true,
      marker: "AR14_PI_CONTEXT_OK",
      skillCount: policy.skillNames.length,
      toolCount: policy.toolIds.length,
      controlledSession: true,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      turns: result.numTurns ?? null,
    }, null, 2));
  } finally {
    restoreEnvironment(previous);
    await rm(root, { recursive: true, force: true });
  }
}

function snapshotEnvironment(): Record<string, string | undefined> {
  return {
    FINANCE_AGENT_APP_DATA_DIR: process.env.FINANCE_AGENT_APP_DATA_DIR,
    FINANCE_AGENT_DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
    FINANCE_AGENT_MEMORY_PATH: process.env.FINANCE_AGENT_MEMORY_PATH,
    FINANCE_AGENT_SETTINGS_PATH: process.env.FINANCE_AGENT_SETTINGS_PATH,
    FINANCE_AGENT_MOCK_AGENT: process.env.FINANCE_AGENT_MOCK_AGENT,
  };
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

void main();
