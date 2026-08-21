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
  assert.equal(productionDefinitions.length, 47, "收口后的生产领域工具目录应保持 47 个明确能力");
  for (const removed of [
    "query_knowledge", "read_file", "begin_workspace_change", "review_workspace_change",
    "check_workbook_ties", "detect_data_issues", "merge_labeled_tables",
    "check_voucher_amount", "map_voucher_account", "summarize_vouchers",
    "build_voucher_lines", "build_voucher_sheet",
  ]) {
    assert.ok(!productionDefinitions.some((definition) => definition.id === removed), `${removed} 不得重新暴露给模型`);
  }
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
        runContext: {
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

    let deniedNetworkCalls = 0;
    const deniedNetworkDefinition: FinanceToolDefinition = {
      id: "research_web",
      name: "Research web",
      namespace: "finance_worker",
      description: "Network capability that is denied by the task contract",
      schema: { query: z.string() },
      riskLevel: "medium",
      handler: async () => {
        deniedNetworkCalls += 1;
        return { content: [{ type: "text", text: "must not execute" }] };
      },
    };
    const deniedNetworkRuntime = createFinanceCapabilityRuntime(
      [deniedNetworkDefinition],
      {
        ...runtime.context,
        runId: "runtime-network-denied",
        caseId: "case-runtime-network-denied",
        runContext: {
          ...runtime.context.runContext!,
          runId: "runtime-network-denied",
          caseId: "case-runtime-network-denied",
          security: {
            ...runtime.context.runContext!.security,
            allowExternalEgress: false,
            allowedDomains: [],
          },
        },
      },
      { db },
    );
    const networkGrant = db.prepare(`
      SELECT actions_json FROM security_acl_grants
      WHERE case_id='case-runtime-network-denied'
        AND capability_id='finance-tool.research_web'
    `).get() as { actions_json: string };
    assert.ok(!JSON.parse(networkGrant.actions_json).includes("network"), "denied egress must never be pre-granted");
    assert.equal(
      Number((db.prepare(`
        SELECT COUNT(*) AS n FROM security_egress_grants
        WHERE case_id='case-runtime-network-denied'
      `).get() as { n: number }).n),
      0,
      "denied egress must not create destination grants",
    );
    await assert.rejects(
      () => deniedNetworkRuntime.execute(deniedNetworkDefinition, { query: "test" }),
      /denied|grant|permission|network/i,
      "the denied network tool must fail closed only if it is actually selected",
    );
    assert.equal(deniedNetworkCalls, 0, "denied network handler must not execute");
    const manifest = runtime.registry.resolve("finance-tool.analyze_tabular", "1");
    assert.equal(manifest?.validators.length, 1);
    assert.equal(manifest?.validators[0]?.blocking, true);
    assert.ok(manifest?.validatorHandlers?.[manifest.validators[0]!.id]);

    const first = await runtime.execute(definition, { value: 1 });
    assert.equal(calls, 1, "Tool executor must invoke the shared handler exactly once");
    assert.deepEqual(first, { content: [{ type: "text", text: "1" }] });
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

    const second = await runtime.execute(definition, { value: 2 });
    assert.deepEqual(second, { content: [{ type: "text", text: "2" }] });
    assert.equal(calls, 2);
    assert.equal(count(db, "capability_attempts"), 2);

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
  console.log("finance-capability-runtime: policy coverage, denied egress, single executor, resources, adapter order passed ✓");
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
