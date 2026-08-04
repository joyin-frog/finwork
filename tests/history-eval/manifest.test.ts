import assert from "node:assert/strict";
import {
  HISTORICAL_FINANCE_CASES,
  HISTORICAL_FIXTURE_SHA256,
} from "./cases";

assert.equal(HISTORICAL_FINANCE_CASES.length, 7);
assert.equal(new Set(HISTORICAL_FINANCE_CASES.map((c) => c.id)).size, 7);
for (const item of HISTORICAL_FINANCE_CASES) {
  assert.match(item.sourceSessionId, /^[0-9a-f-]{36}$/);
  assert.ok(item.input.length > 80);
  assert.ok(item.historicalToolCalls > 0);
  assert.ok(item.judgeRubric.length > 20);
  assert.ok(item.taskContract.requiredDeliverables.length > 0);
  assert.ok(item.artifactAssertions.length > 0);
  assert.ok(item.artifactAssertions.some((assertion) => assertion.critical));
  for (const fixture of item.fixtureFiles ?? []) {
    assert.match(
      HISTORICAL_FIXTURE_SHA256[fixture] ?? "",
      /^[0-9a-f]{64}$/,
      `${item.id}: ${fixture} must have a frozen source hash`,
    );
  }
}
console.log("historical-finance-eval manifest: 7 sanitized cases ✓");
