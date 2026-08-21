import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runMigrations } from "../lib/db/migrations";

type SchemaColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
runMigrations(db, ":memory:", () => null);

const tables = (db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all() as Array<{ name: string }>).map(({ name }) => name);

const indexDetails = db.prepare(
  `SELECT name, tbl_name AS "table"
   FROM sqlite_master
   WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
   ORDER BY name`,
).all() as Array<{ name: string; table: string }>;

const columns = Object.fromEntries(
  tables.map((table) => [
    table,
    db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as SchemaColumn[],
  ]),
);

db.close();

const output = {
  tables,
  indexes: indexDetails.map(({ name }) => name),
  indexDetails,
  columns,
};

const outputPath = resolve(process.cwd(), "tests/fixtures/golden-schema.json");
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Updated ${outputPath}`);
