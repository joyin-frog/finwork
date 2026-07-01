import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { initializeSchema } from "../lib/db/schema.ts";
import { isTrustedLocalMutation } from "../lib/api/local-request.ts";
import {
  claimRetentionRun,
  DEFAULT_RETENTION_CONFIG,
  isValidRetentionSettingsValue,
  loadRetentionConfig,
  pruneOldChatEvents,
  RETENTION_SETTINGS_KEY,
  runRetentionCycle,
} from "../lib/maintenance/retention.ts";

export const retentionTestPromise = (async () => {
  const db = new DatabaseSync(":memory:");
  initializeSchema(db);
  const now = Date.parse("2026-06-30T00:00:00.000Z");
  const oldIso = new Date(now - 8 * 86_400_000).toISOString();
  const freshIso = new Date(now - 1 * 86_400_000).toISOString();

  db.prepare("INSERT INTO agent_traces(trace_id, started_at) VALUES(?, ?)").run("old-trace", oldIso);
  db.prepare("INSERT INTO agent_traces(trace_id, started_at) VALUES(?, ?)").run("fresh-trace", freshIso);
  db.prepare("INSERT INTO agent_spans(id, trace_id, span_type, started_at) VALUES(?, ?, ?, ?)").run(
    "old-span", "old-trace", "tool_call", now - 8 * 86_400_000
  );
  db.prepare("INSERT INTO agent_spans(id, trace_id, span_type, started_at) VALUES(?, ?, ?, ?)").run(
    "active-orphan", "in-flight-trace", "tool_call", now - 1_000
  );

  db.prepare("INSERT INTO app_errors(ts, kind, reported) VALUES(?, 'server', 1)").run(now - 8 * 86_400_000);
  db.prepare("INSERT INTO app_errors(ts, kind, reported) VALUES(?, 'server', 0)").run(now - 8 * 86_400_000);
  db.prepare("INSERT INTO app_errors(ts, kind, reported) VALUES(?, 'server', 1)").run(now - 1 * 86_400_000);

  db.prepare("INSERT INTO audit_logs(event_type, payload, created_at) VALUES('old', '{}', ?)").run(oldIso);
  db.prepare("INSERT INTO audit_logs(event_type, payload, created_at) VALUES('fresh', '{}', ?)").run(freshIso);

  const conversation = db.prepare("INSERT INTO chat_conversations(title) VALUES('retention')").run();
  const message = db.prepare(
    "INSERT INTO chat_messages(conversation_id, role, content) VALUES(?, 'assistant', 'visible history')"
  ).run(Number(conversation.lastInsertRowid));
  db.prepare(
    "INSERT INTO chat_agent_events(message_id, event_type, payload, created_at) VALUES(?, 'tool_result', '{}', ?)"
  ).run(Number(message.lastInsertRowid), oldIso);
  db.prepare(
    "INSERT INTO chat_agent_events(message_id, event_type, payload, created_at) VALUES(?, 'tool_result', '{}', ?)"
  ).run(Number(message.lastInsertRowid), freshIso);

  const result = runRetentionCycle(
    { traceDays: 7, appErrorDays: 7, auditLogDays: 7, chatEventDays: null },
    db,
    now
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.stats, { traces: 1, spans: 1, appErrors: 1, auditLogs: 1, chatEvents: 0 });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM agent_traces").get() as { n: number }).n,
    1,
    "fresh trace must remain"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM agent_spans").get() as { n: number }).n,
    1,
    "fresh in-flight orphan span must not be removed"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM app_errors WHERE reported = 0").get() as { n: number }).n,
    1,
    "unreported errors must never be pruned"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM chat_agent_events").get() as { n: number }).n,
    2,
    "visible chat tool events are retained by default"
  );

  const audit = db.prepare(
    "SELECT payload FROM audit_logs WHERE event_type = 'retention_cycle' ORDER BY id DESC LIMIT 1"
  ).get() as { payload: string };
  assert.equal(JSON.parse(audit.payload).chatEventsEnabled, false, "audit must record chat cleanup disabled");

  assert.equal(pruneOldChatEvents(7, db, now), 1, "explicit chat retention opt-in prunes only old events");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chat_agent_events").get() as { n: number }).n, 1);

  assert.equal(claimRetentionRun(db, now), true, "first startup claims retention run");
  assert.equal(claimRetentionRun(db, now + 60_000), false, "same day startup must skip");
  assert.equal(claimRetentionRun(db, now + 86_400_000), true, "next day startup may run");

  assert.equal(isValidRetentionSettingsValue('{"traceDays":30,"chatEventDays":null}'), true);
  assert.equal(isValidRetentionSettingsValue('{"traceDays":0}'), false);
  assert.equal(isValidRetentionSettingsValue('{"unknown":30}'), false);
  db.prepare("INSERT OR REPLACE INTO app_settings(key, value) VALUES(?, ?)").run(
    RETENTION_SETTINGS_KEY,
    '{"traceDays":30,"chatEventDays":365}'
  );
  assert.deepEqual(loadRetentionConfig(db), {
    ...DEFAULT_RETENTION_CONFIG,
    traceDays: 30,
    chatEventDays: 365,
  });

  const crossSiteRequest = {
    headers: new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
    nextUrl: new URL("http://127.0.0.1:3000/api/settings/app"),
  } as NextRequest;
  assert.equal(isTrustedLocalMutation(crossSiteRequest), false);
  const settingsRoute = readFileSync("app/api/settings/app/route.ts", "utf8");
  assert.match(settingsRoute, /isTrustedLocalMutation\(req\)/, "settings PUT must keep the cross-site guard");

  db.close();
  console.log("retention tests passed");
})();
