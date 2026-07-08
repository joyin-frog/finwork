/**
 * WP-B: 确认合同链路修复测试
 *
 * 核心复现：只发 metaStatus 的 PATCH 不应覆盖 metadata，且义务落盘必须正确触发。
 * 修复前 B1 失败（metadata 被覆盖为 NULL，义务行为零）。
 *
 * 运行:
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/confirm-contract-chain.test.ts
 */

import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const pid = process.pid;
function tmpDb(name: string): string {
  return path.join(os.tmpdir(), `finance-agent-wpb-${name}-${pid}.db`);
}

export const confirmContractChainTestPromise = (async () => {

  // ─────────────────────────────────────────────────────────────────────────
  // B1: 只发 metaStatus 的 PATCH 不覆盖 metadata，义务落盘正确触发（核心复现）
  // 修复前此测试失败：route 把 metadata 写为 NULL，义务行计数为 0。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("b1");
    const prevDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { getDb } = await import("../lib/db/sqlite.ts");
      const db = getDb(); // 触发初始化+迁移

      // 插入一条空白文档
      const r = db.prepare(`
        INSERT INTO knowledge_documents
          (title, file_name, mime_type, category, size_bytes, chunk_count,
           content_hash, storage_path, metadata, meta_status, archived)
        VALUES ('合同甲', 'contract-a.pdf', 'application/pdf', 'contract', 0, 0, '', '', NULL, 'none', 0)
      `).run();
      const docId = Number(r.lastInsertRowid);

      const { PATCH } = await import("../app/api/knowledge/documents/[id]/route.ts");

      // 第一次 PATCH: 带完整 metadata + metaStatus=draft
      const req1 = new Request(`http://localhost/api/knowledge/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: {
            status: "待付",
            counterparty: "测试甲方",
            amount: 50000,
            keyDates: [{ kind: "付款", date: "2026-09-30" }],
          },
          metaStatus: "draft",
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res1 = await PATCH(req1 as any, { params: Promise.resolve({ id: String(docId) }) });
      assert.equal(res1.status, 200, "B1 FAIL: 第一次 PATCH(带 metadata+draft)应 200");

      // 确认 metadata 已写入
      const row1 = db.prepare(
        "SELECT metadata, meta_status FROM knowledge_documents WHERE id = ?"
      ).get(docId) as { metadata: string | null; meta_status: string };
      assert.ok(row1.metadata !== null, "B1 FAIL: 第一次 PATCH 后 metadata 应已写入，不应为 NULL");
      assert.equal(row1.meta_status, "draft", "B1 FAIL: 第一次 PATCH 后 meta_status 应为 draft");

      // draft 不落义务
      const cnt0 = (db.prepare(
        "SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?"
      ).get(docId) as { c: number }).c;
      assert.equal(cnt0, 0, "B1 FAIL: draft 状态不应有 fact_obligations 行");

      // 第二次 PATCH: 只带 metaStatus=confirmed，不带 metadata（复现缺陷）
      const req2 = new Request(`http://localhost/api/knowledge/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metaStatus: "confirmed" }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res2 = await PATCH(req2 as any, { params: Promise.resolve({ id: String(docId) }) });
      assert.equal(res2.status, 200, "B1 FAIL: 第二次 PATCH(只带 metaStatus:confirmed)应 200");

      // 核心断言：metadata 未被覆盖为 NULL
      const row2 = db.prepare(
        "SELECT metadata FROM knowledge_documents WHERE id = ?"
      ).get(docId) as { metadata: string | null };
      assert.ok(
        row2.metadata !== null,
        "B1 FAIL: 只发 metaStatus 的 PATCH 不应将 metadata 覆盖为 NULL（修复前此处失败）"
      );

      // 核心断言：义务已落盘
      const cntAfter = (db.prepare(
        "SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?"
      ).get(docId) as { c: number }).c;
      assert.equal(
        cntAfter,
        1,
        `B1 FAIL: 只发 metaStatus:"confirmed" 后应有 1 条 fact_obligations 行，实际 ${cntAfter}（修复前此处失败）`
      );

    } finally {
      if (prevDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = prevDbPath;
    }
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("B1 PASS: 只发 metaStatus 的 PATCH 正确触发义务落盘，metadata 未被覆盖 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // B2: 非法 metaStatus 返回 400，且已有义务不被删除
  // 修复前：非法值静默降级为 draft，义务被删除。
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("b2");
    const prevDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { getDb } = await import("../lib/db/sqlite.ts");
      const db = getDb();

      // 插入一个已 confirmed 文档
      const r = db.prepare(`
        INSERT INTO knowledge_documents
          (title, file_name, mime_type, category, size_bytes, chunk_count,
           content_hash, storage_path, metadata, meta_status, archived)
        VALUES ('合同乙', 'contract-b.pdf', 'application/pdf', 'contract', 0, 0, '', '',
          '{"status":"待收","counterparty":"乙方","amount":30000,"keyDates":[{"kind":"到期","date":"2026-10-01"}]}',
          'confirmed', 0)
      `).run();
      const docId = Number(r.lastInsertRowid);

      // 手动落盘义务
      const { deriveCashObligations, persistDerivedObligations } = await import("../lib/domain/cash-obligations.ts");
      const obls = deriveCashObligations([{
        id: docId,
        fileName: "contract-b.pdf",
        metadata: {
          status: "待收", counterparty: "乙方", amount: 30000,
          keyDates: [{ kind: "到期", date: "2026-10-01" }],
        },
        metaStatus: "confirmed",
      }]);
      persistDerivedObligations(docId, obls, db);

      const before = (db.prepare(
        "SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?"
      ).get(docId) as { c: number }).c;
      assert.equal(before, 1, "B2 FAIL: 前置：应有 1 条义务");

      const { PATCH } = await import("../app/api/knowledge/documents/[id]/route.ts");

      // 发非法 metaStatus
      const req = new Request(`http://localhost/api/knowledge/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metaStatus: "unknown-value" }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await PATCH(req as any, { params: Promise.resolve({ id: String(docId) }) });
      assert.equal(res.status, 400, "B2 FAIL: 非法 metaStatus 应返回 400（修复前静默降级 draft，此处失败）");

      // 义务未被删
      const after = (db.prepare(
        "SELECT COUNT(*) AS c FROM fact_obligations WHERE source_document_id = ?"
      ).get(docId) as { c: number }).c;
      assert.equal(
        after,
        1,
        `B2 FAIL: 非法 metaStatus 请求不应删义务，实际剩余 ${after} 行`
      );

    } finally {
      if (prevDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = prevDbPath;
    }
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("B2 PASS: 非法 metaStatus 返回 400 且义务未被删除 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // B3: NaN id 守卫——PATCH/DELETE 非数字 id → 400
  // ─────────────────────────────────────────────────────────────────────────
  {
    const dbPath = tmpDb("b3");
    const prevDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { getDb } = await import("../lib/db/sqlite.ts");
      getDb(); // 触发初始化

      const { PATCH, DELETE } = await import("../app/api/knowledge/documents/[id]/route.ts");

      // PATCH 非数字 id
      const patchReq = new Request("http://localhost/api/knowledge/documents/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metaStatus: "confirmed" }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patchRes = await PATCH(patchReq as any, { params: Promise.resolve({ id: "abc" }) });
      assert.equal(patchRes.status, 400, "B3 FAIL: PATCH 非数字 id 应返回 400");

      // DELETE 非数字 id
      const deleteReq = new Request("http://localhost/api/knowledge/documents/xyz", {
        method: "DELETE",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deleteRes = await DELETE(deleteReq as any, { params: Promise.resolve({ id: "xyz" }) });
      assert.equal(deleteRes.status, 400, "B3 FAIL: DELETE 非数字 id 应返回 400");

    } finally {
      if (prevDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = prevDbPath;
    }
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("B3 PASS: NaN id 守卫（PATCH/DELETE）✓");
  }

  console.log("confirm-contract-chain: 全部断言通过 ✓");
})();
