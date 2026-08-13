import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  CapabilityExecutionError,
  CapabilityExecutor,
  CapabilityRegistry,
} from "../lib/capability/index.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

const inputSchema = z.object({ value: z.number(), requestKey: z.string().optional() }).strict();
const outputSchema = z.object({ doubled: z.number() }).strict();

function definition(id: string, handler: (input: z.infer<typeof inputSchema>) => Promise<{ doubled: number }>) {
  return {
    id,
    version: "1.0.0",
    title: id,
    inputSchemaId: `schema.${id}.input.v1`,
    outputSchemaId: `schema.${id}.output.v1`,
    preconditions: [],
    sideEffects: [{ kind: "read" as const, target: "fixture", reversible: true }],
    requiredPermissions: [],
    evidenceProduced: [{ type: "transform" as const, requiresLocator: false }],
    resourceEstimate: {
      expectedWallTimeMs: 10,
      expectedMemoryBytes: 1024,
      expectedDiskBytes: 0,
      expectedNetworkBytes: 0,
      expectedToolOutputBytes: 1024,
      confidence: 1,
    },
    validators: [],
    failureSemantics: {
      declaredKinds: ["transient_external_failure" as const, "internal_error" as const],
      retryableKinds: ["transient_external_failure" as const],
      maxAttempts: 2,
      backoffMs: 0,
    },
    idempotency: { mode: "input_hash" as const },
    inputSchema,
    outputSchema,
    handler,
  };
}

export const capabilityKernelTestPromise = (async () => {
  const db = makeDb();
  const registry = new CapabilityRegistry(db);

  let calls = 0;
  registry.register(definition("fixture.retry", async ({ value }) => {
    calls += 1;
    if (calls === 1) {
      throw new CapabilityExecutionError({
        kind: "transient_external_failure",
        code: "fixture_transient",
        message: "temporary failure",
        retryable: true,
        details: {},
      });
    }
    return { doubled: value * 2 };
  }), { aliases: ["retry-fixture"] });

  const executor = new CapabilityExecutor(registry);
  const first = await executor.execute({
    capabilityId: "retry-fixture",
    input: { value: 4 },
    runId: "run-1",
  });
  assert.deepEqual(first.ok && first.output, { doubled: 8 });
  assert.equal(calls, 2, "only a declared transient failure may consume the retry budget");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM capability_attempts").get() as { count: number }).count,
    2,
  );

  const reused = await executor.execute({
    capabilityId: "fixture.retry",
    version: "1.0.0",
    input: { value: 4 },
    runId: "run-2",
  });
  assert.equal(reused.ok && reused.reused, true, "input-hash idempotency must reuse a verified success");
  assert.equal(calls, 2);

  registry.register(definition("fixture.unavailable", async ({ value }) => ({ doubled: value * 2 })), {
    status: "unavailable",
    unavailableReason: "fixture dependency is intentionally absent",
  });
  const unavailable = await executor.execute({
    capabilityId: "fixture.unavailable",
    version: "1.0.0",
    input: { value: 1 },
    runId: "run-3",
  });
  assert.equal(unavailable.ok, false);
  assert.equal(!unavailable.ok && unavailable.failure.code, "capability_unavailable");
  assert.match(!unavailable.ok ? unavailable.failure.message : "", /intentionally absent/);

  assert.throws(
    () => registry.register(definition("fixture.bad-unavailable", async ({ value }) => ({ doubled: value * 2 })), {
      status: "unavailable",
    }),
    /requires a reason/,
  );
  assert.throws(
    () => registry.register(definition("fixture.alias-collision", async ({ value }) => ({ doubled: value * 2 })), {
      aliases: ["retry-fixture"],
    }),
    /alias collision/,
  );

  const constraint = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='capability_definitions'
  `).get() as { sql: string };
  assert.match(constraint.sql, /status = 'unavailable' AND unavailable_reason IS NOT NULL/);
  db.close();
  console.log("capability-kernel: execution, retry, idempotency and availability checks passed ✓");
})();

if (process.argv[1]?.includes("capability-kernel.test")) {
  capabilityKernelTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
