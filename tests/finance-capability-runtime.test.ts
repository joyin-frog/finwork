import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod/v4";
import { runMigrations } from "@/lib/db/migrations";
import {
  assertFinanceCapabilityPolicyCatalog,
  assertFinanceCapabilityPolicyCoverage,
  resolveFinanceCapabilityPolicy,
} from "@/lib/agent/tools/capability-policy";
import {
  createFinanceCapabilityRuntime,
  synchronizeFinanceCapabilityCatalog,
  type FinanceToolRuntime,
} from "@/lib/agent/tools/capability-runtime";
import type { FinanceToolDefinition } from "@/lib/agent/tools/finance-definition";
import { buildFinanceToolDefinitions } from "@/lib/agent/mcp-tools";
import { createPiFinanceTools } from "@/lib/agent/pi/tool-adapter";

export const financeCapabilityRuntimeTestPromise = (async () => {
  assertFinanceCapabilityPolicyCoverage();
  const productionDefinitions = buildFinanceToolDefinitions("/tmp/finwork-policy-catalog");
  assertFinanceCapabilityPolicyCatalog(productionDefinitions.map((definition) => definition.id));
  assert.throws(
    () => resolveFinanceCapabilityPolicy("unregistered_finance_tool"),
    /no explicit Capability policy/,
  );

  const db = new DatabaseSync(":memory:");
  runMigrations(db, ":memory:", () => null);
  try {
    const catalog = synchronizeFinanceCapabilityCatalog(productionDefinitions, { db });
    assert.equal(catalog.available, productionDefinitions.length);
    assert.equal(catalog.deprecated.length, 0);
    assert.equal(
      Number((db.prepare(`
        SELECT COUNT(*) AS n FROM capability_definitions
        WHERE capability_id LIKE 'finance-tool.%' AND status='available'
      `).get() as { n: number }).n),
      productionDefinitions.length,
      "startup catalog must persist every production definition",
    );

    const retiredCatalog = synchronizeFinanceCapabilityCatalog(productionDefinitions.slice(1), { db });
    assert.deepEqual(retiredCatalog.deprecated, [`finance-tool.${productionDefinitions[0]!.id}`]);
    assert.equal(
      (db.prepare(`
        SELECT status FROM capability_definitions WHERE capability_id=? AND version='1'
      `).get(`finance-tool.${productionDefinitions[0]!.id}`) as { status: string }).status,
      "deprecated",
      "removed production definitions must remain as deprecated audit records",
    );
    synchronizeFinanceCapabilityCatalog(productionDefinitions, { db });

    let calls = 0;
    const definition: FinanceToolDefinition = {
      id: "analyze_tabular",
      name: "Analyze tabular",
      namespace: "finance_worker",
      description: "Test neutral finance tool",
      schema: { value: z.number() },
      riskLevel: "safe",
      handler: async (args) => {
        calls += 1;
        return { content: [{ type: "text", text: String(args.value) }] };
      },
    };
    const runtime = createFinanceCapabilityRuntime(
      [definition],
      {
        runId: "runtime-test",
        caseId: "case-runtime-test",
        foundation: {
          taskId: "task-runtime-test",
          caseId: "case-runtime-test",
          runId: "runtime-test",
          tenantId: "tenant-runtime-test",
          principal: { type: "user", id: "user-runtime-test", tenantId: "tenant-runtime-test" },
          security: {
            classification: "internal",
            allowedPrincipals: [{ type: "user", id: "user-runtime-test", tenantId: "tenant-runtime-test" }],
            allowExternalEgress: false,
            allowedDomains: [],
            requireEncryptionAtRest: true,
            requireHumanApprovalForExport: false,
          },
          budget: {
            tokenLimit: 10_000,
            wallTimeMs: 60_000,
            cpuTimeMs: 30_000,
            memoryBytes: 64 * 1024 * 1024,
            diskBytes: 64 * 1024 * 1024,
            networkBytes: 1,
            toolOutputBytes: 4 * 1024 * 1024,
            concurrency: 1,
            retryLimit: 0,
          },
        },
      },
      { db },
    );
    const manifest = runtime.registry.resolve("finance-tool.analyze_tabular", "1");
    assert.equal(manifest?.validators.length, 1);
    assert.equal(manifest?.validators[0]?.blocking, true);
    assert.ok(manifest?.validatorHandlers?.[manifest.validators[0]!.id]);

    const shadow = await runtime.execute(definition, { value: 1 });
    assert.equal(calls, 1, "shadow mode must execute the legacy handler once");
    assert.deepEqual(shadow, { content: [{ type: "text", text: "1" }] });
    assert.equal(count(db, "capability_attempts"), 0, "legacy authority must not forge new attempts");
    assert.equal(count(db, "capability_shadow_comparisons"), 1);
    assert.equal(
      (db.prepare("SELECT outcome FROM capability_shadow_comparisons").get() as { outcome: string }).outcome,
      "inconclusive",
    );

    runtime.rollout.cutover("runtime unit gate passed");
    const cutover = await runtime.execute(definition, { value: 2 });
    assert.equal(calls, 2, "cutover must invoke the shared handler exactly once");
    assert.deepEqual(cutover, { content: [{ type: "text", text: "2" }] });
    assert.equal(count(db, "capability_attempts"), 1);
    assert.equal(
      (db.prepare("SELECT status FROM capability_attempts").get() as { status: string }).status,
      "succeeded",
    );
    assert.equal(count(db, "resource_reservations"), 1);
    assert.equal(
      (db.prepare("SELECT status FROM resource_reservations").get() as { status: string }).status,
      "released",
    );

    runtime.rollout.rollback("runtime rollback rehearsal");
    await runtime.execute(definition, { value: 3 });
    assert.equal(calls, 3, "rollback must return to one legacy execution");
    assert.equal(count(db, "capability_attempts"), 1);

    const sequence: string[] = [];
    const adapterRuntime: FinanceToolRuntime = {
      async execute(_definition, args) {
        sequence.push("runtime");
        return { content: [{ type: "text", text: String(args.value) }] };
      },
    };
    const tools = createPiFinanceTools(
      [definition],
      Object.assign(
        async () => { sequence.push("authorize"); },
        { after: async () => { sequence.push("after"); } },
      ),
      adapterRuntime,
    );
    await tools[0]!.execute("call-1", { value: 4 }, new AbortController().signal, undefined as never);
    assert.deepEqual(sequence, ["authorize", "runtime", "after"]);
  } finally {
    db.close();
  }
  console.log("finance-capability-runtime: policy coverage, single authority, resources, adapter order passed ✓");
})();

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

if (process.argv[1]?.includes("finance-capability-runtime.test")) {
  financeCapabilityRuntimeTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
