/**
 * CR-R1：run store / migration / replay / settled 唯一 / delta 不落库 / complex→mainModel
 */

import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, getUserVersion, runMigrations, LATEST_VERSION } from "../lib/db/migrations.ts";
import { createEmitter } from "../lib/agent/runtime-events.ts";
import { resolveRunExecutionModel, inferRouterFallbackReason } from "../lib/agent/resolve-run-model.ts";
import { resolveExecutionModel, type ModelConfigV2 } from "../lib/settings/model-config.ts";

export const runEventsPersistenceTestPromise = (async () => {
  const pid = process.pid;
  const dbPath = path.join(os.tmpdir(), `finance-agent-r1-${pid}.db`);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const savedDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  try {
    // 触发 getDb 单例指向临时库并跑迁移
    const { getDb } = await import("../lib/db/sqlite.ts");
    const db = getDb();
    assert.ok(getUserVersion(db) >= 21, `user_version should be >= 21, got ${getUserVersion(db)}`);

    const {
      createAgentRun,
      appendDurableRunEvent,
      getAgentRun,
      listRunEventsAfter,
      countSettledEvents,
      upsertRunCheckpoint,
      isDurableRunEventType,
      terminalStatusForSettledOutcome,
      appendTerminalRunEventPair,
    } = await import("../lib/db/run-store.ts");

    // ── T1: migration v21 表/唯一索引存在 ──────────────────────────────────
    {
      const v21 = MIGRATIONS.find((m) => m.version === 21);
      assert.ok(v21, "T1: migration 21 exists");
      assert.equal(v21!.name, "agent_runs_and_run_events");

      const mem = new DatabaseSync(":memory:");
      mem.exec("PRAGMA foreign_keys = ON");
      runMigrations(mem, ":memory:", () => null);
      assert.ok(getUserVersion(mem) >= 21);
      const tables = (mem.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_runs','run_events')"
      ).all() as Array<{ name: string }>).map((r) => r.name).sort();
      assert.deepEqual(tables, ["agent_runs", "run_events"], "T1: tables created");
      const settledIdx = mem.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_run_events_settled_once'"
      ).get();
      assert.ok(settledIdx, "T1: settled unique index");
      mem.close();
      console.log("T1 PASS: migration v21 ✓");
    }

    // ── T2: create run + durable events；delta 不落库 ─────────────────────
    {
      const runId = `run-delta-${pid}`;
      createAgentRun({
        runId,
        traceId: runId,
        conversationId: 1,
        modelUsed: "main-model",
        modelRole: "main",
        executionTier: "reasoning",
      });
      const emitter = createEmitter(runId, 1);
      const started = emitter.wrap({ type: "run_started", conversationId: 1 });
      const delta = emitter.wrap({ type: "message_delta", channel: "text", delta: "hi" });
      const think = emitter.wrap({ type: "message_delta", channel: "thinking", delta: "..." });
      const completed = emitter.wrap({ type: "message_completed", channel: "text", content: "hi" });
      const tool = emitter.wrap({
        type: "tool_completed",
        toolName: "Read",
        toolCallId: "t1",
        content: "ok",
      });

      assert.equal(isDurableRunEventType("message_delta"), false);
      assert.ok(appendDurableRunEvent(started));
      assert.equal(appendDurableRunEvent(delta), null, "T2: delta not persisted");
      assert.equal(appendDurableRunEvent(think), null, "T2: thinking delta not persisted");
      assert.ok(appendDurableRunEvent(completed));
      const toolId = appendDurableRunEvent(tool);
      assert.ok(toolId);

      upsertRunCheckpoint(
        runId,
        {
          version: 1,
          completedToolCallIds: ["t1"],
          generatedFiles: [{ path: "/tmp/a.xlsx", sha256: "a".repeat(64), status: "written" }],
          capturedAt: new Date().toISOString(),
          lastCompletedStage: "tool:Read",
        },
        toolId,
      );

      const { events } = listRunEventsAfter(runId, 0, 50);
      assert.ok(events.every((e) => e.event.type !== "message_delta"), "T2: no deltas in replay");
      assert.ok(events.some((e) => e.event.type === "tool_completed"));
      const run = getAgentRun(runId)!;
      assert.ok(run.latestCheckpoint);
      assert.deepEqual(run.latestCheckpoint!.completedToolCallIds, ["t1"]);
      console.log("T2 PASS: delta not persisted; checkpoint ok ✓");
    }

    // ── T3: settled 唯一 × 三 outcome；终态后拒绝业务事件 ─────────────────
    {
      for (const outcome of ["completed", "aborted", "error"] as const) {
        const runId = `run-settle-${outcome}-${pid}`;
        createAgentRun({ runId, traceId: runId });
        const emitter = createEmitter(runId, null);
        const first = appendDurableRunEvent(emitter.wrap({ type: "run_settled", outcome, error: outcome === "error" ? "boom" : undefined }));
        const second = appendDurableRunEvent(emitter.wrap({ type: "run_settled", outcome }));
        assert.ok(first);
        assert.equal(second, first, `T3: duplicate settled folded (${outcome})`);
        assert.equal(countSettledEvents(runId), 1, `T3: exactly one settled (${outcome})`);
        const status = getAgentRun(runId)!.status;
        assert.equal(status, terminalStatusForSettledOutcome(outcome));
        // 终态后拒绝新业务事件
        const rejected = appendDurableRunEvent(
          emitter.wrap({ type: "tool_completed", toolName: "X", toolCallId: "x" }),
        );
        assert.equal(rejected, null, `T3: post-settled business event rejected (${outcome})`);
      }
      console.log("T3 PASS: settled uniqueness × 3 outcomes ✓");
    }

    // ── T4: replay pagination / cursor ────────────────────────────────────
    {
      const runId = `run-replay-${pid}`;
      createAgentRun({ runId, traceId: runId, conversationId: 9 });
      const emitter = createEmitter(runId, 9);
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const id = appendDurableRunEvent(
          emitter.wrap({ type: "message_completed", channel: "text", content: `c${i}` }),
        );
        assert.ok(id);
        ids.push(id!);
      }
      const page1 = listRunEventsAfter(runId, 0, 2);
      assert.equal(page1.events.length, 2);
      assert.equal(page1.nextEventId, page1.events[1]!.persistentEventId);
      const page2 = listRunEventsAfter(runId, page1.nextEventId!, 2);
      assert.equal(page2.events.length, 2);
      const page3 = listRunEventsAfter(runId, page2.nextEventId!, 10);
      assert.equal(page3.events.length, 1);
      assert.equal(page3.nextEventId, null);
      // eventId 覆盖为持久 id
      assert.equal(page1.events[0]!.eventId, page1.events[0]!.persistentEventId);
      console.log("T4 PASS: replay pagination ✓");
    }

    // ── T5: complex_workflow → mainModel（resolveRunExecutionModel）────────
    {
      const FULL: ModelConfigV2 = {
        version: 2,
        mainModel: "reasoning-model",
        routerModel: "fast-model",
        subagentModel: "fast-model",
      };
      // 直接对照纯 resolver 矩阵
      assert.equal(
        resolveExecutionModel({
          config: FULL,
          purpose: "task",
          intent: "complex_workflow",
          tier: "fast",
        }).modelId,
        "reasoning-model",
      );

      // Query 接线辅助：在 ROUTER_ENABLED 默认 true 时 path=main + complex → main
      const resolved = resolveRunExecutionModel({
        settings: FULL,
        modelTier: "fast",
        routerPath: "main",
        routerIntent: "complex_workflow",
      });
      assert.ok(resolved);
      assert.equal(resolved!.modelId, "reasoning-model", "T5: complex → mainModel");
      assert.equal(resolved!.modelRole, "main");
      assert.equal(resolved!.executionTier, "reasoning");

      // fallback 三分支
      assert.equal(inferRouterFallbackReason("AbortError: timeout"), "router_timeout");
      assert.equal(inferRouterFallbackReason("invalid JSON"), "router_invalid");
      assert.equal(inferRouterFallbackReason("router disabled"), "router_disabled");

      const fb = resolveRunExecutionModel({
        settings: FULL,
        routerPath: "fallback",
        routerFailureHint: "timeout of 15000ms",
      });
      assert.equal(fb!.modelId, "reasoning-model");
      assert.equal(fb!.fallbackReason, "router_timeout");
      console.log("T5 PASS: complex→mainModel + fallback reasons ✓");
    }

    // ── T6: API handlers（动态 import route）──────────────────────────────
    {
      const runId = `run-api-${pid}`;
      createAgentRun({ runId, traceId: runId, conversationId: 3, modelUsed: "m1", modelRole: "main", executionTier: "reasoning" });
      const emitter = createEmitter(runId, 3);
      appendDurableRunEvent(emitter.wrap({ type: "run_started", conversationId: 3 }));
      appendDurableRunEvent(emitter.wrap({ type: "run_settled", outcome: "completed" }));

      const runRoute = await import("../app/api/agent/runs/[runId]/route.ts");
      const eventsRoute = await import("../app/api/agent/runs/[runId]/events/route.ts");

      const missing = await runRoute.GET(new Request("http://local/api/agent/runs/nope"), {
        params: Promise.resolve({ runId: "nope" }),
      });
      assert.equal(missing.status, 404);

      const ok = await runRoute.GET(new Request(`http://local/api/agent/runs/${runId}`), {
        params: Promise.resolve({ runId }),
      });
      assert.equal(ok.status, 200);
      const okBody = await ok.json() as { ok: boolean; schemaVersion: number; data: { run: { runId: string } } };
      assert.equal(okBody.ok, true);
      assert.equal(okBody.schemaVersion, 1);
      assert.equal(okBody.data.run.runId, runId);

      const ev = await eventsRoute.GET(
        new Request(`http://local/api/agent/runs/${runId}/events?afterEventId=0&limit=10`),
        { params: Promise.resolve({ runId }) },
      );
      assert.equal(ev.status, 200);
      const evBody = await ev.json() as { ok: boolean; data: { events: unknown[]; nextEventId: number | null } };
      assert.ok(evBody.data.events.length >= 2);
      console.log("T6 PASS: replay APIs ✓");
    }

    // ── T7: explicit stop persists state_changed before exactly one settled ──
    {
      const runId = `run-stop-${pid}`;
      createAgentRun({
        runId,
        traceId: runId,
        conversationId: 4,
        status: "running",
      });
      const stopRoute = await import("../app/api/agent/runs/[runId]/stop/route.ts");
      const response = await stopRoute.POST(
        new Request(`http://local/api/agent/runs/${runId}/stop`, { method: "POST" }),
        { params: Promise.resolve({ runId }) },
      );
      assert.equal(response.status, 200);

      const replay = listRunEventsAfter(runId, 0, 20).events;
      const changedIdx = replay.findIndex((e) => e.event.type === "run_state_changed");
      const settledIdx = replay.findIndex((e) => e.event.type === "run_settled");
      assert.ok(changedIdx >= 0, "T7: stop must persist run_state_changed");
      assert.ok(settledIdx > changedIdx, "T7: run_settled must follow run_state_changed");
      assert.equal(countSettledEvents(runId), 1, "T7: stop must settle exactly once");
      assert.equal(getAgentRun(runId)!.status, "canceled");
      assert.equal(getAgentRun(runId)!.terminationReason, "user_stop");
      console.log("T7 PASS: explicit stop terminal pair persisted ✓");
    }

    // ── T8: terminal pair second-insert failure rolls back and stop returns 500 ──
    {
      const runId = `run-stop-rollback-${pid}`;
      createAgentRun({
        runId,
        traceId: runId,
        conversationId: 5,
        status: "running",
      });
      const emitter = createEmitter(runId, 5);
      const existingSettled = emitter.wrap({ type: "run_settled", outcome: "aborted" });
      db.prepare(
        `INSERT INTO run_events
           (run_id, conversation_id, instance_id, event_type, event_json, created_at)
         VALUES (?, ?, ?, 'run_settled', ?, ?)`
      ).run(runId, 5, null, JSON.stringify(existingSettled), new Date().toISOString());

      const changed = emitter.wrap({
        type: "run_state_changed",
        from: "running",
        to: "canceled",
        trigger: "explicit_stop_quiesced",
        terminationReason: "user_stop",
      });
      const settled = emitter.wrap({ type: "run_settled", outcome: "aborted" });
      assert.throws(
        () => appendTerminalRunEventPair(changed, settled),
        /UNIQUE|unique/,
        "T8: duplicate settled must fail the transaction",
      );
      assert.equal(getAgentRun(runId)!.status, "running", "T8: failed pair must not change status");
      assert.equal(
        listRunEventsAfter(runId, 0, 20).events.filter((e) => e.event.type === "run_state_changed").length,
        0,
        "T8: failed pair must roll back state_changed",
      );

      const stopRoute = await import("../app/api/agent/runs/[runId]/stop/route.ts");
      const { registerRunAbort, unregisterRunAbort } =
        await import("../lib/agent/run-abort-registry.ts");
      const liveController = new AbortController();
      registerRunAbort(runId, liveController, 5);
      const response = await stopRoute.POST(
        new Request(`http://local/api/agent/runs/${runId}/stop`, { method: "POST" }),
        { params: Promise.resolve({ runId }) },
      );
      assert.equal(response.status, 500, "T8: persistence failure must not report stop success");
      assert.equal(liveController.signal.aborted, true, "T8: persistence failure must still abort live work");
      unregisterRunAbort(runId);
      assert.equal(getAgentRun(runId)!.status, "running");
      console.log("T8 PASS: terminal pair rollback + stop failure surfaced ✓");
    }

    assert.ok(LATEST_VERSION >= 21);
    console.log("run-events-persistence: all PASS ✓");
  } finally {
    if (savedDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = savedDb;
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  }
})();
