import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import {
  getDb,
  initializeFinanceDatabase,
  openFinanceDatabase,
} from "../lib/db/sqlite.ts";
import { isTrustedLocalMutation } from "../lib/api/local-request.ts";
import { exportDiagnostics } from "../lib/runtime/diagnostics.ts";

export const diagnosticsExportTestPromise = (async () => {
  const root = mkdtempSync(path.join(tmpdir(), "finance-agent-diagnostics-test-"));
  const destination = path.join(root, "exports");
  const dbPath = path.join(root, "finance-agent.db");
  const originalDbPath = process.env.FINANCE_AGENT_DB_PATH;
  const originalAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;

  try {
    const seed = initializeFinanceDatabase(openFinanceDatabase(dbPath), dbPath);
    const conversation = seed.prepare("INSERT INTO chat_conversations(title) VALUES('sensitive')").run();
    seed.prepare(
      "INSERT INTO chat_messages(conversation_id, role, content) VALUES(?, 'user', '卡号6222020200012345678')"
    ).run(Number(conversation.lastInsertRowid));
    seed.close();

    const logsDir = path.join(root, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(path.join(logsDir, "next-server.log"), "server output");
    writeFileSync(path.join(logsDir, "server-2026-06-30.log"), "structured output");
    writeFileSync(path.join(logsDir, "unrelated-secret.txt"), "must not be copied");

    assert.throws(() => exportDiagnostics("relative/path"), /绝对路径/);
    const outsideDestination = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    assert.throws(
      () => exportDiagnostics(outsideDestination),
      /应用数据目录内/,
      "exportDiagnostics itself must reject destinations outside app-owned storage"
    );
    assert.equal(existsSync(outsideDestination), false, "rejected destinations must not be created");
    const result = exportDiagnostics(destination, new Date("2026-06-30T10:00:00.000Z"));

    assert.equal(result.containsSensitiveData, true);
    assert.ok(existsSync(path.join(result.path, "finance-agent.db")));
    assert.ok(existsSync(path.join(result.path, "logs", "next-server.log")));
    assert.ok(existsSync(path.join(result.path, "logs", "server-2026-06-30.log")));
    assert.equal(existsSync(path.join(result.path, "logs", "unrelated-secret.txt")), false);

    const warning = readFileSync(path.join(result.path, "SENSITIVE-DATA-README.txt"), "utf8");
    assert.match(warning, /complete local database snapshot/i);
    assert.match(warning, /not uploaded/i);
    const manifest = JSON.parse(readFileSync(path.join(result.path, "manifest.json"), "utf8")) as {
      containsSensitiveData: boolean;
      localOnly: boolean;
    };
    assert.equal(manifest.containsSensitiveData, true);
    assert.equal(manifest.localOnly, true);

    const snapshot = openFinanceDatabase(path.join(result.path, "finance-agent.db"));
    const stored = snapshot.prepare("SELECT content FROM chat_messages LIMIT 1").get() as { content: string };
    assert.match(stored.content, /6222020200012345678/, "complete snapshot boundary must be explicit, not silently redacted");
    snapshot.close();

    const audit = getDb().prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'diagnostics_export' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(audit, "diagnostics export must be audited");
    assert.equal(JSON.parse(audit!.payload).containsSensitiveData, true);

    const crossSiteRequest = {
      headers: new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
      nextUrl: new URL("http://127.0.0.1:3000/api/settings/doctor/diagnostics"),
    } as NextRequest;
    assert.equal(isTrustedLocalMutation(crossSiteRequest), false);
    const routeSource = readFileSync("app/api/settings/doctor/diagnostics/route.ts", "utf8");
    assert.match(routeSource, /isTrustedLocalMutation\(req\)/, "diagnostics route must keep the cross-site guard");
    assert.match(routeSource, /getAppDataDir\(\).*diagnostics/s, "API export must remain under app-owned storage");
  } finally {
    if (originalDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = originalDbPath;
    if (originalAppData === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = originalAppData;
    rmSync(root, { recursive: true, force: true });
  }

  console.log("diagnostics export tests passed");
})();
