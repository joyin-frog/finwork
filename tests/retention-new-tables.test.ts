/**
 * WP-G 保留期补表：四张新表各一条"过期删/未过期留"用例。
 * 跟随 retention.test.ts 的模式。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  pruneOldModelRoutingLogs,
  pruneOldSubagentDispatches,
  pruneOldToolExecutions,
  pruneOldCalcReceipts,
  DEFAULT_RETENTION_CONFIG,
  isValidRetentionSettingsValue,
  loadRetentionConfig,
  runRetentionCycle,
  RETENTION_SETTINGS_KEY,
} from "../lib/maintenance/retention.ts";

export const retentionNewTablesTestPromise = (async () => {
  // 用完整迁移链建库，保证所有四张表均已创建
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);

  const now = Date.parse("2026-06-30T00:00:00.000Z");
  // 8 天前（超过 7 天阈值），应被清理
  const oldIso = new Date(now - 8 * 86_400_000).toISOString();
  // 1 天前（在 7 天阈值内），应保留
  const freshIso = new Date(now - 1 * 86_400_000).toISOString();
  const days = 7;

  // ── model_routing_log ─────────────────────────────────────────────────────
  {
    db.prepare(
      "INSERT INTO model_routing_log(user_message, decision_json, path, router_latency_ms, created_at) VALUES(?, ?, ?, ?, ?)"
    ).run("old msg", "{}", "main", 10, oldIso);
    db.prepare(
      "INSERT INTO model_routing_log(user_message, decision_json, path, router_latency_ms, created_at) VALUES(?, ?, ?, ?, ?)"
    ).run("fresh msg", "{}", "main", 10, freshIso);

    const deleted = pruneOldModelRoutingLogs(days, db, now);
    assert.equal(deleted, 1, "model_routing_log: 过期行应被删除");
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM model_routing_log").get() as { n: number }).n;
    assert.equal(remaining, 1, "model_routing_log: 未过期行应保留");
    console.log("retention-new-tables: model_routing_log PASS ✓");
  }

  // ── subagent_dispatches（时间列 started_at）────────────────────────────────
  {
    db.prepare(
      "INSERT INTO subagent_dispatches(role_id, started_at) VALUES(?, ?)"
    ).run("scout", oldIso);
    db.prepare(
      "INSERT INTO subagent_dispatches(role_id, started_at) VALUES(?, ?)"
    ).run("scout", freshIso);

    const deleted = pruneOldSubagentDispatches(days, db, now);
    assert.equal(deleted, 1, "subagent_dispatches: 过期行应被删除");
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM subagent_dispatches").get() as { n: number }).n;
    assert.equal(remaining, 1, "subagent_dispatches: 未过期行应保留");
    console.log("retention-new-tables: subagent_dispatches PASS ✓");
  }

  // ── tool_executions ───────────────────────────────────────────────────────
  {
    db.prepare(
      "INSERT INTO tool_executions(idempotency_key, tool_name, input_hash, result_json, is_error, created_at) VALUES(?, ?, ?, ?, ?, ?)"
    ).run("key-old", "calc", "h1", "{}", 0, oldIso);
    db.prepare(
      "INSERT INTO tool_executions(idempotency_key, tool_name, input_hash, result_json, is_error, created_at) VALUES(?, ?, ?, ?, ?, ?)"
    ).run("key-fresh", "calc", "h2", "{}", 0, freshIso);

    const deleted = pruneOldToolExecutions(days, db, now);
    assert.equal(deleted, 1, "tool_executions: 过期行应被删除");
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM tool_executions").get() as { n: number }).n;
    assert.equal(remaining, 1, "tool_executions: 未过期行应保留");
    console.log("retention-new-tables: tool_executions PASS ✓");
  }

  // ── calc_receipts ─────────────────────────────────────────────────────────
  {
    db.prepare(
      "INSERT INTO calc_receipts(tool_name, receipt, created_at) VALUES(?, ?, ?)"
    ).run("payroll_calc", "{}", oldIso);
    db.prepare(
      "INSERT INTO calc_receipts(tool_name, receipt, created_at) VALUES(?, ?, ?)"
    ).run("payroll_calc", "{}", freshIso);

    const deleted = pruneOldCalcReceipts(days, db, now);
    assert.equal(deleted, 1, "calc_receipts: 过期行应被删除");
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM calc_receipts").get() as { n: number }).n;
    assert.equal(remaining, 1, "calc_receipts: 未过期行应保留");
    console.log("retention-new-tables: calc_receipts PASS ✓");
  }

  // ── DEFAULT_RETENTION_CONFIG 包含四个新字段 ────────────────────────────────
  {
    assert.equal(DEFAULT_RETENTION_CONFIG.modelRoutingLogDays, 90, "modelRoutingLogDays 默认应为 90");
    assert.equal(DEFAULT_RETENTION_CONFIG.subagentDispatchesDays, 90, "subagentDispatchesDays 默认应为 90");
    assert.equal(DEFAULT_RETENTION_CONFIG.toolExecutionsDays, 30, "toolExecutionsDays 默认应为 30");
    assert.equal(DEFAULT_RETENTION_CONFIG.calcReceiptsDays, 180, "calcReceiptsDays 默认应为 180");
    console.log("retention-new-tables: DEFAULT_RETENTION_CONFIG 四字段 PASS ✓");
  }

  // ── isValidRetentionSettingsValue 接受四个新字段 ───────────────────────────
  {
    assert.equal(
      isValidRetentionSettingsValue('{"modelRoutingLogDays":30}'),
      true,
      "isValidRetentionSettingsValue: modelRoutingLogDays 应合法"
    );
    assert.equal(
      isValidRetentionSettingsValue('{"subagentDispatchesDays":60}'),
      true,
      "isValidRetentionSettingsValue: subagentDispatchesDays 应合法"
    );
    assert.equal(
      isValidRetentionSettingsValue('{"toolExecutionsDays":14}'),
      true,
      "isValidRetentionSettingsValue: toolExecutionsDays 应合法"
    );
    assert.equal(
      isValidRetentionSettingsValue('{"calcReceiptsDays":365}'),
      true,
      "isValidRetentionSettingsValue: calcReceiptsDays 应合法"
    );
    assert.equal(
      isValidRetentionSettingsValue('{"modelRoutingLogDays":0}'),
      false,
      "isValidRetentionSettingsValue: 0 天应非法"
    );
    console.log("retention-new-tables: isValidRetentionSettingsValue PASS ✓");
  }

  // ── loadRetentionConfig 从 DB 读取新字段 ──────────────────────────────────
  {
    db.prepare("INSERT OR REPLACE INTO app_settings(key, value) VALUES(?, ?)").run(
      RETENTION_SETTINGS_KEY,
      '{"modelRoutingLogDays":45,"subagentDispatchesDays":60,"toolExecutionsDays":10,"calcReceiptsDays":90}'
    );
    const cfg = loadRetentionConfig(db);
    assert.equal(cfg.modelRoutingLogDays, 45, "loadRetentionConfig: modelRoutingLogDays");
    assert.equal(cfg.subagentDispatchesDays, 60, "loadRetentionConfig: subagentDispatchesDays");
    assert.equal(cfg.toolExecutionsDays, 10, "loadRetentionConfig: toolExecutionsDays");
    assert.equal(cfg.calcReceiptsDays, 90, "loadRetentionConfig: calcReceiptsDays");
    // 清除覆盖以免影响后续测试
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(RETENTION_SETTINGS_KEY);
    console.log("retention-new-tables: loadRetentionConfig PASS ✓");
  }

  // ── runRetentionCycle 包含四张新表的统计 ──────────────────────────────────
  {
    // 此时表内只有 freshIso 行（旧行已在上面各自测试中删除），均不超期
    const result = runRetentionCycle(
      {
        traceDays: 7, appErrorDays: 7, auditLogDays: 7, chatEventDays: null,
        modelRoutingLogDays: 7, subagentDispatchesDays: 7, toolExecutionsDays: 7, calcReceiptsDays: 7,
      },
      db,
      now
    );
    assert.equal(result.errors.length, 0, "runRetentionCycle: 应无错误");
    assert.ok("modelRoutingLogs" in result.stats, "runRetentionCycle stats 应含 modelRoutingLogs");
    assert.ok("subagentDispatches" in result.stats, "runRetentionCycle stats 应含 subagentDispatches");
    assert.ok("toolExecutions" in result.stats, "runRetentionCycle stats 应含 toolExecutions");
    assert.ok("calcReceipts" in result.stats, "runRetentionCycle stats 应含 calcReceipts");
    console.log("retention-new-tables: runRetentionCycle stats PASS ✓");
  }

  db.close();
  console.log("retention-new-tables: all checks passed ✓");
})();
