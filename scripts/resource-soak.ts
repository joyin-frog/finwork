import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations";
import {
  createResourceSoakContract,
  readResourceSoakState,
  runResourceSoakSlice,
  verifyResourceSoakEvidence,
} from "../lib/resource";

async function main(): Promise<void> {
  const outputRoot = path.resolve(process.env.FINWORK_RESOURCE_SOAK_DIR ?? path.join(process.cwd(), ".finwork-test", "resource-soak"));
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const dbPath = path.join(outputRoot, "resource-soak.sqlite");
  const runIdPath = path.join(outputRoot, "resource-soak-run-id.txt");
  const reportPath = path.join(outputRoot, "resource-soak-report.json");
  const mode = process.env.FINWORK_RESOURCE_SOAK_MODE === "accelerated" ? "accelerated" : "real";
  const contract = createResourceSoakContract({
    mode,
    ...(mode === "accelerated" ? {
      targetWallMs: 5_000,
      sliceMs: 1_000,
      checkpointMs: 250,
      rssDriftRatio: 0.99,
    } : {
      targetWallMs: 24 * 60 * 60 * 1000,
      sliceMs: 60 * 1000,
      checkpointMs: 60 * 1000,
    }),
  });
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  runMigrations(database, dbPath, () => null);

  let runId = fs.existsSync(runIdPath) ? fs.readFileSync(runIdPath, "utf8").trim() : "";
  let state = await runResourceSoakSlice({
    db: database,
    workspaceRoot: path.join(outputRoot, "workspaces"),
    contract,
    ...(runId ? { runId } : {}),
  });
  runId = state.runId;
  atomicWrite(runIdPath, `${runId}\n`);

  const writeReport = (): void => {
    const verification = verifyResourceSoakEvidence(database, runId);
    atomicWrite(reportPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      qualification: mode === "real" ? "release-evidence" : "mechanism-only-not-release-evidence",
      contract,
      state: readResourceSoakState(database, runId),
      verification,
    }, null, 2)}\n`);
  };

  while (state.status === "running") {
    state = await runResourceSoakSlice({
      db: database,
      workspaceRoot: path.join(outputRoot, "workspaces"),
      contract,
      runId,
    });
    writeReport();
  }
  writeReport();
  const finalVerification = verifyResourceSoakEvidence(database, runId);
  process.exitCode = state.status === "completed" && finalVerification.ok ? 0 : 1;
  database.close();
}

function atomicWrite(target: string, content: string): void {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

void main();
