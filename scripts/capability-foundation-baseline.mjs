#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }
  return values;
}

function walkFiles(root, options = {}) {
  const { maxFiles = 250_000 } = options;
  const files = [];
  if (!existsSync(root)) return files;
  const queue = [root];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

function directoryBytes(root) {
  let bytes = 0;
  let fileCount = 0;
  for (const filePath of walkFiles(root)) {
    try {
      bytes += statSync(filePath).size;
      fileCount += 1;
    } catch {
      // A concurrent application write may remove a file between walk and stat.
    }
  }
  return { bytes, fileCount };
}

// ESM-safe file hashing without keeping large fixture files in memory.
async function sha256FileStreaming(filePath) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => String(row.name));
}

function safeCount(db, table) {
  if (!tableExists(db, table)) return null;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(table)}`).get()?.count ?? 0);
}

function toAuditPath(filePath, appDataDir) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(appDataDir, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  if (resolved === path.resolve(appDataDir)) return ".";
  return `external:${path.basename(resolved)}`;
}

const FILE_REFERENCE_COLUMNS = new Map([
  ["chat_attachments", new Set(["storage_path"])],
  ["completion_evidence", new Set(["delivered_path"])],
  ["deliverables", new Set(["working_path", "delivered_path"])],
  ["knowledge_documents", new Set(["storage_path"])],
  ["library_files", new Set(["storage_path"])],
]);

function resolveStoredFilePath(db, table, column, rowid, value, appDataDir) {
  if (path.isAbsolute(value)) return value;
  if (table === "chat_attachments" && column === "storage_path") {
    const row = db
      .prepare(
        `SELECT m.conversation_id AS conversation_id
         FROM chat_attachments AS a
         JOIN chat_messages AS m ON m.id = a.message_id
         WHERE a.rowid = ?`,
      )
      .get(rowid);
    if (row?.conversation_id !== undefined) {
      return path.join(appDataDir, "files", String(row.conversation_id), value);
    }
  }
  return path.join(appDataDir, value);
}

function collectPathOrphans(db, appDataDir) {
  const anomalies = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  for (const { name } of tables) {
    const table = String(name);
    const allowedColumns = FILE_REFERENCE_COLUMNS.get(table);
    if (!allowedColumns) continue;
    const columns = tableColumns(db, table).filter((column) => allowedColumns.has(column));
    for (const column of columns) {
      let rows = [];
      try {
        rows = db
          .prepare(
            `SELECT rowid AS _rowid, ${JSON.stringify(column)} AS value FROM ${JSON.stringify(table)} ` +
              `WHERE ${JSON.stringify(column)} IS NOT NULL AND TRIM(${JSON.stringify(column)}) <> ''`,
          )
          .all();
      } catch (error) {
        anomalies.push({ table, column, kind: "scan_failed", reason: String(error) });
        continue;
      }
      for (const row of rows) {
        const value = String(row.value);
        const resolved = resolveStoredFilePath(db, table, column, Number(row._rowid), value, appDataDir);
        if (!existsSync(resolved)) {
          anomalies.push({
            table,
            column,
            rowid: Number(row._rowid),
            kind: "missing_file",
            path: toAuditPath(resolved, appDataDir),
          });
        }
      }
    }
  }
  return anomalies;
}

function collectProcessBaseline(pid) {
  const result = {
    collectorPid: process.pid,
    collectorRssBytes: process.memoryUsage().rss,
    targetPid: pid ?? null,
    targetRssBytes: null,
    status: pid ? "unavailable" : "not_requested",
    reason: null,
  };
  if (!pid) return result;
  try {
    const raw = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const kib = Number(raw);
    if (!Number.isFinite(kib) || kib <= 0) throw new Error(`unexpected ps output: ${raw}`);
    result.targetRssBytes = kib * 1024;
    result.status = "captured";
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function fixtureCategory(filePath, size) {
  const lower = filePath.toLowerCase();
  const extension = path.extname(lower);
  const categories = [];
  if (extension === ".docx") categories.push("docx");
  if (extension === ".pdf") categories.push("pdf");
  if (extension === ".pptx") categories.push("pptx");
  if (extension === ".xls") categories.push("xls");
  if (extension === ".xlsx") categories.push("xlsx");
  if (extension === ".xlsm") categories.push("macro");
  if (/scan|scanned|ocr/.test(lower)) categories.push("scanned");
  if (/external|linked|link/.test(lower) && [".xls", ".xlsx", ".xlsm"].includes(extension)) {
    categories.push("external_link");
  }
  if (size >= 5 * 1024 * 1024) categories.push("large");
  return categories;
}

async function collectFixtures() {
  const roots = [path.join(ROOT, "tests", "fixtures"), path.join(ROOT, ".finwork-test", "capability-foundation", "fixtures")];
  const records = [];
  for (const fixtureRoot of roots) {
    for (const filePath of walkFiles(fixtureRoot, { maxFiles: 10_000 })) {
      const size = statSync(filePath).size;
      const categories = fixtureCategory(filePath, size);
      if (categories.length === 0) continue;
      records.push({
        path: path.relative(ROOT, filePath),
        bytes: size,
        sha256: await sha256FileStreaming(filePath),
        categories,
      });
    }
  }
  const required = ["docx", "pdf", "pptx", "xls", "xlsx", "scanned", "macro", "external_link", "large"];
  const coverage = Object.fromEntries(required.map((category) => [category, records.some((item) => item.categories.includes(category))]));
  return { roots: roots.map((value) => path.relative(ROOT, value)), records, coverage, missing: required.filter((key) => !coverage[key]) };
}

function collectMemoryFiles(appDataDir) {
  const names = new Set(["memory.md", "profile.md", "profile.json"]);
  return walkFiles(appDataDir)
    .filter((filePath) => names.has(path.basename(filePath).toLowerCase()))
    .map((filePath) => ({ path: toAuditPath(filePath, appDataDir), bytes: statSync(filePath).size }));
}

const args = parseArgs(process.argv.slice(2));
const appDataDir = path.resolve(args.get("app-data") ?? path.join(os.homedir(), "Library", "Application Support", "Finwork"));
const dbPath = path.resolve(args.get("db") ?? path.join(appDataDir, "finance-agent.db"));
const outputPath = path.resolve(
  args.get("output") ?? path.join(ROOT, ".finwork-test", "capability-foundation", "baseline.json"),
);
const pid = args.has("pid") ? Number(args.get("pid")) : undefined;

if (!existsSync(dbPath)) {
  console.error(`WP0 baseline failed: database not found: ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
let report;
try {
  const quickCheck = String(db.prepare("PRAGMA quick_check").get()?.quick_check ?? "missing");
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => String(row.name));
  const counts = Object.fromEntries(tables.map((table) => [table, safeCount(db, table)]));
  const appDataSize = directoryBytes(appDataDir);
  const fixtures = await collectFixtures();
  const memoryFiles = collectMemoryFiles(appDataDir);
  const pathOrphans = collectPathOrphans(db, appDataDir);

  report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    source: {
      appDataDir,
      databasePath: dbPath,
      databaseBytes: statSync(dbPath).size,
      appDataBytes: appDataSize.bytes,
      appDataFileCount: appDataSize.fileCount,
    },
    database: {
      userVersion,
      quickCheck,
      tableCount: tables.length,
      counts,
      foreignKeyViolations,
      pathOrphans,
    },
    migrationSources: {
      roleMemoryRows: counts.role_memory ?? 0,
      memoryFiles,
      knowledgeDocumentRows: counts.knowledge_documents ?? 0,
      knowledgeEmbeddingRows: counts.knowledge_embeddings ?? 0,
      deliverableRows: counts.deliverables ?? 0,
      artifactRows: counts.artifacts ?? 0,
      generatedFileRows: counts.library_files ?? 0,
      attachmentRows: counts.chat_attachments ?? 0,
    },
    fixtures,
    process: collectProcessBaseline(pid),
    gates: {
      databaseHealthy: quickCheck === "ok" && foreignKeyViolations.length === 0,
      fixtureCoverageComplete: fixtures.missing.length === 0,
      unexplainedOrphans: pathOrphans.length,
    },
  };
} finally {
  db.close();
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`WP0 baseline written: ${outputPath}`);
console.log(JSON.stringify(report.gates));
if (!report.gates.databaseHealthy) process.exitCode = 1;
