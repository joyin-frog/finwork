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
    let nextWrites = 0;

    const next = async (value: number) => { nextWrites += 1; return { value }; };

    const first = await gateway.execute({ input: 1, operation: "write", next });
    const second = await gateway.execute({ input: 2, operation: "read", next });
    assert.deepEqual(first, { value: 1 });
    assert.deepEqual(second, { value: 2 });
    assert.equal(nextWrites, 2, "every operation must execute exactly once through Foundation");
    assert.equal(
      Number((db.prepare("SELECT COUNT(*) AS n FROM capability_shadow_comparisons").get() as { n: number }).n),
      0,
      "production gateway must not create shadow comparisons",
    );
    rollout.assertNewAuthority();
  } finally {
    db.close();
  }
  console.log("capability-foundation-gateway: single production executor passed ✓");
})();

if (process.argv[1]?.includes("capability-foundation-gateway.test")) {
  capabilityFoundationGatewayTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
