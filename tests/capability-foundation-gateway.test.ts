import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "@/lib/db/migrations";
import { CapabilityFoundationRollout } from "@/lib/runtime/capability-foundation-rollout";
import { CapabilityFoundationGateway } from "@/lib/runtime/capability-foundation-gateway";

export const capabilityFoundationGatewayTestPromise = (async () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, ":memory:", () => null);
  try {
    const rollout = new CapabilityFoundationRollout(db, () => new Date("2026-08-09T00:00:00.000Z"));
    const gateway = new CapabilityFoundationGateway(rollout);
    let legacyWrites = 0;
    let nextWrites = 0;

    const legacy = async (value: number) => { legacyWrites += 1; return { value }; };
    const next = async (value: number) => { nextWrites += 1; return { value }; };

    const shadowResult = await gateway.execute({ input: 1, operation: "write", legacy, next });
    assert.deepEqual(shadowResult, { value: 1 });
    assert.equal(legacyWrites, 1);
    assert.equal(nextWrites, 0, "shadow write must not dual-write");
    assert.equal((db.prepare("SELECT outcome FROM capability_shadow_comparisons").get() as { outcome: string }).outcome, "inconclusive");

    let legacyReads = 0;
    let nextReads = 0;
    let safeShadowReads = 0;
    const readWithoutShadow = await gateway.execute({
      input: 4,
      operation: "read",
      legacy: async (value) => { legacyReads += 1; return { value }; },
      next: async (value) => { nextReads += 1; return { value }; },
    });
    assert.deepEqual(readWithoutShadow, { value: 4 });
    assert.equal(legacyReads, 1);
    assert.equal(nextReads, 0, "shadow read must not implicitly execute the next implementation");

    const readWithExplicitShadow = await gateway.execute({
      input: 5,
      operation: "read",
      legacy: async (value) => { legacyReads += 1; return { value }; },
      next: async (value) => { nextReads += 1; return { value }; },
      shadow: async (value) => { safeShadowReads += 1; return { value }; },
    });
    assert.deepEqual(readWithExplicitShadow, { value: 5 });
    assert.equal(nextReads, 0);
    assert.equal(safeShadowReads, 1, "only the explicit side-effect-free shadow may be compared");

    rollout.cutover("Golden gates passed");
    const cutoverResult = await gateway.execute({ input: 2, operation: "write", legacy, next });
    assert.deepEqual(cutoverResult, { value: 2 });
    assert.equal(legacyWrites, 1, "legacy write must be closed after cutover");
    assert.equal(nextWrites, 1);

    rollout.rollback("rollback rehearsal");
    await gateway.execute({ input: 3, operation: "write", legacy, next });
    assert.equal(legacyWrites, 2);
    assert.equal(nextWrites, 1);
  } finally {
    db.close();
  }
  console.log("capability-foundation-gateway: no dual-write and single authority passed ✓");
})();

if (process.argv[1]?.includes("capability-foundation-gateway.test")) {
  capabilityFoundationGatewayTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
