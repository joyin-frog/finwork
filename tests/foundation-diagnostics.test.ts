import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { captureFoundationDiagnostics } from "../lib/observability/index.ts";
import { CapabilityFoundationRollout } from "../lib/runtime/capability-foundation-rollout.ts";

export const foundationDiagnosticsTestPromise = (async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  try {
    new CapabilityFoundationRollout(db).ensureInitialized("diagnostics fixture");
    const snapshot = captureFoundationDiagnostics(db, "2026-08-09T00:00:00.000Z");
    assert.equal(snapshot.rollout?.authority, "legacy");
    assert.equal(snapshot.artifacts.logicalBytes, 0);
    assert.equal(snapshot.retrieval.chunks, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM foundation_diagnostics").get() as { n: number }).n, 1);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["prompt", "document_content", "secret", "api_key", "payload_json"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    db.close();
  }
  console.log("foundation-diagnostics: aggregate-only persisted snapshot passed ✓");
})();

if (process.argv[1]?.includes("foundation-diagnostics.test")) {
  foundationDiagnosticsTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
