#!/usr/bin/env node
/**
 * Reset knowledge base: drop chunks, vec table, and storage dir.
 * Use after switching embedding model (dimension change).
 * Usage: node scripts/knowledge-reset.mjs
 */

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

function getDefaultAppDataRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

const appDataDir = process.env.FINANCE_AGENT_APP_DATA_DIR
  ?? process.env.FINANCE_AGENT_DATA_DIR
  ?? path.join(getDefaultAppDataRoot(), "finance-agent");
const dbPath = process.env.FINANCE_AGENT_DB_PATH
  ?? path.join(appDataDir, "finance-agent.db");
const knowledgeDir = process.env.FINANCE_AGENT_KNOWLEDGE_DIR
  ?? path.join(appDataDir, "knowledge");

console.log("DB:", dbPath);
console.log("Knowledge dir:", knowledgeDir);

if (!existsSync(dbPath)) {
  console.log("DB not found, nothing to drop.");
} else {
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(sqliteVec.getLoadablePath());
  const before = (db.prepare("SELECT COUNT(*) AS c FROM knowledge_documents").get()).c;
  db.exec("DELETE FROM knowledge_chunks");
  db.exec("DELETE FROM knowledge_documents");
  db.exec("DROP TABLE IF EXISTS knowledge_vec");
  db.exec("DELETE FROM app_settings WHERE key='knowledge_embed_dim'");
  console.log(`Cleared ${before} documents + chunks + vec table.`);
  db.close();
}

if (existsSync(knowledgeDir)) {
  rmSync(knowledgeDir, { recursive: true, force: true });
  console.log(`Removed storage dir: ${knowledgeDir}`);
} else {
  console.log("Storage dir not found, skipping.");
}

console.log("\nDone. Re-upload documents through the UI.");
