import type { DatabaseSync } from "node:sqlite";

let savepointSequence = 0;

/**
 * Runs synchronous SQLite work inside a composable transaction boundary.
 *
 * SQLite savepoints work both at the top level and inside another transaction,
 * which lets infrastructure stores participate in one business transaction
 * without guessing whether their caller already owns the transaction.
 */
export function withSqliteSavepoint<T>(
  db: DatabaseSync,
  label: string,
  operation: () => T,
): T {
  savepointSequence += 1;
  const safeLabel = label.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48) || "operation";
  const savepoint = `finwork_${safeLabel}_${savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
