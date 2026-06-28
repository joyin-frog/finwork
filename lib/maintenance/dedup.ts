/**
 * lib/maintenance/dedup.ts
 *
 * 对话文件去重清理(安全子集)
 *
 * 只处理两类:
 * ① 同一 conversationId 内内容重复的附件 → 留最早 canonical,其余 storage_path 重指向 canonical,删多余物理文件
 * ② 孤儿文件(无行引用)及 convId 已删的残留目录 → 删
 *
 * 安全不变量:
 * - 清理后每条 chat_attachment 行 storage_path 必须解析到存在的物理文件(零断链)
 * - 绝不删仍被 ≥1 行引用的物理文件
 * - 绝不跨对话重指(仅在同 convId 内操作)
 * - analyze 只读,cleanup 重新分析再执行
 * - 删/重指/覆盖均落审计(红线 8)
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb, insertAuditLog } from "@/lib/db/sqlite";
import { getAppDataDir, getConversationFilesDir } from "@/lib/runtime/paths";

/** 计算文件 buffer 的 sha256 hex hash */
function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 获取 files 根目录 */
function getFilesBaseDir(): string {
  return path.join(getAppDataDir(), "files");
}

/**
 * 从 chat_attachment 行的 storage_path + conversation_id 解析出绝对路径。
 * storage_path 是相对于 getConversationFilesDir(convId) 的相对路径。
 */
function resolveAttachmentPath(storagePath: string, conversationId: number): string {
  return path.join(getConversationFilesDir(conversationId), storagePath);
}

export type DuplicateAnalysis = {
  /** 同对话内重复文件数(可删的副本数,不含 canonical) */
  redundantFiles: number;
  /** 可回收字节数 */
  reclaimableBytes: number;
  /** 同对话内重复组数 */
  sameConvDupGroups: number;
  /** 孤儿文件数(目录里无行引用的 + convId 不存在的整目录文件数) */
  orphanFiles: number;
};

export type CleanupResult = {
  /** 实际清理的文件数(删除的物理文件数) */
  cleanedFiles: number;
  /** 实际回收的字节数 */
  reclaimedBytes: number;
};

type AttachmentRow = {
  id: string;
  message_id: number;
  file_name: string;
  size_bytes: number;
  storage_path: string;
  created_at: string;
  conversation_id: number | null;
};

/**
 * 仅读取分析,不修改任何文件/行。
 * 返回去重分析结果,用于前端提示用户决策。
 */
export function analyzeConversationDuplicates(db: DatabaseSync = getDb()): DuplicateAnalysis {
  const rows = db.prepare(`
    SELECT a.id, a.message_id, a.file_name, a.size_bytes, a.storage_path, a.created_at,
           m.conversation_id
    FROM chat_attachments a
    LEFT JOIN chat_messages m ON a.message_id = m.id
    ORDER BY m.conversation_id ASC, a.created_at ASC, a.id ASC
  `).all() as AttachmentRow[];

  // 取所有活跃的 conversation id
  const activeConvIds = new Set<number>(
    (db.prepare("SELECT id FROM chat_conversations").all() as Array<{ id: number }>).map((r) => r.id)
  );

  // 行按 convId 分组
  const byConv = new Map<number, AttachmentRow[]>();
  for (const row of rows) {
    const convId = row.conversation_id;
    if (convId === null) continue;
    if (!byConv.has(convId)) byConv.set(convId, []);
    byConv.get(convId)!.push(row);
  }

  let redundantFiles = 0;
  let reclaimableBytes = 0;
  let sameConvDupGroups = 0;

  // 分析同对话内重复
  for (const [convId, convRows] of byConv.entries()) {
    const hashToRows = new Map<string, AttachmentRow[]>();
    for (const row of convRows) {
      const absPath = resolveAttachmentPath(row.storage_path, convId);
      if (!existsSync(absPath)) continue;
      try {
        const buf = readFileSync(absPath);
        const h = hashBuffer(buf);
        if (!hashToRows.has(h)) hashToRows.set(h, []);
        hashToRows.get(h)!.push(row);
      } catch {
        // 读文件出错,跳过
      }
    }
    for (const group of hashToRows.values()) {
      if (group.length < 2) continue;
      sameConvDupGroups++;
      // 找出 canonical(最早):按 created_at ASC, id ASC
      const sorted = [...group].sort((a, b) => {
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : 1;
      });
      const canonicalPath = resolveAttachmentPath(sorted[0].storage_path, convId);
      // 多余的副本(从 sorted[1] 开始),且物理文件不等于 canonical
      for (let i = 1; i < sorted.length; i++) {
        const absPath = resolveAttachmentPath(sorted[i].storage_path, convId);
        if (absPath !== canonicalPath && existsSync(absPath)) {
          redundantFiles++;
          try {
            reclaimableBytes += statSync(absPath).size;
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // 分析孤儿文件和残留目录
  const orphanFiles = countOrphanFiles(rows, activeConvIds);

  return { redundantFiles, reclaimableBytes, sameConvDupGroups, orphanFiles };
}

/**
 * 遍历 files/ 目录,统计孤儿文件数:
 * - convId 已不存在的整个目录里的文件
 * - convId 存在但目录内某文件未被任何 chat_attachment 行引用
 */
function countOrphanFiles(rows: AttachmentRow[], activeConvIds: Set<number>): number {
  const filesBase = getFilesBaseDir();
  if (!existsSync(filesBase)) return 0;

  // 建立 convId → Set<storage_path> 的引用集合
  const convRefPaths = new Map<number, Set<string>>();
  for (const row of rows) {
    if (row.conversation_id === null) continue;
    if (!convRefPaths.has(row.conversation_id)) convRefPaths.set(row.conversation_id, new Set());
    convRefPaths.get(row.conversation_id)!.add(row.storage_path);
  }

  let orphanCount = 0;
  let dirs: string[];
  try {
    dirs = readdirSync(filesBase);
  } catch {
    return 0;
  }

  for (const dirName of dirs) {
    const dirPath = path.join(filesBase, dirName);
    let stat;
    try { stat = statSync(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const convId = Number(dirName);
    if (isNaN(convId)) continue;

    if (!activeConvIds.has(convId)) {
      // 整个目录是残留,统计文件数
      orphanCount += countFilesInDir(dirPath);
      continue;
    }

    // convId 存在:找未被引用的物理文件
    const refPaths = convRefPaths.get(convId) ?? new Set();
    orphanCount += countOrphanFilesInDir(dirPath, refPaths, "");
  }
  return orphanCount;
}

function countFilesInDir(dir: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) count += countFilesInDir(path.join(dir, entry.name));
    }
  } catch { /* ignore */ }
  return count;
}

function countOrphanFilesInDir(dir: string, refPaths: Set<string>, relBase: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        if (!refPaths.has(relPath)) count++;
      } else if (entry.isDirectory()) {
        count += countOrphanFilesInDir(path.join(dir, entry.name), refPaths, relPath);
      }
    }
  } catch { /* ignore */ }
  return count;
}

/**
 * 执行清理:重新分析(不依赖客户端传来的旧结果)+执行删/重指+落审计。
 * 红线 5:调用前须经用户确认(API 层保证)。
 * 红线 8:删/重指均落审计。
 */
export function cleanupConversationDuplicates(db: DatabaseSync = getDb()): CleanupResult {
  const rows = db.prepare(`
    SELECT a.id, a.message_id, a.file_name, a.size_bytes, a.storage_path, a.created_at,
           m.conversation_id
    FROM chat_attachments a
    LEFT JOIN chat_messages m ON a.message_id = m.id
    ORDER BY m.conversation_id ASC, a.created_at ASC, a.id ASC
  `).all() as AttachmentRow[];

  const activeConvIds = new Set<number>(
    (db.prepare("SELECT id FROM chat_conversations").all() as Array<{ id: number }>).map((r) => r.id)
  );

  // 行按 convId 分组
  const byConv = new Map<number, AttachmentRow[]>();
  for (const row of rows) {
    const convId = row.conversation_id;
    if (convId === null) continue;
    if (!byConv.has(convId)) byConv.set(convId, []);
    byConv.get(convId)!.push(row);
  }

  let cleanedFiles = 0;
  let reclaimedBytes = 0;

  // ① 同对话内内容重复:留最早 canonical,其余重指 + 删多余文件
  for (const [convId, convRows] of byConv.entries()) {
    const hashToRows = new Map<string, AttachmentRow[]>();
    for (const row of convRows) {
      const absPath = resolveAttachmentPath(row.storage_path, convId);
      if (!existsSync(absPath)) continue;
      try {
        const buf = readFileSync(absPath);
        const h = hashBuffer(buf);
        if (!hashToRows.has(h)) hashToRows.set(h, []);
        hashToRows.get(h)!.push(row);
      } catch {
        // 读文件出错跳过
      }
    }

    for (const group of hashToRows.values()) {
      if (group.length < 2) continue;
      // canonical = 最早 created_at + id(字典序)
      const sorted = [...group].sort((a, b) => {
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : 1;
      });

      const canonical = sorted[0];
      const canonicalAbsPath = resolveAttachmentPath(canonical.storage_path, convId);

      for (let i = 1; i < sorted.length; i++) {
        const dup = sorted[i];
        const dupAbsPath = resolveAttachmentPath(dup.storage_path, convId);

        if (dupAbsPath === canonicalAbsPath) {
          // 物理文件已经是同一个(storage_path 已相同),只需确保行一致
          continue;
        }

        // 重指 storage_path → canonical 的相对路径(同 convId,路径相对于同一目录)
        const newStoragePath = canonical.storage_path;
        db.prepare("UPDATE chat_attachments SET storage_path = ? WHERE id = ?").run(
          newStoragePath,
          dup.id
        );

        // 落审计(红线 8)
        insertAuditLog("dedup_repath", {
          attachmentId: dup.id,
          convId,
          oldPath: dup.storage_path,
          newPath: newStoragePath,
          canonicalId: canonical.id,
          at: new Date().toISOString(),
        });

        // 删多余物理文件(canonicalAbsPath 已经是正确的那份)
        if (existsSync(dupAbsPath)) {
          let fileSize = 0;
          try { fileSize = statSync(dupAbsPath).size; } catch { /* ignore */ }
          unlinkSync(dupAbsPath);
          cleanedFiles++;
          reclaimedBytes += fileSize;

          insertAuditLog("dedup_delete_redundant", {
            attachmentId: dup.id,
            convId,
            deletedPath: dupAbsPath,
            canonicalPath: canonicalAbsPath,
            sizeBytes: fileSize,
            at: new Date().toISOString(),
          });
        }
      }
    }
  }

  // ② 孤儿文件:无行引用的 + convId 不存在的残留目录
  const { orphanCleaned, orphanBytes } = cleanOrphans(rows, activeConvIds, db);
  cleanedFiles += orphanCleaned;
  reclaimedBytes += orphanBytes;

  return { cleanedFiles, reclaimedBytes };
}

function cleanOrphans(
  rows: AttachmentRow[],
  activeConvIds: Set<number>,
  db: DatabaseSync
): { orphanCleaned: number; orphanBytes: number } {
  const filesBase = getFilesBaseDir();
  if (!existsSync(filesBase)) return { orphanCleaned: 0, orphanBytes: 0 };

  // 建立 convId → Set<storage_path> 的引用集合
  const convRefPaths = new Map<number, Set<string>>();
  for (const row of rows) {
    if (row.conversation_id === null) continue;
    if (!convRefPaths.has(row.conversation_id)) convRefPaths.set(row.conversation_id, new Set());
    convRefPaths.get(row.conversation_id)!.add(row.storage_path);
  }

  let orphanCleaned = 0;
  let orphanBytes = 0;

  let dirs: string[];
  try {
    dirs = readdirSync(filesBase);
  } catch {
    return { orphanCleaned: 0, orphanBytes: 0 };
  }

  for (const dirName of dirs) {
    const dirPath = path.join(filesBase, dirName);
    let stat;
    try { stat = statSync(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const convId = Number(dirName);
    if (isNaN(convId)) continue;

    if (!activeConvIds.has(convId)) {
      // 整个目录是残留(convId 已不存在):统计 + 删
      const { count, bytes } = measureDir(dirPath);
      if (count > 0) {
        rmSync(dirPath, { recursive: true, force: true });
        orphanCleaned += count;
        orphanBytes += bytes;

        insertAuditLog("dedup_delete_orphan_dir", {
          convId,
          dirPath,
          deletedFiles: count,
          sizeBytes: bytes,
          reason: "conversation_not_exist",
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    // convId 存在:找无行引用的文件
    const refPaths = convRefPaths.get(convId) ?? new Set();
    const { count, bytes } = deleteOrphanFilesInDir(dirPath, refPaths, "", convId, db);
    orphanCleaned += count;
    orphanBytes += bytes;
  }

  return { orphanCleaned, orphanBytes };
}

function measureDir(dir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) {
        count++;
        try { bytes += statSync(path.join(dir, entry.name)).size; } catch { /* ignore */ }
      } else if (entry.isDirectory()) {
        const sub = measureDir(path.join(dir, entry.name));
        count += sub.count;
        bytes += sub.bytes;
      }
    }
  } catch { /* ignore */ }
  return { count, bytes };
}

function deleteOrphanFilesInDir(
  dir: string,
  refPaths: Set<string>,
  relBase: string,
  convId: number,
  db: DatabaseSync
): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (!refPaths.has(relPath)) {
          // 无行引用 → 孤儿
          let fileSize = 0;
          try { fileSize = statSync(absPath).size; } catch { /* ignore */ }
          unlinkSync(absPath);
          count++;
          bytes += fileSize;

          insertAuditLog("dedup_delete_orphan_file", {
            convId,
            filePath: absPath,
            relPath,
            sizeBytes: fileSize,
            reason: "no_attachment_row_reference",
            at: new Date().toISOString(),
          });
        }
      } else if (entry.isDirectory()) {
        const sub = deleteOrphanFilesInDir(absPath, refPaths, relPath, convId, db);
        count += sub.count;
        bytes += sub.bytes;
      }
    }
  } catch { /* ignore */ }
  return { count, bytes };
}
