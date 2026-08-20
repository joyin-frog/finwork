import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { prepareAgentRun } from "@/lib/agent/agent-run-service";
import { runMigrations } from "@/lib/db/migrations";
import type { DeliverySpec } from "@/lib/agent/run-contract";
import { createAgentRunContext, createAgentTaskSpec } from "@/lib/agent/task-spec";

const textContract: DeliverySpec = {
  version: 1,
  taskKind: "text",
  requiredDeliverables: [],
  expectationSnapshot: {},
};

export const agentTaskSpecTestPromise = (async () => {
  assert.equal(createAgentTaskSpec({ contract: textContract, intent: "rag_qa" }).mode, "chat");
  assert.equal(createAgentTaskSpec({ contract: textContract, intent: "tool_task" }).mode, "action");
  assert.equal(createAgentTaskSpec({
    contract: { ...textContract, requiredDeliverables: [{ id: "report", mime: "application/pdf", count: 1, qualityProfile: "generic" }] },
    intent: "complex_workflow",
  }).mode, "deliverable");
  const context = createAgentRunContext({ runId: "r1", goal: "answer" });
  assert.equal(context.runId, "r1");
  assert.equal(context.security.allowExternalEgress, false);

  const db = new DatabaseSync(":memory:");
  runMigrations(db, ":memory:", () => null);
  try {
    const chat = prepareAgentRun({ db, traceId: "chat", goal: "解释一下", attachments: [], deliverySpec: textContract, intent: "rag_qa" });
    assert.equal(chat.task.mode, "chat");
    assert.equal(chat.delivery, undefined);
    const action = prepareAgentRun({ db, traceId: "action", goal: "查询数据", attachments: [], deliverySpec: textContract, intent: "tool_task" });
    assert.equal(action.task.mode, "action");
    assert.equal(action.delivery, undefined);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM cases").get() as { n: number }).n), 0);

    const deliverableContract: DeliverySpec = {
      ...textContract,
      taskKind: "spreadsheet",
      spreadsheetRequirement: {
        needsLegacyXlsRead: false,
        needsWrite: true,
        needsRecalc: true,
        needsRender: false,
        needsMacroPreservation: false,
      },
      requiredDeliverables: [{ id: "workbook", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", count: 1, qualityProfile: "generic" }],
    };
    const deliverable = prepareAgentRun({ db, traceId: "delivery", goal: "生成工作簿", attachments: [], deliverySpec: deliverableContract, intent: "complex_workflow" });
    assert.equal(deliverable.task.mode, "deliverable");
    assert.ok(deliverable.delivery);
    assert.ok(deliverable.plan);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM cases").get() as { n: number }).n), 1);
  } finally {
    db.close();
  }
})();

if (process.argv[1]?.includes("agent-task-spec.test")) {
  agentTaskSpecTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
