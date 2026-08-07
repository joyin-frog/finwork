import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  if (process.env.AR12_ALLOW_REAL !== "1") {
    throw new Error("Refusing real Query call without AR12_ALLOW_REAL=1");
  }

  const root = await mkdtemp(path.join(tmpdir(), "finwork-ar12-query-"));
  const previous = snapshotEnvironment();
  const { getSettingsPath } = await import("../../../lib/runtime/paths.ts");
  const realSettingsPath = getSettingsPath();
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "isolated.db");
  process.env.FINANCE_AGENT_MEMORY_PATH = path.join(root, "memory.md");
  process.env.FINANCE_AGENT_SETTINGS_PATH = realSettingsPath;
  delete process.env.FINANCE_AGENT_MOCK_AGENT;

  try {
    const [{ POST }, dbModule, runStore, paths] = await Promise.all([
      import("../../../app/api/agent/query/route.ts"),
      import("../../../lib/db/sqlite.ts"),
      import("../../../lib/db/run-store.ts"),
      import("../../../lib/runtime/paths.ts"),
    ]);
    const response = await POST(new Request("http://finwork.local/api/agent/query?stream=false", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "analyst",
        prompt:
          "请分析随附财务说明文件，确认其中的验证标记；不调用工具，只回复准确文本 AR12_PI_QUERY_OK，不要补充其他内容。",
        attachments: [{
          name: "AR12财务说明.txt",
          mimeType: "text/plain",
          size: 44,
          dataUrl: `data:text/plain;base64,${Buffer.from(
            "本文件用于主 Agent 文档分析链路验证。验证标记：AR12_PI_QUERY_OK。",
          ).toString("base64")}`,
        }],
      }),
    }));
    const body = await response.json() as {
      ok?: boolean;
      error?: string;
      data?: {
        mode?: string;
        content?: string;
        runtimeSessionId?: string | null;
        conversationId?: number;
      };
    };
    assert.equal(response.status, 200, body.error ?? "Query should return 200");
    assert.equal(body.ok, true);
    assert.equal(body.data?.mode, "agent", "Query must execute Pi main service, not cheap/mock");
    assert.match(body.data?.content ?? "", /AR12_PI_QUERY_OK/);

    const locator = body.data?.runtimeSessionId;
    assert.ok(locator, "Query must return the Pi session locator");
    const sessionRoot = await realpath(paths.getPiSessionDir());
    const sessionFile = await realpath(locator);
    assert.ok(sessionFile.startsWith(`${sessionRoot}${path.sep}`));
    assert.match(sessionFile, /\.jsonl$/);

    const conversationId = body.data?.conversationId;
    assert.ok(conversationId);
    const conversation = dbModule.getChatConversation(conversationId);
    assert.equal(conversation?.runtimeSessionId, sessionFile);
    assert.ok(conversation?.messages.some((message) =>
      message.role === "assistant" && message.content.includes("AR12_PI_QUERY_OK")
    ));

    const db = dbModule.getDb();
    const run = db.prepare(
      "SELECT run_id FROM agent_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get(conversationId) as { run_id: string } | undefined;
    assert.ok(run?.run_id);
    const settled = db.prepare(
      "SELECT event_type, event_json FROM run_events WHERE run_id = ? ORDER BY id",
    ).all(run.run_id) as Array<{ event_type: string; event_json: string }>;
    assert.equal(
      settled.filter((event) => event.event_type === "run_settled").length,
      1,
      "Query must own exactly one terminal settlement",
    );
    assert.equal(settled.at(-1)?.event_type, "run_settled");
    assert.equal(runStore.getAgentRun(run.run_id)?.status, "completed");

    console.log(JSON.stringify({
      passed: true,
      mode: body.data?.mode,
      marker: "AR12_PI_QUERY_OK",
      controlledSession: true,
      settledCount: 1,
      settledLast: true,
      conversationPersisted: true,
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
