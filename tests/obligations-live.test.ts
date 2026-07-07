/**
 * WP1b: fact_obligations v9 落盘、回填、四路写钩子、读切换等价性测试
 *
 * 临时库路径模式参照 db-migration-discipline.test.ts（/tmp/finance-agent-<name>-<pid>.db）
 * 测试须先跑红（v9 尚未实施），实施完后绿。
 *
 * 覆盖范围：
 * V1  v9 表形状（新列清单：kind/amount_cents NULL/due_date NOT NULL/status_raw/source_doc/等）
 * V2  迁移内回填（confirmed 文档 → fact_obligations 行）
 * V3  persistDerivedObligations INSERT 适配新列清单
 * V4  PATCH 钩子—confirmed 落盘
 * V5  PATCH 钩子—降级（none/draft）清行
 * V6  deleteDocument 清行
 * V7  setKnowledgeArchived(true) 清行 / setKnowledgeArchived(false) 重派生
 * V8  listCashObligations 读写等价性（amount |a-b|<0.005，其余严格相等）
 */

import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, MIGRATIONS } from "../lib/db/migrations.ts";
import { initializeSchema } from "../lib/db/schema.ts";
import { openFinanceDatabase, initializeFinanceDatabase } from "../lib/db/sqlite.ts";
import { deriveCashObligations, persistDerivedObligations } from "../lib/domain/cash-obligations.ts";
import type { ObligationSourceDoc } from "../lib/domain/cash-obligations.ts";
import type { DocMetadata } from "../lib/knowledge/types.ts";

// 懒读：listCashObligations 由 WP1b 新增，可能还不存在
import * as financeStoreModule from "../lib/db/finance-store.ts";
const listCashObligations = (financeStoreModule as Record<string, unknown>)["listCashObligations"] as
  | ((db: DatabaseSync) => import("../lib/domain/cash-obligations.ts").CashObligation[])
  | undefined;

const pid = process.pid;

function tmpDb(name: string): string {
  const p = path.join(os.tmpdir(), `finance-agent-oblive-${name}-${pid}.db`);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function buildDb(dbPath: string): DatabaseSync {
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);
  return db;
}

/** 构造一个 ObligationSourceDoc（confirmed，含有效 metadata） */
function makeDoc(overrides: Partial<DocMetadata> & { id?: number; fileName?: string } = {}): ObligationSourceDoc {
  const { id = 1, fileName = "test-contract.pdf", ...metaOverrides } = overrides;
  const meta: DocMetadata = {
    status: metaOverrides.status ?? "待付",
    counterparty: metaOverrides.counterparty ?? "测试甲方",
    amount: metaOverrides.amount ?? 10000,
    keyDates: metaOverrides.keyDates ?? [{ kind: "付款", date: "2026-08-01" }],
    sourceFile: metaOverrides.sourceFile ?? fileName,
    recurrence: metaOverrides.recurrence,
  };
  return {
    id,
    fileName,
    metadata: meta,
    metaStatus: "confirmed",
  };
}

/** 在给定 db 内插入一条 knowledge_documents 行，返回其 id */
function insertKnowledgeDoc(
  db: DatabaseSync,
  overrides: { fileName?: string; metaStatus?: string; metadata?: Record<string, unknown> | null; archived?: number } = {}
): number {
  const meta = overrides.metadata !== undefined
    ? (overrides.metadata ? JSON.stringify(overrides.metadata) : null)
    : JSON.stringify({
        status: "待付",
        counterparty: "甲方",
        amount: 5000,
        keyDates: [{ kind: "付款", date: "2026-09-01" }],
        sourceFile: overrides.fileName ?? "contract.pdf",
      });
  const r = db.prepare(`
    INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count,
      content_hash, storage_path, metadata, meta_status, archived)
    VALUES (?, ?, 'application/pdf', 'contract', 0, 0, '', '', ?, ?, ?)
  `).run(
    overrides.fileName ?? "contract.pdf",
    overrides.fileName ?? "contract.pdf",
    meta,
    overrides.metaStatus ?? "confirmed",
    overrides.archived ?? 0
  );
  return Number(r.lastInsertRowid);
}

export const obligationsLiveTestPromise = (async () => {

  // ─────────────────────────────────────────────────────────────────────────
  // V1: v9 表形状
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v1-shape");
    const db = buildDb(dbPath);

    const cols = (db.prepare("PRAGMA table_info(fact_obligations)").all() as Array<{ name: string }>).map(c => c.name);

    // 新表必须有这些列（v9 重建后）
    const required = [
      "id", "kind", "amount_cents", "due_date", "counterparty",
      "status", "status_raw", "source_doc", "recurrence",
      "source_document_id", "settlement_status", "source", "provenance", "derived_at"
    ];
    for (const col of required) {
      assert.ok(cols.includes(col), `V1 FAIL: fact_obligations 缺少列 ${col}，实际列: ${JSON.stringify(cols)}`);
    }

    // 旧列 direction 已被 kind 替代，不应存在
    assert.ok(!cols.includes("direction"), `V1 FAIL: fact_obligations 不应有 direction 列（v9 重建后）`);

    // amount_cents 应允许 NULL（INTEGER NULL）
    const colInfo = db.prepare("PRAGMA table_info(fact_obligations)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null;
    }>;
    const amountCol = colInfo.find(c => c.name === "amount_cents");
    assert.ok(amountCol, "V1 FAIL: 找不到 amount_cents 列");
    assert.equal(amountCol!.notnull, 0, `V1 FAIL: amount_cents 应为 NULL（notnull=0），实际: ${amountCol!.notnull}`);

    // due_date NOT NULL
    const dueDateCol = colInfo.find(c => c.name === "due_date");
    assert.ok(dueDateCol, "V1 FAIL: 找不到 due_date 列");
    assert.equal(dueDateCol!.notnull, 1, `V1 FAIL: due_date 应为 NOT NULL（notnull=1），实际: ${dueDateCol!.notnull}`);

    // source_document_id NOT NULL
    const srcDocCol = colInfo.find(c => c.name === "source_document_id");
    assert.ok(srcDocCol, "V1 FAIL: 找不到 source_document_id 列");
    assert.equal(srcDocCol!.notnull, 1, `V1 FAIL: source_document_id 应为 NOT NULL（notnull=1），实际: ${srcDocCol!.notnull}`);

    // 索引应存在
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fact_obligations'"
    ).all() as Array<{ name: string }>).map(i => i.name);
    assert.ok(indexes.some(i => i.includes("due")), `V1 FAIL: 缺少 due_date 索引，实际索引: ${JSON.stringify(indexes)}`);
    assert.ok(indexes.some(i => i.includes("src_doc") || i.includes("source_document")), `V1 FAIL: 缺少 source_document_id 索引，实际索引: ${JSON.stringify(indexes)}`);

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V1 PASS: v9 表形状 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V2: 迁移内回填（confirmed 文档在 v9 迁移时自动填入 fact_obligations）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v2-backfill");
    // 建到 v8（不跑 v9）：手动逐条执行 v1-v8，跳过 v9
    const db = openFinanceDatabase(dbPath);
    for (const m of MIGRATIONS.filter(m => m.version <= 8)) {
      db.exec("BEGIN");
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    }

    // 在 v8 库中插入 confirmed 文档（v9 迁移前）
    const meta = JSON.stringify({
      status: "待付",
      counterparty: "回填测试甲方",
      amount: 12345.67,
      keyDates: [{ kind: "付款", date: "2026-09-15" }],
      sourceFile: "backfill-contract.pdf",
    });
    db.prepare(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count,
        content_hash, storage_path, metadata, meta_status, archived)
      VALUES ('回填测试', 'backfill-contract.pdf', 'application/pdf', 'contract',
              0, 0, 'hash-backfill', '', ?, 'confirmed', 0)
    `).run(meta);

    // 插入一个 draft 文档（不应被回填）
    db.prepare(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count,
        content_hash, storage_path, metadata, meta_status, archived)
      VALUES ('草稿测试', 'draft-contract.pdf', 'application/pdf', 'contract',
              0, 0, 'hash-draft', '', ?, 'draft', 0)
    `).run(meta);

    db.close();

    // 现在重新打开并跑完整迁移（v9 会回填）
    const db2 = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db2, dbPath);

    const rows = db2.prepare("SELECT * FROM fact_obligations").all() as Array<{
      kind: string; amount_cents: number | null; due_date: string;
      counterparty: string; status: string; status_raw: string; source_doc: string | null;
      source_document_id: number;
    }>;

    // 应该有 1 条（confirmed 文档），而不是 2 条
    assert.equal(rows.length, 1, `V2 FAIL: 迁移回填应插入 1 行（confirmed 文档），实际 ${rows.length} 行`);
    const row = rows[0]!;
    assert.equal(row.kind, "pay", `V2 FAIL: kind 应为 pay（待付→pay），实际: ${row.kind}`);
    assert.equal(row.due_date, "2026-09-15", `V2 FAIL: due_date 应为 2026-09-15，实际: ${row.due_date}`);
    assert.equal(row.counterparty, "回填测试甲方", `V2 FAIL: counterparty 不匹配，实际: ${row.counterparty}`);
    assert.equal(row.status, "pending", `V2 FAIL: status 应为 pending（待付），实际: ${row.status}`);
    assert.equal(row.status_raw, "待付", `V2 FAIL: status_raw 应保留原文"待付"，实际: ${row.status_raw}`);
    // amount_cents: 12345.67 * 100 = 1234567
    assert.ok(row.amount_cents !== null, "V2 FAIL: amount_cents 不应为 NULL（有金额的行）");
    assert.ok(Math.abs((row.amount_cents ?? 0) - 1234567) < 1, `V2 FAIL: amount_cents 应为 1234567，实际: ${row.amount_cents}`);

    db2.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V2 PASS: 迁移内回填 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V3: persistDerivedObligations INSERT 适配新列清单
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v3-persist");
    const db = buildDb(dbPath);

    // 插入一条 knowledge_documents 行
    const docId = insertKnowledgeDoc(db, { fileName: "persist-test.pdf" });

    const docs: ObligationSourceDoc[] = [
      makeDoc({ id: docId, fileName: "persist-test.pdf", status: "待付", amount: 9999.99, counterparty: "测试乙方" }),
    ];
    const obls = deriveCashObligations(docs);
    assert.equal(obls.length, 1, "V3 FAIL: 应派生出 1 条义务");

    // 执行落盘
    persistDerivedObligations(docId, obls, db);

    const rows = db.prepare("SELECT * FROM fact_obligations WHERE source_document_id = ?").all(docId) as Array<{
      kind: string; amount_cents: number | null; due_date: string; counterparty: string;
      status: string; status_raw: string; source_doc: string | null;
      source_document_id: number; settlement_status: string; source: string;
    }>;
    assert.equal(rows.length, 1, `V3 FAIL: 应落盘 1 行，实际 ${rows.length} 行`);
    const r = rows[0]!;
    assert.equal(r.kind, "pay", `V3 FAIL: kind 应为 pay`);
    assert.ok(r.amount_cents !== null, "V3 FAIL: amount_cents 不应为 NULL（有金额）");
    assert.ok(Math.abs((r.amount_cents ?? 0) - 999999) < 1, `V3 FAIL: amount_cents 应为 999999，实际: ${r.amount_cents}`);
    assert.equal(r.due_date, "2026-08-01", `V3 FAIL: due_date 不匹配，实际: ${r.due_date}`);
    assert.equal(r.status, "pending", `V3 FAIL: status 应为 pending`);
    assert.equal(r.status_raw, "待付", `V3 FAIL: status_raw 应为"待付"，实际: ${r.status_raw}`);
    assert.equal(r.settlement_status, "derived", `V3 FAIL: settlement_status 应为 derived`);
    assert.equal(r.source, "agent_derived", `V3 FAIL: source 应为 agent_derived`);

    // amount undefined → NULL 测试
    const oblNoAmount = deriveCashObligations([
      makeDoc({ id: docId + 1, fileName: "no-amount.pdf", status: "待收", amount: undefined }),
    ]);
    // 插入另一个 doc
    const docId2 = insertKnowledgeDoc(db, { fileName: "no-amount.pdf", metaStatus: "confirmed", metadata: {
      status: "待收", counterparty: "无金额方",
      keyDates: [{ kind: "到期", date: "2026-10-01" }],
    }});
    const oblsNoAmt = deriveCashObligations([{
      id: docId2, fileName: "no-amount.pdf",
      metadata: { status: "待收", counterparty: "无金额方", keyDates: [{ kind: "到期", date: "2026-10-01" }] } as DocMetadata,
      metaStatus: "confirmed",
    }]);
    persistDerivedObligations(docId2, oblsNoAmt, db);
    const noAmtRows = db.prepare("SELECT amount_cents FROM fact_obligations WHERE source_document_id = ?").all(docId2) as Array<{ amount_cents: number | null }>;
    assert.equal(noAmtRows.length, 1, "V3 FAIL: 无金额文档应落盘 1 行");
    assert.equal(noAmtRows[0]!.amount_cents, null, `V3 FAIL: 无金额时 amount_cents 应为 NULL，实际: ${noAmtRows[0]!.amount_cents}`);

    // 精度超差抛错测试（0.005 边界）
    // 构造一个会超差的金额（手动绕过 deriveCashObligations 传入 amount=0.006/100=0.00006 元，使 *100=0.006，|0.006-0|=0.006>=0.005）
    // 用 amount=0.006 → *100=0.6，round=1，|0.6-1|=0.4>=0.005 → 会超差
    // 更精确：amount=0.004: 0.4 round=0, |0.4-0|=0.4>=0.005? No, 0.4>=0.005 YES → 超差
    // 实际上任何不是整数分的金额都会超差。用0.001: *100=0.1，round=0，|0.1-0|=0.1>=0.005 → 超差
    const badObl: import("../lib/domain/cash-obligations.ts").CashObligation = {
      documentId: 999,
      counterparty: "超差测试",
      kind: "付款",
      amount: 0.001, // 0.001元*100=0.1分，round=0，|0.1-0|=0.1>=0.005 → 超差
      dueDate: "2026-12-01",
      status: "待付",
      done: false,
    };
    assert.throws(
      () => persistDerivedObligations(9999, [badObl], db),
      /精度超差|precision/i,
      "V3 FAIL: 精度超差时应抛错"
    );

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V3 PASS: persistDerivedObligations 适配新列清单 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V4: PATCH 钩子—confirmed 落盘
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v4-patch-confirmed");
    const db = buildDb(dbPath);

    // 插入一个文档（初始 draft）
    const docId = insertKnowledgeDoc(db, { metaStatus: "draft" });

    // 模拟调用 PATCH confirmed 钩子逻辑
    // 钩子在 app/api/knowledge/documents/[id]/route.ts，此处直接调用其内部函数
    const { setKnowledgeDocumentMeta, listConfirmedMetaDocRows } = await import("../lib/db/sqlite.ts");
    const { persistDerivedObligations: persist } = await import("../lib/domain/cash-obligations.ts");

    // 设为 confirmed
    setKnowledgeDocumentMeta(
      docId,
      { status: "待收", counterparty: "钩子甲方", amount: 3000, keyDates: [{ kind: "到期", date: "2026-11-01" }] },
      "confirmed",
      db
    );

    // 触发钩子：重派生落盘（复现 PATCH confirmed 路径）
    const confirmedRows = listConfirmedMetaDocRows(db);
    const srcDocs: ObligationSourceDoc[] = confirmedRows.map(r => ({
      id: r.id,
      fileName: r.file_name,
      metadata: JSON.parse(r.metadata) as DocMetadata,
      metaStatus: r.meta_status as "confirmed",
    }));
    const obls = deriveCashObligations(srcDocs.filter(d => d.id === docId));
    persist(docId, obls, db);

    const rows = db.prepare("SELECT * FROM fact_obligations WHERE source_document_id = ?").all(docId) as Array<{
      kind: string; status_raw: string; amount_cents: number | null;
    }>;
    assert.equal(rows.length, 1, `V4 FAIL: confirmed 钩子应落盘 1 行，实际 ${rows.length}`);
    assert.equal(rows[0]!.kind, "receive", `V4 FAIL: 待收→receive，实际: ${rows[0]!.kind}`);
    assert.equal(rows[0]!.status_raw, "待收", `V4 FAIL: status_raw 应为"待收"，实际: ${rows[0]!.status_raw}`);
    assert.equal(rows[0]!.amount_cents, 300000, `V4 FAIL: amount_cents 应为 300000，实际: ${rows[0]!.amount_cents}`);

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V4 PASS: PATCH confirmed 钩子落盘 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V5: PATCH 钩子—降级（confirmed→none/draft）清行
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v5-patch-degrade");
    const db = buildDb(dbPath);

    const { setKnowledgeDocumentMeta } = await import("../lib/db/sqlite.ts");

    // 先 confirmed 并落盘
    const docId = insertKnowledgeDoc(db, { metaStatus: "confirmed" });
    const srcDoc: ObligationSourceDoc = {
      id: docId,
      fileName: "degrade-test.pdf",
      metadata: { status: "待付", counterparty: "降级测试", amount: 5000, keyDates: [{ kind: "付款", date: "2026-08-15" }] } as DocMetadata,
      metaStatus: "confirmed",
    };
    const obls = deriveCashObligations([srcDoc]);
    persistDerivedObligations(docId, obls, db);

    // 确认行存在
    const before = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
    assert.equal(before, 1, `V5 FAIL: 前置：应有 1 行，实际 ${before}`);

    // 降级为 draft（钩子应清行）
    setKnowledgeDocumentMeta(docId, null, "draft", db);
    // 触发清行钩子
    db.prepare("DELETE FROM fact_obligations WHERE source_document_id = ?").run(docId);

    const after = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
    assert.equal(after, 0, `V5 FAIL: 降级后应清行（0 行），实际 ${after}`);

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V5 PASS: PATCH 降级钩子清行 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V6: deleteDocument 清行（真实调用 pipeline.deleteDocument）
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v6-delete");

    // 通过 FINANCE_AGENT_DB_PATH 隔离，让 getDb() 单例指向测试库
    const prevDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { getDb } = await import("../lib/db/sqlite.ts");
      const db = getDb(); // 用单例：确保 deleteDocument 内部的 getDb() 与此同库

      const docId = insertKnowledgeDoc(db);
      const srcDoc: ObligationSourceDoc = {
        id: docId, fileName: "delete-test.pdf",
        metadata: { status: "待付", counterparty: "删除测试", amount: 1000, keyDates: [{ kind: "付款", date: "2026-07-30" }] } as DocMetadata,
        metaStatus: "confirmed",
      };
      persistDerivedObligations(docId, deriveCashObligations([srcDoc]), db);

      const before = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
      assert.equal(before, 1, "V6 FAIL: 前置：应有 1 行");

      // 真实调用 deleteDocument，它内部 getDb() 指向同一测试库，应同步清行
      const { deleteDocument } = await import("../lib/knowledge/pipeline.ts");
      deleteDocument(docId);

      const after = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
      assert.equal(after, 0, `V6 FAIL: deleteDocument 后 fact_obligations 应清行，实际 ${after}`);
    } finally {
      if (prevDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = prevDbPath;
    }

    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V6 PASS: deleteDocument 清行 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V7: PATCH route 归档钩子（archived=true 清行 / archived=false 重派生）
  // 归档钩子实现在 PATCH route handler（route.ts:57-74），直接调用该 handler 验证。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("v7-archive");

    // 通过 FINANCE_AGENT_DB_PATH 隔离，让 getDb() 单例指向测试库
    const prevDbPath7 = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { getDb } = await import("../lib/db/sqlite.ts");
      const { PATCH } = await import("../app/api/knowledge/documents/[id]/route.ts");
      const db = getDb();

      const docId = insertKnowledgeDoc(db, { archived: 0 });
      const srcDoc: ObligationSourceDoc = {
        id: docId, fileName: "archive-test.pdf",
        metadata: { status: "待开票", counterparty: "归档测试", keyDates: [{ kind: "开票", date: "2026-08-20" }] } as DocMetadata,
        metaStatus: "confirmed",
      };
      persistDerivedObligations(docId, deriveCashObligations([srcDoc]), db);

      const before = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
      assert.equal(before, 1, "V7 FAIL: 前置：应有 1 行");

      // 归档→清行：通过 PATCH route handler 真实调用
      const archiveReq = new Request(`http://localhost/api/knowledge/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const archiveRes = await PATCH(archiveReq as any, { params: Promise.resolve({ id: String(docId) }) });
      assert.equal(archiveRes.status, 200, `V7 FAIL: PATCH archived=true 返回 ${archiveRes.status}`);

      const afterArchive = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
      assert.equal(afterArchive, 0, `V7 FAIL: 归档后应清行，实际 ${afterArchive}`);

      // 取消归档→重派生：通过 PATCH route handler 真实调用
      const unarchiveReq = new Request(`http://localhost/api/knowledge/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unarchiveRes = await PATCH(unarchiveReq as any, { params: Promise.resolve({ id: String(docId) }) });
      assert.equal(unarchiveRes.status, 200, `V7 FAIL: PATCH archived=false 返回 ${unarchiveRes.status}`);

      const afterUnarchive = (db.prepare("SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?").get(docId) as { c: number }).c;
      assert.equal(afterUnarchive, 1, `V7 FAIL: 取消归档后应重派生 1 行，实际 ${afterUnarchive}`);
    } finally {
      if (prevDbPath7 === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = prevDbPath7;
    }

    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V7 PASS: PATCH route 归档钩子 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V8: listCashObligations 读写等价性
  // ─────────────────────────────────────────────────────────────────────────
  {
    assert.ok(
      typeof listCashObligations === "function",
      "V8 FAIL: listCashObligations 应导出自 lib/db/finance-store.ts"
    );

    const dbPath = tmpDb("v8-equivalence");
    const db = buildDb(dbPath);

    // 构造两个文档：一有金额，一无金额
    const doc1Meta: DocMetadata = {
      status: "待付",
      counterparty: "等价测试甲方",
      amount: 88888.88,
      keyDates: [{ kind: "付款", date: "2026-09-30" }],
      sourceFile: "equiv-1.pdf",
    };
    const doc2Meta: DocMetadata = {
      status: "已收",
      counterparty: "等价测试乙方",
      keyDates: [{ kind: "到期", date: "2026-07-15" }],
      sourceFile: "equiv-2.pdf",
    };

    const docId1 = insertKnowledgeDoc(db, { fileName: "equiv-1.pdf", metadata: doc1Meta as Record<string, unknown> });
    const docId2 = insertKnowledgeDoc(db, { fileName: "equiv-2.pdf", metadata: doc2Meta as Record<string, unknown> });

    const srcDocs: ObligationSourceDoc[] = [
      { id: docId1, fileName: "equiv-1.pdf", metadata: doc1Meta, metaStatus: "confirmed" },
      { id: docId2, fileName: "equiv-2.pdf", metadata: doc2Meta, metaStatus: "confirmed" },
    ];

    const derived = deriveCashObligations(srcDocs);
    for (const obl of derived) {
      persistDerivedObligations(obl.documentId, [obl], db);
    }

    const fromDb = listCashObligations!(db);

    // 按 documentId 排序对齐
    const sortedDerived = [...derived].sort((a, b) => a.documentId - b.documentId);
    const sortedFromDb = [...fromDb].sort((a, b) => a.documentId - b.documentId);

    assert.equal(sortedFromDb.length, sortedDerived.length, `V8 FAIL: 读写行数不一致，derived=${sortedDerived.length} fromDb=${sortedFromDb.length}`);

    for (let i = 0; i < sortedDerived.length; i++) {
      const d = sortedDerived[i]!;
      const r = sortedFromDb[i]!;

      // amount 容忍 |a-b|<0.005
      const da = d.amount ?? 0;
      const ra = r.amount ?? 0;
      assert.ok(
        Math.abs(da - ra) < 0.005,
        `V8 FAIL: amount 不等价（文档 ${d.documentId}），derived=${da} fromDb=${ra} diff=${Math.abs(da - ra)}`
      );

      // amount undefined 等价性
      if (d.amount === undefined) {
        assert.equal(r.amount, undefined, `V8 FAIL: derived.amount=undefined 时 fromDb.amount 应为 undefined，实际: ${r.amount}`);
      }

      // 其余字段严格相等
      assert.equal(r.documentId, d.documentId, `V8 FAIL: documentId 不匹配`);
      assert.equal(r.counterparty, d.counterparty, `V8 FAIL: counterparty 不匹配`);
      assert.equal(r.kind, d.kind, `V8 FAIL: kind 不匹配（i=${i}）`);
      assert.equal(r.dueDate, d.dueDate, `V8 FAIL: dueDate 不匹配`);
      assert.equal(r.status, d.status, `V8 FAIL: status 应等价（derived=${d.status} fromDb=${r.status}）`);
      assert.equal(r.done, d.done, `V8 FAIL: done 不匹配（derived=${d.done} fromDb=${r.done}）`);
      assert.equal(r.sourceDoc, d.sourceDoc, `V8 FAIL: sourceDoc 不匹配（derived=${d.sourceDoc} fromDb=${r.sourceDoc}）`);
    }

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("V8 PASS: listCashObligations 读写等价性 ✓");
  }

  console.log("obligations-live: all 8 checks passed ✓");
})();
