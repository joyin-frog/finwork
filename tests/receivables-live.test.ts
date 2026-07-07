/**
 * WP13a: query_receivables 工具行为测试 + receivables-officer 转正守卫
 *
 * TDD 红测试先行（2026-07-07）：实施前运行会红。
 *
 * 覆盖：
 * RL-1  agingDays 正值（未到期）——固定 asOf 精确断言
 * RL-2  agingDays 负值（逾期）
 * RL-3  金额 NULL 语义：amountCents=null → items 保留、amountUnknownCount +1
 * RL-4  includeSettled=false 过滤已结算；includeSettled=true 包含
 * RL-5  structuredContent 形状：items/totalCount/overdueCount/amountUnknownCount
 * RL-6  receivables-officer 转正守卫：available:true + skills 含 receivables-ledger + tools 含 query_receivables
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFinanceDatabase, initializeFinanceDatabase } from "../lib/db/sqlite.ts";
import { runMigrations, MIGRATIONS } from "../lib/db/migrations.ts";
import { initializeSchema } from "../lib/db/schema.ts";

const pid = process.pid;

function tmpDb(name: string): string {
  const p = path.join(os.tmpdir(), `finance-agent-rlive-${name}-${pid}.db`);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function buildDb(dbPath: string): DatabaseSync {
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);
  return db;
}

/** 直接向 fact_obligations 插入测试行（不依赖 persistDerivedObligations） */
function insertObligation(
  db: DatabaseSync,
  row: {
    source_document_id: number;
    kind: string;
    amount_cents: number | null;
    due_date: string;
    counterparty: string;
    status: "pending" | "settled";
    status_raw: string;
    source_doc?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO fact_obligations
       (source_document_id, kind, amount_cents, due_date, counterparty, status, status_raw, source_doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.source_document_id,
    row.kind,
    row.amount_cents,
    row.due_date,
    row.counterparty,
    row.status,
    row.status_raw,
    row.source_doc ?? null
  );
}

export const receivablesLiveTestPromise = (async () => {
  // 懒导入：实施前缺少时，测试优雅报错而非 TS 编译错误
  const financeStore = await import("../lib/db/finance-store.ts") as Record<string, unknown>;
  const queryReceivablesRaw = financeStore["listReceivablesRaw"] as
    | ((db: DatabaseSync, opts?: { includeSettled?: boolean; asOf?: string }) => unknown[])
    | undefined;

  assert.ok(
    typeof queryReceivablesRaw === "function",
    "RL-IMPORT FAIL: finance-store 应导出 listReceivablesRaw 函数"
  );

  // ─── 构建临时数据库 ──────────────────────────────────────────────────
  const dbPath = tmpDb("main");
  const db = buildDb(dbPath);

  // kind='receive' 义务行
  insertObligation(db, {
    source_document_id: 1,
    kind: "receive",
    amount_cents: 10000, // 100.00 元（分值）
    due_date: "2026-07-20",
    counterparty: "客户A",
    status: "pending",
    status_raw: "待收款",
    source_doc: "合同A.pdf",
  });

  // 逾期行（due_date 在 asOf 之前）
  insertObligation(db, {
    source_document_id: 2,
    kind: "receive",
    amount_cents: 5000,
    due_date: "2026-07-01",
    counterparty: "客户B",
    status: "pending",
    status_raw: "待回款",
    source_doc: null,
  });

  // 金额 NULL 行
  insertObligation(db, {
    source_document_id: 3,
    kind: "receive",
    amount_cents: null,
    due_date: "2026-07-25",
    counterparty: "客户C",
    status: "pending",
    status_raw: "待收",
  });

  // 已结算行
  insertObligation(db, {
    source_document_id: 4,
    kind: "receive",
    amount_cents: 20000,
    due_date: "2026-06-30",
    counterparty: "客户D",
    status: "settled",
    status_raw: "已收款",
  });

  // 非 receive 行（不应出现在应收清单）
  insertObligation(db, {
    source_document_id: 5,
    kind: "pay",
    amount_cents: 3000,
    due_date: "2026-07-15",
    counterparty: "供应商E",
    status: "pending",
    status_raw: "待付款",
  });

  // ─── 固定 asOf：2026-07-10 ─────────────────────────────────────────
  const asOf = "2026-07-10";

  // ─── RL-1: agingDays 正值（未到期） ──────────────────────────────────
  {
    const rows = queryReceivablesRaw!(db, { asOf });
    const rowA = (rows as Array<{ counterparty: string; agingDays: number }>).find((r) => r.counterparty === "客户A");
    assert.ok(rowA, "RL-1 FAIL: 应有客户A行");
    // asOf=2026-07-10, due_date=2026-07-20 → agingDays = 20-10 = 10（正值=未到期）
    assert.equal(rowA.agingDays, 10, `RL-1 FAIL: 客户A agingDays 应为 10，实际 ${rowA.agingDays}`);
    console.log("RL-1: agingDays 正值（未到期）✓");
  }

  // ─── RL-2: agingDays 负值（逾期） ────────────────────────────────────
  {
    const rows = queryReceivablesRaw!(db, { asOf });
    const rowB = (rows as Array<{ counterparty: string; agingDays: number }>).find((r) => r.counterparty === "客户B");
    assert.ok(rowB, "RL-2 FAIL: 应有客户B行");
    // asOf=2026-07-10, due_date=2026-07-01 → agingDays = 1-10 = -9（负值=逾期）
    assert.equal(rowB.agingDays, -9, `RL-2 FAIL: 客户B agingDays 应为 -9，实际 ${rowB.agingDays}`);
    console.log("RL-2: agingDays 负值（逾期）✓");
  }

  // ─── RL-3: 金额 NULL 语义 ─────────────────────────────────────────────
  {
    const rows = queryReceivablesRaw!(db, { asOf }) as Array<{
      counterparty: string;
      amountCents: number | null;
    }>;
    const rowC = rows.find((r) => r.counterparty === "客户C");
    assert.ok(rowC, "RL-3 FAIL: 应有客户C行（NULL 金额不应被过滤）");
    assert.equal(rowC.amountCents, null, "RL-3 FAIL: NULL 金额应保留为 null 不填 0");
    console.log("RL-3: 金额 NULL 语义 ✓");
  }

  // ─── RL-4: includeSettled 过滤 ───────────────────────────────────────
  {
    // includeSettled=false（默认）：不含已结算
    const rowsFalse = queryReceivablesRaw!(db, { asOf, includeSettled: false }) as Array<{ counterparty: string }>;
    const hasSettled = rowsFalse.some((r) => r.counterparty === "客户D");
    assert.ok(!hasSettled, "RL-4 FAIL: includeSettled=false 时不应含客户D（已收款）");

    // includeSettled=true：含已结算
    const rowsTrue = queryReceivablesRaw!(db, { asOf, includeSettled: true }) as Array<{ counterparty: string }>;
    const hasSettledTrue = rowsTrue.some((r) => r.counterparty === "客户D");
    assert.ok(hasSettledTrue, "RL-4 FAIL: includeSettled=true 时应含客户D（已收款）");

    // 非 receive 的 pay 行不应出现
    const hasPay = rowsTrue.some((r) => r.counterparty === "供应商E");
    assert.ok(!hasPay, "RL-4 FAIL: 应收清单不应含 kind=pay 行");
    console.log("RL-4: includeSettled 过滤 ✓");
  }

  // ─── RL-5: structuredContent 形状 ────────────────────────────────────
  {
    // 默认 includeSettled=false，asOf=2026-07-10
    // pending receive 行: 客户A/B/C，共 3 条；客户C amountCents=null
    const rows = queryReceivablesRaw!(db, { asOf, includeSettled: false }) as Array<{
      counterparty: string;
      amountCents: number | null;
      dueDate: string;
      agingDays: number;
      status: "pending" | "settled";
      statusRaw: string;
      sourceDoc: string | null;
    }>;

    // items
    assert.ok(Array.isArray(rows), "RL-5 FAIL: 返回值应为数组（items）");
    assert.equal(rows.length, 3, `RL-5 FAIL: 应有 3 条 pending receive 行，实际 ${rows.length}`);

    // shape of item
    const rowA = rows.find((r) => r.counterparty === "客户A");
    assert.ok(rowA, "RL-5 FAIL: 应有客户A项");
    assert.equal(typeof rowA.dueDate, "string", "RL-5 FAIL: dueDate 应为 string");
    assert.equal(typeof rowA.agingDays, "number", "RL-5 FAIL: agingDays 应为整数 number");
    assert.equal(rowA.status, "pending", "RL-5 FAIL: status 应为 'pending'");
    assert.equal(typeof rowA.statusRaw, "string", "RL-5 FAIL: statusRaw 应为 string");
    assert.equal(rowA.sourceDoc, "合同A.pdf", "RL-5 FAIL: sourceDoc 应为 '合同A.pdf'");

    // amountCents 原始分值
    assert.equal(rowA.amountCents, 10000, "RL-5 FAIL: 客户A amountCents 应为 10000（分值原样，不转元）");

    // amountUnknownCount：客户C amountCents=null
    const amountUnknownCount = rows.filter((r) => r.amountCents === null).length;
    assert.equal(amountUnknownCount, 1, "RL-5 FAIL: amountUnknownCount 应为 1");

    // overdueCount：agingDays < 0 的行
    const overdueCount = rows.filter((r) => r.agingDays < 0).length;
    assert.ok(overdueCount >= 1, `RL-5 FAIL: overdueCount 应 ≥1（客户B逾期），实际 ${overdueCount}`);

    console.log("RL-5: structuredContent 形状 ✓");
  }

  // ─── RL-6: receivables-officer 转正守卫 ──────────────────────────────
  {
    const { ROLE_REGISTRY } = await import("../lib/agent/roles/registry.ts");
    const role = (ROLE_REGISTRY as Array<{ id: string; available: boolean; skills: string[]; tools: string[] }>)
      .find((r) => r.id === "receivables-officer");

    assert.ok(role, "RL-6 FAIL: ROLE_REGISTRY 应含 receivables-officer");
    assert.equal(role.available, true, "RL-6 FAIL: receivables-officer 应已转正（available:true）");
    assert.ok(
      role.skills.includes("receivables-ledger"),
      `RL-6 FAIL: skills 应含 'receivables-ledger'，实际: ${JSON.stringify(role.skills)}`
    );
    assert.ok(
      role.tools.includes("query_receivables"),
      `RL-6 FAIL: tools 应含 'query_receivables'，实际: ${JSON.stringify(role.tools)}`
    );
    console.log("RL-6: receivables-officer 转正守卫 ✓");
  }

  console.log("receivables-live: 全部 RL 断言通过 ✓");
})();
