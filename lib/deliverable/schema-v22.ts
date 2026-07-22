/**
 * CR-Q1 migration DDL — version **22** only.
 *
 * Dependency: CR-R1 owns version **21** (agent_runs / run_events).
 * Do not invent v21 here. Register this up() as MIGRATIONS version 22
 * after R1's v21 entry exists in the chain (or merge coordinator inserts v21 first).
 *
 * Uses CREATE IF NOT EXISTS so a parallel branch can apply tables safely.
 */

import type { DatabaseSync } from "node:sqlite";

export const DELIVERABLE_MIGRATION_VERSION = 22 as const;
export const DELIVERABLE_MIGRATION_NAME = "deliverable_registry" as const;

export function upDeliverablesV22(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      contract_deliverable_id TEXT NOT NULL,
      working_path TEXT,
      delivered_path TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      working_sha256 TEXT,
      delivered_sha256 TEXT,
      validator_id TEXT,
      quality_profile TEXT,
      validation_report_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      validated_at TEXT,
      delivered_at TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deliverables_run ON deliverables(run_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_deliverables_run_contract ON deliverables(run_id, contract_deliverable_id)`
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS completion_evidence (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      contract_deliverable_id TEXT NOT NULL,
      delivered_path TEXT NOT NULL,
      delivered_sha256 TEXT NOT NULL,
      mime TEXT NOT NULL,
      validator_id TEXT NOT NULL,
      quality_profile TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      validated_at TEXT NOT NULL,
      report_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_completion_evidence_run ON completion_evidence(run_id)`);
}
