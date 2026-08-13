import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { getMemoryPath } from "@/lib/runtime/paths";
import type { MemoryCandidate, MemoryRecordV2 } from "./contracts";
import { GovernedMemoryStore } from "./store";

const LEGACY_OWNER = { id: "local-user", type: "user" as const, tenantId: "local" };

type MigrationCounts = {
  roleMemory: number;
  memoryMarkdown: number;
  feedback: number;
  skipped: number;
};

type LegacyUnit = {
  sourceKind: "role_memory" | "memory_md" | "chat_feedback";
  sourceId: string;
  content: string;
  createdAt: string;
  kind: MemoryRecordV2["kind"];
  roleId?: string;
  sourceLabel?: string | null;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoDate(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function markdownUnits(text: string, at: string): LegacyUnit[] {
  let section = "未分类";
  const units: LegacyUnit[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const content = line.replace(/^[-*+]\s+(?:\[\d{4}-\d{2}-\d{2}\]\s*)?/, "").trim();
    if (!content) continue;
    const sourceHash = digest(`${section}\n${content}`);
    const procedural = /(约定|流程|规则|偏好|步骤|操作)/.test(section);
    const feedback = /(反馈|纠错|错误)/.test(section);
    units.push({
      sourceKind: "memory_md",
      sourceId: `${sourceHash.slice(0, 40)}`,
      content,
      createdAt: at,
      kind: feedback ? "feedback" : procedural ? "procedural" : "semantic",
      sourceLabel: section,
    });
  }
  return units;
}

function conflictKey(unit: LegacyUnit): string {
  const normalized = unit.content.replace(/\s+/g, " ").trim().toLowerCase();
  const subject = normalized.split(/[：:=]/, 1)[0]?.slice(0, 80) || normalized.slice(0, 80);
  return `legacy:${unit.roleId ?? "global"}:${digest(subject).slice(0, 24)}`;
}

function toCandidate(unit: LegacyUnit, at: string): MemoryCandidate {
  const sourceHash = digest(JSON.stringify(unit));
  const sourceEvidence = `legacy-${unit.sourceKind}-${digest(`${unit.sourceId}:${sourceHash}`).slice(0, 32)}`;
  return {
    conflictKey: conflictKey(unit),
    record: {
      id: `memory-v2-${digest(`${unit.sourceKind}:${unit.sourceId}:${sourceHash}`).slice(0, 32)}`,
      kind: unit.kind,
      scope: {
        tenantId: "local",
        ...(unit.roleId ? { roleId: unit.roleId } : { principalId: "local-user" }),
      },
      entityRefs: [],
      content: {
        summary: unit.content,
        legacySource: unit.sourceKind,
        ...(unit.sourceLabel ? { sourceLabel: unit.sourceLabel } : {}),
      },
      sourceEvidenceRefs: [sourceEvidence],
      confidence: 0.5,
      sensitivity: "confidential",
      createdAt: isoDate(unit.createdAt, at),
      owner: LEGACY_OWNER,
    },
  };
}

function hasMigration(db: DatabaseSync, unit: LegacyUnit): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM memory_migration_log_v2 WHERE source_kind = ? AND source_id = ?
  `).get(unit.sourceKind, unit.sourceId));
}

function migrateUnit(db: DatabaseSync, store: GovernedMemoryStore, unit: LegacyUnit, at: string): boolean {
  if (hasMigration(db, unit)) return false;
  const candidate = toCandidate(unit, at);
  // Recover from the narrow crash window between candidate creation and migration-log
  // insertion. The deterministic id lets the next run finish the log without creating
  // a duplicate or silently approving anything.
  const memory = store.get(candidate.record.id) ?? store.createCandidate(candidate);
  db.prepare(`
    INSERT INTO memory_migration_log_v2(source_kind, source_id, memory_id, source_hash, migrated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(unit.sourceKind, unit.sourceId, memory.id, digest(JSON.stringify(unit)), at);
  return true;
}

/**
 * One-way compatibility bridge. Legacy stores are inventory sources only: every
 * item becomes a reviewable candidate and is never approved or injected here.
 */
export async function migrateLegacyMemoryCandidates(options: {
  db: DatabaseSync;
  memoryPath?: string;
  at?: string;
}): Promise<MigrationCounts> {
  const at = options.at ?? new Date().toISOString();
  const store = new GovernedMemoryStore(options.db);
  const counts: MigrationCounts = { roleMemory: 0, memoryMarkdown: 0, feedback: 0, skipped: 0 };
  const units: LegacyUnit[] = [];

  if (tableExists(options.db, "role_memory")) {
    const rows = options.db.prepare(`
      SELECT id, role_id, content, source, created_at FROM role_memory ORDER BY id
    `).all() as Array<{ id: number; role_id: string; content: string; source: string | null; created_at: string }>;
    units.push(...rows.map((row) => ({
      sourceKind: "role_memory" as const,
      sourceId: String(row.id),
      content: row.content,
      createdAt: row.created_at,
      kind: "procedural" as const,
      roleId: row.role_id,
      sourceLabel: row.source,
    })));
  }

  if (tableExists(options.db, "chat_feedback")) {
    const rows = options.db.prepare(`
      SELECT id, reason, updated_at FROM chat_feedback
      WHERE rating = 'down' AND reason IS NOT NULL AND trim(reason) <> ''
      ORDER BY id
    `).all() as Array<{ id: number; reason: string; updated_at: string }>;
    units.push(...rows.map((row) => ({
      sourceKind: "chat_feedback" as const,
      sourceId: String(row.id),
      content: row.reason,
      createdAt: row.updated_at,
      kind: "feedback" as const,
    })));
  }

  const memoryPath = options.memoryPath ?? getMemoryPath();
  if (existsSync(memoryPath)) {
    const text = (await readFile(memoryPath, "utf8")).slice(0, 64 * 1024);
    units.push(...markdownUnits(text, at));
  }

  for (const unit of units) {
    const migrated = migrateUnit(options.db, store, unit, at);
    if (!migrated) {
      counts.skipped += 1;
      continue;
    }
    if (unit.sourceKind === "role_memory") counts.roleMemory += 1;
    if (unit.sourceKind === "memory_md") counts.memoryMarkdown += 1;
    if (unit.sourceKind === "chat_feedback") counts.feedback += 1;
  }
  return counts;
}
