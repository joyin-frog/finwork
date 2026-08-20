import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const memoryCandidateToolsTestPromise = (async () => {
  const root = mkdtempSync(path.join(tmpdir(), "finwork-memory-candidate-tools-"));
  const savedDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "finance-agent.db");

  try {
    const captured: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
    const sdk = {
      tool: (name: string, _description: unknown, _schema: unknown, handler: unknown) => {
        captured[name] = handler as typeof captured[string];
        return { name };
      },
    };
    const { createRememberConventionTool } = await import("../lib/agent/mcp-tools/conventions.ts");
    createRememberConventionTool(sdk as never);
    const handler = captured.remember_convention;
    assert.ok(handler, "MC-1 FAIL: remember_convention handler missing");

    const created = await handler({ text: "所有报表都要按部门拆分", conversationId: 42 });
    assert.equal(created.isError, undefined, "MC-1 FAIL: valid candidate should not error");
    const structured = created.structuredContent as {
      candidateId: string;
      candidateStatus: string;
      duplicate: boolean;
      deletions: unknown[];
    };
    assert.equal(structured.candidateStatus, "candidate", "MC-1 FAIL: tool may only create candidate");
    assert.equal(structured.duplicate, false);
    assert.match((created.content as Array<{ text: string }>)[0].text, /审核通过前不会进入/);

    const { getDb } = await import("../lib/db/sqlite.ts");
    const { GovernedMemoryStore } = await import("../lib/memory-v2/index.ts");
    const store = new GovernedMemoryStore(getDb());
    assert.equal(store.get(structured.candidateId)?.approvalStatus, "candidate");
    assert.deepEqual(store.retrieve({
      principal: { id: "local-user", type: "user", tenantId: "local" },
      tenantId: "local",
      entityRefs: [],
      kinds: [],
      queryText: "按部门拆分报表",
      maximumSensitivity: "confidential",
      minimumConfidence: 0,
      limit: 20,
      now: new Date().toISOString(),
    }), [], "MC-1 FAIL: unapproved tool candidate must not be retrieved");
    const duplicate = await handler({ text: "所有报表都要按部门拆分", conversationId: 42 });
    const duplicateStructured = duplicate.structuredContent as typeof structured;
    assert.equal(duplicateStructured.duplicate, true, "MC-2 FAIL: repeated request should be idempotent");
    assert.equal(duplicateStructured.candidateId, structured.candidateId);
    assert.equal(store.findExactSummary({
      summary: "所有报表都要按部门拆分",
      tenantId: "local",
      principalId: "local-user",
    }).length, 1, "MC-2 FAIL: repeated request must not create another row");

    const deleted = await handler({ replaces: "所有报表都要按部门拆分", conversationId: 42 });
    const deletedStructured = deleted.structuredContent as typeof structured;
    assert.equal(deletedStructured.deletions.length, 1, "MC-3 FAIL: confirmed deletion needs proof");
    assert.equal(store.get(structured.candidateId), undefined, "MC-3 FAIL: deleted candidate still exists");
    assert.match(JSON.stringify(deletedStructured.deletions), /[a-f0-9]{64}/,
      "MC-3 FAIL: deletion proof missing");
    console.log("memory candidate tools: candidate-only, idempotency and deletion proof passed ✓");
  } finally {
    if (savedDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = savedDb;
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("memory-candidate-tools.test")) {
  memoryCandidateToolsTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
