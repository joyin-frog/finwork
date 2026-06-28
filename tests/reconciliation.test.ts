import assert from "node:assert/strict";
import { reconcileBankStatement } from "../lib/domain/reconciliation.ts";
import { createReconciliationTools } from "../lib/agent/tools/finance/reconciliation.ts";

export const reconciliationTestPromise = (async () => {
  // ── AC2.1: 精确勾对 + 金额合计勾稽 ───────────────────────────────────
  const r1 = reconcileBankStatement(
    [
      { date: "2026-06-01", amount: 100, direction: "in" },
      { date: "2026-06-02", amount: 50, direction: "out" }
    ],
    [
      { date: "2026-06-01", amount: 100, direction: "in" },
      { date: "2026-06-02", amount: 50, direction: "out" }
    ]
  );
  assert.equal(r1.matched.length, 2, "AC2.1 FAIL: 应勾对 2 笔");
  assert.equal(r1.bankOnly.length, 0);
  assert.equal(r1.bookOnly.length, 0);
  assert.equal(r1.summary.balanced, true, "AC2.1 FAIL: 应账银两平");
  assert.equal(r1.summary.matchedTotal, 150, "AC2.1 FAIL: 已匹配合计 150");

  // 方向必须一致:同额反向不匹配
  const rDir = reconcileBankStatement(
    [{ date: "2026-06-01", amount: 100, direction: "in" }],
    [{ date: "2026-06-01", amount: 100, direction: "out" }]
  );
  assert.equal(rDir.matched.length, 0, "AC2.1 FAIL: 方向不同不应匹配");
  assert.equal(rDir.bankOnly.length, 1);
  assert.equal(rDir.bookOnly.length, 1);

  // ── AC2.2: 日期容差窗口 ───────────────────────────────────────────────
  const bank = [{ date: "2026-06-01", amount: 200, direction: "in" as const }];
  const book = [{ date: "2026-06-03", amount: 200, direction: "in" as const }];
  assert.equal(reconcileBankStatement(bank, book, { dateWindowDays: 0 }).matched.length, 0, "AC2.2 FAIL: 窗口0 不应跨日匹配");
  const win = reconcileBankStatement(bank, book, { dateWindowDays: 3 });
  assert.equal(win.matched.length, 1, "AC2.2 FAIL: 窗口3 内应匹配");
  assert.equal(win.matched[0].dateDiffDays, 2, "AC2.2 FAIL: 日期差应为 2 天");

  // ── AC2.3: 一对多疑似拆分/合并,不静默合并 ─────────────────────────────
  const split = reconcileBankStatement(
    [{ date: "2026-06-10", amount: 3000, direction: "out" }],
    [
      { date: "2026-06-10", amount: 1000, direction: "out" },
      { date: "2026-06-10", amount: 2000, direction: "out" }
    ]
  );
  assert.equal(split.matched.length, 0, "AC2.3 FAIL: 拆分场景绝不自动匹配");
  assert.equal(split.needsReview.length, 1, "AC2.3 FAIL: 应标 1 组疑似拆分/合并");
  assert.equal(split.needsReview[0].side, "bank");
  assert.equal(split.needsReview[0].many.length, 2);
  assert.equal(split.bankOnly.length, 0, "AC2.3 FAIL: 被纳入 review 的行不应再列入未达(避免重复计数)");
  assert.equal(split.bookOnly.length, 0);

  // 金额凑不上 → 不误标拆分,如实列为未达
  const noSum = reconcileBankStatement(
    [{ date: "2026-06-10", amount: 3000, direction: "out" }],
    [
      { date: "2026-06-10", amount: 1000, direction: "out" },
      { date: "2026-06-10", amount: 1500, direction: "out" }
    ]
  );
  assert.equal(noSum.needsReview.length, 0, "AC2.3 FAIL: 金额凑不上不应误标拆分");
  assert.equal(noSum.bankOnly.length, 1);
  assert.equal(noSum.bookOnly.length, 2);

  // ── AC2.5: 未匹配按金额倒序(风险排序)+ 原始下标可追溯 ────────────────
  const sortRes = reconcileBankStatement(
    [
      { date: "2026-06-01", amount: 50, direction: "out" },
      { date: "2026-06-02", amount: 9000, direction: "out" },
      { date: "2026-06-03", amount: 300, direction: "out" }
    ],
    []
  );
  assert.deepEqual(sortRes.bankOnly.map((r) => r.amount), [9000, 300, 50], "AC2.5 FAIL: 应按金额倒序");
  assert.equal(sortRes.bankOnly[0].index, 1, "AC2.5 FAIL: 应保留原始下标用于溯源");

  // ── AC2.4: handler 直接调用,正常 + 异常 ───────────────────────────────
  const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean; structuredContent?: unknown }>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = { tool: (name: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => { handlers.set(name, h as never); return { name }; } };
  createReconciliationTools(mockSdk);
  const handler = handlers.get("reconcile_bank_statement");
  assert.ok(handler, "AC2.4 FAIL: reconcile_bank_statement 未注册");

  const ok = await handler!({
    bankRows: [{ date: "2026-06-01", amount: 100, direction: "in" }],
    bookRows: [{ date: "2026-06-01", amount: 100, direction: "in" }]
  });
  assert.ok(!ok.isError, "AC2.4 FAIL: 正常输入不应 isError");
  assert.ok(ok.structuredContent, "AC2.4 FAIL: 应返回结构化结果");
  assert.ok(ok.content[0].text.includes("不涉及任何付款"), "AC2.4 FAIL: 输出应声明只核对不碰付款");

  const empty = await handler!({ bankRows: [], bookRows: [] });
  assert.equal(empty.isError, true, "AC2.4 FAIL: 两表皆空应 isError");

  const badAmount = await handler!({
    bankRows: [{ date: "2026-06-01", amount: Number.NaN, direction: "in" }],
    bookRows: []
  });
  assert.equal(badAmount.isError, true, "AC2.4 FAIL: 非法金额应 isError 且不抛");

  const badDir = await handler!({
    bankRows: [{ date: "2026-06-01", amount: 100, direction: "sideways" as unknown as "in" }],
    bookRows: []
  });
  assert.equal(badDir.isError, true, "AC2.4 FAIL: 非法方向应 isError 且不抛");

  // ── 严格日期格式:非 YYYY-MM-DD 应抛出含"应为 YYYY-MM-DD"的错误 ──────────
  assert.throws(
    () => reconcileBankStatement(
      [{ date: "2026/06/01", amount: 100, direction: "in" }],
      [{ date: "2026-06-01", amount: 100, direction: "in" }]
    ),
    /应为 YYYY-MM-DD/,
    "strict-date FAIL: 非 YYYY-MM-DD 格式应抛错"
  );

  console.log("reconciliation: all 7 checks passed ✓");
})();
