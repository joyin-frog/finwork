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
    assert.equal(initial.mode, "cutover");
    assert.equal(initial.authority, "new");
    rollout.assertNewAuthority();

    db.prepare("UPDATE capability_rollout_epochs SET state='retired' WHERE state='active'").run();
    db.prepare(`
      INSERT INTO capability_rollout_epochs(mode,authority,state,reason,created_at)
      VALUES ('shadow','legacy','active','legacy fixture',?)
    `).run("2026-08-09T00:00:00.000Z");
    const healed = rollout.ensureInitialized("heal stale authority");
    assert.equal(healed.mode, "cutover");
    assert.equal(healed.authority, "new");
    assert.notEqual(healed.epoch, initial.epoch);

    assert.equal(rollout.recordComparison({ caseId: "case-1", legacy: { value: 1 }, next: { value: 1 } }).outcome, "matched");
    assert.equal(rollout.recordComparison({ caseId: "case-2", legacy: { value: 1 }, next: { value: 2 } }).outcome, "mismatched");
    assert.equal(rollout.recordComparison({ caseId: "case-3", legacy: {}, next: {}, conclusive: false }).outcome, "inconclusive");

    const cutover = rollout.cutover("production authority assertion");
    assert.equal(cutover.authority, "new");
    assert.equal(cutover.epoch, healed.epoch, "cutover assertion must be idempotent");
    rollout.assertNewAuthority();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capability_rollout_epochs WHERE state='active'").get() as { n: number }).n, 1);

    assert.throws(() => rollout.beginShadow("rehearsal"), /retired/);
    assert.throws(() => rollout.rollback("rehearsal"), /retired/);
    rollout.assertNewAuthority();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capability_rollout_epochs WHERE state='active'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM capability_rollout_epochs WHERE state='retired'").get() as { n: number }).n, 2);
  } finally {
    db.close();
  }
  console.log("capability-foundation-rollout: production-only authority and retired fallback passed ✓");
})();

if (process.argv[1]?.includes("capability-foundation-rollout.test")) {
  capabilityFoundationRolloutTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
