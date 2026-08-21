import path from "node:path";
import { createBuiltInPreproductionAdapters } from "../lib/evaluation/preproduction-adapters.ts";
import { runPreproductionE2E } from "../lib/evaluation/preproduction-e2e.ts";

const fixtureRoot = path.resolve(
  process.env.FINWORK_E2E_FIXTURE_ROOT
    ?? path.join(process.cwd(), "tests", "history-eval", "preproduction-fixtures"),
);
const outputRoot = path.resolve(
  process.env.FINWORK_E2E_OUTPUT_ROOT
    ?? path.join(process.cwd(), ".finwork-test", "preproduction-e2e"),
);
const adapters = createBuiltInPreproductionAdapters();
const report = await runPreproductionE2E({
  fixtureRoot,
  outputRoot,
  adapters,
  trustedAdapterIds: adapters.map((adapter) => adapter.id),
  allowExternalEgress: process.env.FINWORK_E2E_ALLOW_EXTERNAL === "1",
});

console.log(JSON.stringify({
  status: report.status,
  qualification: report.qualification,
  runId: report.runId,
  fixtureManifestPath: report.fixtureManifestPath,
  cases: report.cases.map((item) => ({
    manifestId: item.manifestId,
    status: item.status,
    adapterId: item.adapterId ?? null,
    blockers: item.blockers,
    failures: item.failures,
  })),
  blockers: report.blockers,
  failures: report.failures,
  reportSha256: report.reportSha256,
}, null, 2));

process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
