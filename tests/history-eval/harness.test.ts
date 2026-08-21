import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HISTORICAL_FINANCE_CASES } from "./cases";
import { checkMinimumDeliverables } from "./minimum-deliverable";

const contract = HISTORICAL_FINANCE_CASES.find((item) => item.id === "HISTORY-003")!.deliverySpec;
const root = mkdtempSync(path.join(os.tmpdir(), "history-harness-test-"));
try {
  assert.equal(checkMinimumDeliverables(contract, root).ok, false);

  writeFileSync(path.join(root, "fake.xlsx"), Buffer.alloc(512, 0));
  assert.equal(checkMinimumDeliverables(contract, root).ok, false, "非 ZIP 的伪 xlsx 必须被拒绝");

  mkdirSync(path.join(root, "nested"));
  writeFileSync(
    path.join(root, "nested", "candidate.xlsx"),
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(512)]),
  );
  assert.equal(checkMinimumDeliverables(contract, root).ok, true);
  console.log("history harness: minimum deliverable gate ✓");
} finally {
  rmSync(root, { recursive: true, force: true });
}
