import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { CapabilityFoundationRollout } from "../lib/runtime/capability-foundation-rollout.ts";

export const capabilityFoundationRolloutTestPromise = (async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  try {
    const rollout = new CapabilityFoundationRollout(db, () => new Date("2026-08-09T00:00:00.000Z"));
    const initial = rollout.ensureInitialized();
    assert.equal(initial.mode, "shadow");
    assert.equal(initial.authority, "legacy");
    assert.throws(() => rollout.assertNewAuthority(), /not the active write authority/);

    assert.equal(rollout.recordComparison({ caseId: "case-1", legacy: { value: 1 }, next: { value: 1 } }).outcome, "matched");
    assert.equal(rollout.recordComparison({ caseId: "case-2", legacy: { value: 1 }, next: { value: 2 } }).outcome, "mismatched");
    assert.equal(rollout.recordComparison({ caseId: "case-3", legacy: {}, next: {}, conclusive: false }).outcome, "inconclusive");

    const cutover = rollout.cutover("golden, security, performance and shadow gates passed");
    assert.equal(cutover.authority, "new");
    rollout.assertNewAuthority();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capability_rollout_epochs WHERE state='active'").get() as { n: number }).n, 1);

    const rollback = rollout.rollback("rehearsal");
    assert.equal(rollback.authority, "legacy");
    assert.throws(() => rollout.assertNewAuthority(), /not the active write authority/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capability_rollout_epochs WHERE state='active'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capability_rollout_epochs WHERE state='retired'").get() as { n: number }).n, 2);
  } finally {
    db.close();
  }
  console.log("capability-foundation-rollout: shadow, atomic cutover and rollback passed ✓");
})();

if (process.argv[1]?.includes("capability-foundation-rollout.test")) {
  capabilityFoundationRolloutTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
