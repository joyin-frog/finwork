#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { backup, DatabaseSync } from "node:sqlite";
import {
  LATEST_VERSION,
  getUserVersion,
  initializeFinanceDatabase,
  openFinanceDatabase,
  rehearseMigrations,
} from "../lib/db/sqlite.ts";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(item.slice(2), next);
      index += 1;
    }
  }
  return values;
}

function hashIfPresent(filePath) {
  if (!existsSync(filePath)) return null;
  return {
    bytes: statSync(filePath).size,
    sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
  };
}

function sourceFingerprint(dbPath) {
  return {
    database: hashIfPresent(dbPath),
    wal: hashIfPresent(`${dbPath}-wal`),
    shm: hashIfPresent(`${dbPath}-shm`),
  };
}

function schemaSnapshot(db) {
  const version = getUserVersion(db);
  const quickCheck = String(db.prepare("PRAGMA quick_check").get()?.quick_check ?? "missing");
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  return { version, quickCheck, schema };
}

const args = parseArgs(process.argv.slice(2));
const appDataDir = path.resolve(
  args.get("app-data") ?? path.join(os.homedir(), "Library", "Application Support", "Finwork"),
);
const sourceDbPath = path.resolve(args.get("db") ?? path.join(appDataDir, "finance-agent.db"));
const outputPath = path.resolve(
  args.get("output") ?? path.join(process.cwd(), ".finwork-test", "capability-foundation", "migration-dry-run.json"),
);

if (!existsSync(sourceDbPath)) {
  console.error(`Migration dry-run failed: database not found: ${sourceDbPath}`);
  process.exit(2);
}

// Keep rehearsal artifacts inside an explicitly writable project-owned root.
// On macOS, os.tmpdir() can resolve to a per-user directory that is readable
// by the process but not writable by SQLite's VACUUM INTO under a sandboxed
// runner. The directory remains disposable and is removed in the finally block.
const temporaryBase = path.resolve(
  args.get("temp-dir") ?? path.join(process.cwd(), ".finwork-test", "capability-foundation", "tmp"),
);
mkdirSync(temporaryBase, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(temporaryBase, "migration-"));
const sourceSnapshotPath = path.join(temporaryRoot, "source-snapshot.db");
const emptyDbPath = path.join(temporaryRoot, "empty.db");
const beforeFingerprint = sourceFingerprint(sourceDbPath);
let report;

try {
  // Copying the source and all currently materialized WAL data is delegated to
  // SQLite's online backup API. The real user database is opened read-only and
  // never gets a checkpoint, journal-mode change or migration. VACUUM INTO is
  // intentionally avoided because sandboxed SQLite builds can reject it even
  // when the destination directory is writable.
  const sourceDb = new DatabaseSync(sourceDbPath, { readOnly: true });
  let sourceReadOnly;
  let sourceQuickCheck;
  try {
    sourceDb.exec("PRAGMA query_only=ON");
    sourceReadOnly = Number(sourceDb.prepare("PRAGMA query_only").get()?.query_only ?? 0) === 1;
    sourceQuickCheck = String(sourceDb.prepare("PRAGMA quick_check").get()?.quick_check ?? "missing");
    await backup(sourceDb, sourceSnapshotPath);
  } finally {
    sourceDb.close();
  }

  const snapshotDb = openFinanceDatabase(sourceSnapshotPath);
  let snapshotBefore;
  let rehearsal;
  let repeated;
  try {
    snapshotBefore = schemaSnapshot(snapshotDb);
    rehearsal = await rehearseMigrations(snapshotDb, sourceSnapshotPath);
    initializeFinanceDatabase(snapshotDb, sourceSnapshotPath);
    const first = schemaSnapshot(snapshotDb);
    initializeFinanceDatabase(snapshotDb, sourceSnapshotPath);
    const second = schemaSnapshot(snapshotDb);
    repeated = {
      firstVersion: first.version,
      secondVersion: second.version,
      schemaStable: JSON.stringify(first.schema) === JSON.stringify(second.schema),
      quickCheck: second.quickCheck,
    };
  } finally {
    snapshotDb.close();
  }

  const emptyDb = openFinanceDatabase(emptyDbPath);
  let emptyDatabase;
  try {
    initializeFinanceDatabase(emptyDb, emptyDbPath);
    const first = schemaSnapshot(emptyDb);
    initializeFinanceDatabase(emptyDb, emptyDbPath);
    const second = schemaSnapshot(emptyDb);
    emptyDatabase = {
      version: second.version,
      latestVersion: LATEST_VERSION,
      quickCheck: second.quickCheck,
      schemaStable: JSON.stringify(first.schema) === JSON.stringify(second.schema),
    };
  } finally {
    emptyDb.close();
  }

  const afterFingerprint = sourceFingerprint(sourceDbPath);
  // Opening a WAL-mode SQLite database read-only can materialize empty `-wal`
  // and `-shm` sidecars even when the database payload is untouched. Treat the
  // database file as the mutation gate and keep the full fingerprint only as
  // an observation of concurrent activity / sidecar materialization.
  const sourceDatabaseFingerprintStableDuringRun =
    JSON.stringify(beforeFingerprint.database) === JSON.stringify(afterFingerprint.database);
  const sourceFingerprintStableDuringRun = JSON.stringify(beforeFingerprint) === JSON.stringify(afterFingerprint);
  const gates = {
    sourceOpenedReadOnly: sourceReadOnly,
    sourceIntegrityPassed: sourceQuickCheck === "ok",
    sourceDatabaseFingerprintStable: sourceDatabaseFingerprintStableDuringRun,
    snapshotRehearsalPassed: rehearsal.ok && rehearsal.toVersion === LATEST_VERSION,
    snapshotRepeatedExecutionStable:
      repeated.schemaStable && repeated.quickCheck === "ok" && repeated.secondVersion === LATEST_VERSION,
    emptyDatabasePassed:
      emptyDatabase.schemaStable && emptyDatabase.quickCheck === "ok" && emptyDatabase.version === LATEST_VERSION,
  };

  report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: {
      path: sourceDbPath,
      beforeVersion: snapshotBefore.version,
      accessMode: sourceReadOnly ? "read_only_query_only" : "unverified",
      quickCheck: sourceQuickCheck,
      databaseFingerprintStableDuringRun: sourceDatabaseFingerprintStableDuringRun,
      fingerprintStableDuringRun: sourceFingerprintStableDuringRun,
      fingerprintObservation:
        sourceFingerprintStableDuringRun
          ? "stable"
          : sourceDatabaseFingerprintStableDuringRun
            ? "database_stable; sqlite_sidecars_materialized_or_changed; dry-run connection remained read-only"
            : "database_changed_by_concurrent_application_activity; dry-run connection remained read-only",
      fingerprintBefore: beforeFingerprint,
      fingerprintAfter: afterFingerprint,
    },
    latestVersion: LATEST_VERSION,
    rehearsal,
    repeated,
    emptyDatabase,
    gates,
  };
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Migration dry-run written: ${outputPath}`);
console.log(JSON.stringify(report.gates));
if (Object.values(report.gates).some((value) => !value)) process.exitCode = 1;
