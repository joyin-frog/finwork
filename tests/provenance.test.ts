import assert from "node:assert/strict";
import { buildReimbursementProvenance } from "../app/chat/provenance.ts";
import type { AgentEvent } from "../app/chat/chat-types.ts";

function tl(events: AgentEvent[]) {
  return events.map((event, i) => ({ id: String(i), event, createdAt: i }));
}

export const provenanceTestPromise = (async () => {
  // ── P1: 无报销动作 → null(把样板限定在报销流程) ──
  assert.equal(
    buildReimbursementProvenance(tl([
      { type: "tool_use", name: "mcp__finance_worker__tax_calculator", input: { type: "vat", amount: 100 } },
      { type: "text", content: "增值税是…" },
    ])),
    null,
    "P1 FAIL: 无报销工具应返回 null"
  );

  // ── P2: 读了示例制度 → isExample=true,并带警示口径 ──
  const p2 = buildReimbursementProvenance(tl([
    { type: "tool_use", name: "mcp__finance_worker__read_expense_policy", input: { section: "全部" } },
    { type: "tool_result", name: "mcp__finance_worker__read_expense_policy", content: "⚠ 当前使用的是「示例报销制度」,结论可能与贵司实际标准不符。\n\n正文…" },
  ]));
  assert.ok(p2, "P2 FAIL: 读了制度应返回非空");
  assert.equal(p2!.policyBasis?.isExample, true, "P2 FAIL: 示例制度应判为 isExample");
  assert.ok(p2!.policyBasis?.text.includes("示例制度"), "P2 FAIL: 口径文案应点明示例制度");

  // ── P3: 真制度 + 核对笔数 + 知识库来源,机械汇总 + 去重 ──
  const p3 = buildReimbursementProvenance(tl([
    { type: "tool_use", name: "mcp__finance_worker__read_expense_policy", input: { section: "差旅" } },
    { type: "tool_result", name: "mcp__finance_worker__read_expense_policy", content: "第一章 差旅\n标准…(贵司真实制度,无示例标记)" },
    { type: "tool_use", name: "mcp__finance_worker__read_file", input: { fileName: "差旅报销明细.xlsx" } },
    { type: "tool_use", name: "mcp__finance_worker__read_file", input: { fileName: "差旅报销明细.xlsx" } },
    { type: "tool_use", name: "mcp__finance_worker__check_reimbursement_batch", input: { items: [1, 2, 3] } },
  ]));
  assert.ok(p3, "P3 FAIL: 应返回非空");
  assert.equal(p3!.policyBasis?.isExample, false, "P3 FAIL: 无示例标记应判为真制度");
  assert.deepEqual(p3!.sources, ["知识库文件《差旅报销明细.xlsx》"], "P3 FAIL: 来源应去重");
  assert.deepEqual(p3!.counts, ["核对报销单 3 条"], "P3 FAIL: 笔数应来自 input.items 长度");

  // ── P4: 登记发票笔数 ──
  const p4 = buildReimbursementProvenance(tl([
    { type: "tool_use", name: "record_reimbursement_invoices", input: { items: [1, 2] } },
  ]));
  assert.deepEqual(p4!.counts, ["登记发票 2 张进台账"], "P4 FAIL: 登记发票笔数(裸工具名亦可识别)");

  console.log("provenance: all 4 checks passed ✓");
})();
