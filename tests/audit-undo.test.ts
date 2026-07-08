/**
 * WP15: 审计日志与撤销——spec §1 成功标准全覆盖测试
 *
 * 先红后绿（TDD）：先写此测试文件，跑红；再实现 v12 迁移 + audit-store + finance-store 接入。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const auditUndoTestPromise = (async () => {
  // ── 环境隔离：每次测试用独立 db ──────────────────────────────────────────
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "audit-undo-test-"));
  const dbPath = path.join(baseDir, "audit-undo.db");
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db);

  const { recordAudit, listAuditEntries, undoAuditEntry } = await import("../lib/db/audit-store.ts");
  const { recordInvoices, upsertBusinessMetrics } = await import("../lib/db/finance-store.ts");

  // ── AU1: v12 迁移形状——新列全部存在 ──────────────────────────────────────
  type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null };
  const cols = db.prepare("PRAGMA table_info(audit_logs)").all() as ColInfo[];
  const colNames = cols.map((c) => c.name);
  assert.ok(colNames.includes("conversation_id"), "AU1 FAIL: audit_logs 缺 conversation_id 列");
  assert.ok(colNames.includes("tool_name"), "AU1 FAIL: audit_logs 缺 tool_name 列");
  assert.ok(colNames.includes("undo"), "AU1 FAIL: audit_logs 缺 undo 列");
  assert.ok(colNames.includes("undone_at"), "AU1 FAIL: audit_logs 缺 undone_at 列");
  // created_at 索引
  const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_logs'").all() as { name: string }[];
  const idxNames = idxRows.map((r) => r.name);
  assert.ok(idxNames.includes("idx_audit_logs_created_at"), "AU1 FAIL: 缺 idx_audit_logs_created_at 索引");

  // ── AU2: recordAudit 基本写入 ────────────────────────────────────────────
  const id1 = recordAudit(db, {
    eventType: "test_event",
    payload: { x: 1 },
    conversationId: 42,
    toolName: "test_tool",
  });
  assert.ok(typeof id1 === "number" && id1 > 0, "AU2 FAIL: recordAudit 应返回正整数 id");
  const row1 = db.prepare("SELECT * FROM audit_logs WHERE id = ?").get(id1) as Record<string, unknown>;
  assert.equal(row1.event_type, "test_event", "AU2 FAIL: event_type 不匹配");
  assert.equal(row1.conversation_id, 42, "AU2 FAIL: conversation_id 不匹配");
  assert.equal(row1.tool_name, "test_tool", "AU2 FAIL: tool_name 不匹配");
  assert.equal(row1.undo, null, "AU2 FAIL: 无 undo 载荷时应为 null");

  // ── AU3: 白名单校验——非 fact_invoices/fact_metrics 表拒绝 ────────────────
  assert.throws(() => {
    recordAudit(db, {
      eventType: "bad_write",
      payload: {},
      undo: [{ op: "delete_rows", table: "chat_messages", keyColumn: "id", keys: [1] }],
    });
  }, /白名单|whitelist/i, "AU3 FAIL: 非白名单表应抛错");

  // ── AU4: delete_rows 逆操作原语 ──────────────────────────────────────────
  // 先写两条 fact_invoices 行
  recordInvoices([
    { invoiceNo: "INV-AU4-A", amount: 100, conversationId: 10 },
    { invoiceNo: "INV-AU4-B", amount: 200, conversationId: 10 },
  ], db);
  const auditId4 = recordAudit(db, {
    eventType: "invoice_ledger_record",
    payload: {},
    conversationId: 10,
    undo: [{ op: "delete_rows", table: "fact_invoices", keyColumn: "invoice_no", keys: ["INV-AU4-A", "INV-AU4-B"] }],
  });
  const result4 = undoAuditEntry(auditId4, db);
  assert.equal(result4.undone, true, "AU4 FAIL: undoAuditEntry 应返回 undone:true");
  const remain = db.prepare("SELECT invoice_no FROM fact_invoices WHERE invoice_no IN ('INV-AU4-A','INV-AU4-B')").all();
  assert.equal(remain.length, 0, "AU4 FAIL: 撤销后两行应已删除");
  // 撤销本身留痕
  const undoEvent = db.prepare("SELECT event_type FROM audit_logs WHERE event_type='audit_undo' ORDER BY id DESC LIMIT 1").get() as { event_type: string } | undefined;
  assert.ok(undoEvent, "AU4 FAIL: 撤销应追记 audit_undo 事件");
  // undone_at 已置
  const row4 = db.prepare("SELECT undone_at FROM audit_logs WHERE id = ?").get(auditId4) as { undone_at: string | null };
  assert.ok(row4.undone_at != null, "AU4 FAIL: undone_at 应非 null");

  // ── AU5: 二次撤销拒绝 ────────────────────────────────────────────────────
  assert.throws(() => undoAuditEntry(auditId4, db), /已撤销|already undone/i, "AU5 FAIL: 二次撤销应抛错");

  // ── AU6: 无 undo 载荷 → 结构化"不可撤销"错误 ─────────────────────────────
  const idNoUndo = recordAudit(db, { eventType: "payroll_confirm", payload: { year: 2026, month: 1 } });
  assert.throws(() => undoAuditEntry(idNoUndo, db), /不可撤销|undoable/i, "AU6 FAIL: 无 undo 载荷应抛'不可撤销'错");

  // ── AU7: restore_rows 逆操作原语 ─────────────────────────────────────────
  // 写一条 fact_metrics 再记 restore_rows（before-image）撤销
  upsertBusinessMetrics([{ year: 2026, month: 1, revenue: 1000, profit: 200 }], db);
  const beforeMetric = db.prepare("SELECT * FROM fact_metrics WHERE year=2026 AND month=1").get() as Record<string, unknown>;
  // 修改这条
  upsertBusinessMetrics([{ year: 2026, month: 1, revenue: 2000, profit: 400 }], db);
  const auditId7 = recordAudit(db, {
    eventType: "business_metrics_write",
    payload: {},
    undo: [{ op: "restore_rows", table: "fact_metrics", keyColumn: "id", rows: [beforeMetric] }],
  });
  undoAuditEntry(auditId7, db);
  const after7 = db.prepare("SELECT revenue_cents FROM fact_metrics WHERE year=2026 AND month=1").get() as { revenue_cents: number };
  assert.equal(after7.revenue_cents, beforeMetric.revenue_cents, "AU7 FAIL: restore_rows 应恢复 before-image");

  // ── AU8: 事务原子性（逆操作中途失败全回滚）────────────────────────────────
  // 构造真实的中途失败：
  //   op1（能成功）：delete_rows — 先插入 INV-AU8-ATOM 行，让 op1 真的删得掉
  //   op2（必然失败）：restore_rows — revenue_cents=null 违反 fact_metrics NOT NULL 约束
  // 断言：undoAuditEntry 抛错 → op1 效果已回滚（INV-AU8-ATOM 仍在）→ undone_at=null → 无 audit_undo 追记
  recordInvoices([{ invoiceNo: "INV-AU8-ATOM", amount: 10 }], db);
  const atomBefore = db.prepare("SELECT invoice_no FROM fact_invoices WHERE invoice_no='INV-AU8-ATOM'").get();
  assert.ok(atomBefore, "AU8 setup FAIL: INV-AU8-ATOM 应已存在");

  const undoAuditCountBefore = (db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type='audit_undo'").get() as { n: number }).n;

  // 直接写 undo JSON（绕过 recordAudit 白名单，模拟攻击者写法——此处两个 op 都是白名单表，但 op2 数据违约）
  // 使用 recordAudit 正常路径写入（两个 op 都是白名单表，白名单校验通过）
  const idAtom = recordAudit(db, {
    eventType: "atomic_test",
    payload: {},
    undo: [
      // op1：删除 INV-AU8-ATOM（真实存在，能成功）
      { op: "delete_rows", table: "fact_invoices", keyColumn: "invoice_no", keys: ["INV-AU8-ATOM"] },
      // op2：restore_rows 含 revenue_cents=null → 违反 fact_metrics.revenue_cents NOT NULL 约束 → 必然失败
      {
        op: "restore_rows",
        table: "fact_metrics",
        keyColumn: "id",
        rows: [{
          id: 99999,
          year: 2099,
          month: 1,
          revenue_cents: null,           // NOT NULL 违反 → 触发约束错误
          profit_cents: 100,
          settlement_status: "stated",
          caliber_version: "v1",
          source: "user_dictated",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        }],
      },
    ],
  });

  // undoAuditEntry 应当抛错（op2 违约）
  assert.throws(
    () => undoAuditEntry(idAtom, db),
    (err: unknown) => err instanceof Error,
    "AU8 FAIL: 中途失败应抛错"
  );

  // op1 效果已回滚——INV-AU8-ATOM 仍应存在
  const atomAfterRollback = db.prepare("SELECT invoice_no FROM fact_invoices WHERE invoice_no='INV-AU8-ATOM'").get();
  assert.ok(atomAfterRollback, "AU8 FAIL: 事务回滚后 INV-AU8-ATOM 应仍存在（op1 效果已撤回）");

  // undone_at 仍为 null（事务未提交）
  const rowAtom = db.prepare("SELECT undone_at FROM audit_logs WHERE id=?").get(idAtom) as { undone_at: string | null };
  assert.equal(rowAtom.undone_at, null, "AU8 FAIL: 失败路径 undone_at 应仍为 null（事务回滚）");

  // 无 audit_undo 事件追记（事务回滚，追记也被撤消）
  const undoAuditCountAfter = (db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type='audit_undo'").get() as { n: number }).n;
  assert.equal(undoAuditCountAfter, undoAuditCountBefore, "AU8 FAIL: 失败路径不应追记 audit_undo 事件");

  // ── AU8b: N1 防御纵深——手工注入非白名单表名被执行时拒绝 ──────────────────
  // 直接向 audit_logs 塞一条白名单外表名的 undo JSON，绕过 recordAudit 校验
  db.prepare(`
    INSERT INTO audit_logs (event_type, payload, undo)
    VALUES ('injected_write', '{}', ?)
  `).run(JSON.stringify([{ op: "delete_rows", table: "chat_messages", keyColumn: "id", keys: [1] }]));
  const injectedRow = db.prepare("SELECT id FROM audit_logs WHERE event_type='injected_write' ORDER BY id DESC LIMIT 1").get() as { id: number };
  assert.throws(
    () => undoAuditEntry(injectedRow.id, db),
    /白名单|whitelist/i,
    "AU8b FAIL: 执行时应拒绝非白名单表名（运行时二次校验）"
  );
  // undone_at 仍为 null（被拦截，事务未开始）
  const injRow = db.prepare("SELECT undone_at FROM audit_logs WHERE id=?").get(injectedRow.id) as { undone_at: string | null };
  assert.equal(injRow.undone_at, null, "AU8b FAIL: 被拦截的注入记录 undone_at 应仍为 null");

  // ── AU9: listAuditEntries 倒序 + undoableOnly ────────────────────────────
  const list = listAuditEntries({ limit: 10 }, db);
  assert.ok(list.length >= 2, "AU9 FAIL: listAuditEntries 应返回多条");
  // 倒序验证：id 递减
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].id >= list[i].id, "AU9 FAIL: listAuditEntries 应倒序");
  }
  // undoableOnly
  const undoableList = listAuditEntries({ limit: 50, undoableOnly: true }, db);
  for (const entry of undoableList) {
    assert.ok(entry.undoable, "AU9 FAIL: undoableOnly 不应包含 undoable=false 的条目");
  }

  // ── AU10: 会话删除后 audit 行仍在（不随 CASCADE 删除）───────────────────
  // 先建一个会话
  db.exec(`INSERT INTO chat_conversations (title, user_id) VALUES ('测试', 'default-user')`);
  const convRow = db.prepare("SELECT id FROM chat_conversations ORDER BY id DESC LIMIT 1").get() as { id: number };
  const convId = convRow.id;
  const idConv = recordAudit(db, {
    eventType: "conv_test",
    payload: {},
    conversationId: convId,
  });
  // 删除会话
  db.prepare("DELETE FROM chat_conversations WHERE id = ?").run(convId);
  // audit 行仍在
  const auditSurvive = db.prepare("SELECT id FROM audit_logs WHERE id = ?").get(idConv);
  assert.ok(auditSurvive != null, "AU10 FAIL: 删除会话后 audit 行应仍存活");

  // ── AU11: recordInvoices → undo 载荷正确性（端到端）────────────────────
  // 先写 A，再带 A+B 重复写，撤销第二条只删 B（重复发票不误删）
  const prior = await (async () => {
    recordInvoices([{ invoiceNo: "INV-PRIOR-A", amount: 50 }], db);
    return db.prepare("SELECT invoice_no FROM fact_invoices WHERE invoice_no='INV-PRIOR-A'").get();
  })();
  assert.ok(prior, "AU11 setup: INV-PRIOR-A 应先存在");

  // 第二次写 A+B（A 重复 → 只插 B，undo=delete B）
  const result11 = recordInvoices([
    { invoiceNo: "INV-PRIOR-A", amount: 50 },
    { invoiceNo: "INV-NEW-B",   amount: 80 },
  ], db);
  assert.deepEqual(result11.inserted, ["INV-NEW-B"], "AU11 FAIL: inserted 应只含 B");
  assert.equal(result11.duplicates.length, 1, "AU11 FAIL: 应有 1 条 duplicate");

  // 查找刚才由 recordInvoices 写入的最新 audit 记录
  const auditRow11 = db.prepare(
    "SELECT id, undo FROM audit_logs WHERE event_type='invoice_ledger_record' ORDER BY id DESC LIMIT 1"
  ).get() as { id: number; undo: string | null };
  assert.ok(auditRow11?.undo, "AU11 FAIL: recordInvoices 应写入 undo 载荷");
  const undo11 = JSON.parse(auditRow11.undo!) as Array<{ op: string; keys: string[] }>;
  assert.equal(undo11[0].keys.length, 1, "AU11 FAIL: undo.keys 应只含 B（不含重复的 A）");
  assert.equal(undo11[0].keys[0], "INV-NEW-B", "AU11 FAIL: undo.keys[0] 应为 INV-NEW-B");

  // 执行撤销 → B 被删，A 仍在
  undoAuditEntry(auditRow11.id, db);
  const aStill = db.prepare("SELECT invoice_no FROM fact_invoices WHERE invoice_no='INV-PRIOR-A'").get();
  const bGone  = db.prepare("SELECT invoice_no FROM fact_invoices WHERE invoice_no='INV-NEW-B'").get();
  assert.ok(aStill, "AU11 FAIL: 撤销后 A 仍应存在");
  assert.ok(bGone == null, "AU11 FAIL: 撤销后 B 应已删除");

  // ── AU12: upsertBusinessMetrics → undo 载荷 + 端到端撤销 ────────────────
  // 先写一条，记录 before-image，再更新，撤销应恢复
  upsertBusinessMetrics([{ year: 2025, month: 6, revenue: 3000, profit: 600 }], db);
  // 再次 upsert（会触发 before-image 快照 → audit undo=restore_rows）
  upsertBusinessMetrics([{ year: 2025, month: 6, revenue: 5000, profit: 900, conversationId: 55 } as Parameters<typeof upsertBusinessMetrics>[0][0] & { conversationId?: number }], db);
  const auditRow12 = db.prepare(
    "SELECT id, undo FROM audit_logs WHERE event_type='business_metrics_write' ORDER BY id DESC LIMIT 1"
  ).get() as { id: number; undo: string | null };
  assert.ok(auditRow12?.undo, "AU12 FAIL: upsertBusinessMetrics 应写入 undo 载荷");
  undoAuditEntry(auditRow12.id, db);
  const after12 = db.prepare("SELECT revenue_cents FROM fact_metrics WHERE year=2025 AND month=6").get() as { revenue_cents: number } | undefined;
  assert.ok(after12, "AU12 FAIL: 撤销后行应仍存在（restore_rows）");
  assert.equal(after12.revenue_cents, 300000, "AU12 FAIL: 撤销后应恢复到 3000元=300000分");

  // ── AU13: 撤销守卫——UPDATE AND undone_at IS NULL 防双撤（WP-D #2）────────────
  // 写一条有 undo 载荷的记录，撤销一次后再撤一次，第二次必须抛"已被撤销"错误。
  // 现有外层检查（SELECT undone_at != null）已保证此行为；WP-D 在 UPDATE 层追加守卫
  // 以增加纵深防御（并发/外层绕过场景）。测试验证行为正确性。
  recordInvoices([{ invoiceNo: "INV-AU13-GUARD", amount: 500 }], db);
  const auditId13 = recordAudit(db, {
    eventType: "guard_test",
    payload: {},
    undo: [{ op: "delete_rows", table: "fact_invoices", keyColumn: "invoice_no", keys: ["INV-AU13-GUARD"] }],
  });
  undoAuditEntry(auditId13, db); // 第一次撤销（成功）
  const rowAU13 = db.prepare("SELECT undone_at FROM audit_logs WHERE id=?").get(auditId13) as { undone_at: string | null };
  assert.ok(rowAU13.undone_at != null, "AU13 FAIL: 第一次撤销后 undone_at 应已设置");
  // 第二次撤销——不管外层检查还是 UPDATE 守卫，都应抛错
  assert.throws(
    () => undoAuditEntry(auditId13, db),
    (err: unknown) => err instanceof Error && /已撤销|already/i.test(err.message),
    "AU13 FAIL: 第二次撤销应抛'已撤销'错误（WP-D 守卫）"
  );

  db.close();
  console.log("audit-undo: all checks passed ✓");
})();
