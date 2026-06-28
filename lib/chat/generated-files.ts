import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { getDb, insertAuditLog, insertChatAttachment } from "@/lib/db/sqlite";
import { getConversationFilesDir } from "@/lib/runtime/paths";
import { FINALIZED_MARKER } from "@/lib/agent/mcp-tools/finalize-deliverable";

export function snapshotGeneratedFiles(conversationId: number | undefined): Set<string> {
  if (!conversationId) return new Set();
  return new Set(listGeneratedFilePaths(conversationId));
}

export function recordNewGeneratedFiles(
  conversationId: number | undefined,
  messageId: number | undefined,
  before: Set<string>
) {
  const files: Array<{ name: string; mimeType: string; sizeBytes: number }> = [];
  if (!conversationId) return files;

  const existing = getAllAttachmentStoragePaths(conversationId);
  for (const filePath of listGeneratedFilePaths(conversationId).filter((file) => !before.has(file))) {
    try {
      const stat = statSync(filePath);
      const name = path.basename(filePath);
      const storagePath = toConversationStoragePath(conversationId, filePath);
      files.push({ name, mimeType: guessMimeType(name), sizeBytes: stat.size });
      if (messageId && !existing.has(storagePath)) {
        insertChatAttachment({
          id: randomUUID(),
          messageId,
          fileName: name,
          mimeType: guessMimeType(name),
          sizeBytes: stat.size,
          storagePath,
          role: "assistant"
        });
        existing.add(storagePath);
      }
    } catch {
      // File may disappear between scan and stat.
    }
  }
  return files;
}

/** 成功收尾时的清理:若本回合调用过 finalize_deliverable(写了 .finalized.json),删掉本回合在
 * generate/ 下「新建、但未被声明为最终产物」的中间/试错文件;声明清单、往次产物、会话上传输入都不删。
 * 无声明标记 → 全部保留(保守)。删除落 audit_logs(红线8)。仅在成功收尾调用,未完成/出错时不清理。 */
export function cleanupUnfinalizedFiles(conversationId: number | undefined, before: Set<string>): string[] {
  if (!conversationId) return [];
  const outputDir = path.join(getConversationFilesDir(conversationId), "generate");
  const markerPath = path.join(outputDir, FINALIZED_MARKER);
  if (!existsSync(markerPath)) return []; // 本回合没声明最终产物 → 全留

  let declared: Set<string>;
  try {
    const arr = JSON.parse(readFileSync(markerPath, "utf8")) as string[];
    declared = new Set(arr.map((n) => path.basename(n)));
  } catch {
    try { rmSync(markerPath, { force: true }); } catch { /* ignore */ }
    return [];
  }

  const genRoot = path.resolve(outputDir);
  const deleted: string[] = [];
  for (const filePath of listGeneratedFilePaths(conversationId)) {
    const abs = path.resolve(filePath);
    if (!abs.startsWith(genRoot + path.sep)) continue;   // 只动 generate/ 下;upload/ 输入永不碰
    if (before.has(filePath)) continue;                   // 回合前已存在(往次产物)→ 保留
    if (declared.has(path.basename(filePath))) continue;  // 已声明的成品 → 保留
    try { rmSync(filePath, { force: true }); deleted.push(path.basename(filePath)); } catch { /* 占用/已删:忽略 */ }
  }
  try { rmSync(markerPath, { force: true }); } catch { /* ignore */ }

  if (deleted.length) {
    insertAuditLog("generated_files_cleanup", {
      conversationId,
      finalized: Array.from(declared),
      deleted,
      networked: false,
      at: new Date().toISOString(),
    });
  }
  return deleted;
}

export function syncGeneratedAttachments(conversationId: number) {
  const messageId = getLatestAssistantMessageId(conversationId);
  if (!messageId) return 0;

  const existing = getAllAttachmentStoragePaths(conversationId);
  let inserted = 0;
  for (const filePath of listGeneratedFilePaths(conversationId)) {
    try {
      const stat = statSync(filePath);
      const name = path.basename(filePath);
      const storagePath = toConversationStoragePath(conversationId, filePath);
      if (existing.has(storagePath)) continue;
      insertChatAttachment({
        id: randomUUID(),
        messageId,
        fileName: name,
        mimeType: guessMimeType(name),
        sizeBytes: stat.size,
        storagePath,
        role: "assistant"
      });
      existing.add(storagePath);
      inserted += 1;
    } catch {
      // Best-effort repair.
    }
  }
  return inserted;
}

function listGeneratedFilePaths(conversationId: number) {
  const root = getConversationFilesDir(conversationId);
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // 跳过系统/隐藏文件(.DS_Store 等),否则会被当成"生成产物"
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      // 注意:不再排除 upload/。模型有时会把产物写到输入文件旁边(upload/),
      // 由 before/after 快照差集兜底——上传的输入文件在 before 快照里、不会被误记为产物,
      // 而回合内新增的文件(无论落 generate/ 还是 upload/)都能被追踪、展示到对话与面板。
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

// 返回该会话所有附件(user + assistant)的 storage_path。
// 生成文件登记去重用它:已是任何附件(尤其用户上传)的文件不再被补登记成 assistant,
// 修复"上传文件被 syncGeneratedAttachments 误记为生成"的 bug。
function getAllAttachmentStoragePaths(conversationId: number) {
  const rows = getDb()
    .prepare(`
      SELECT storage_path
      FROM chat_attachments
      WHERE message_id IN (SELECT id FROM chat_messages WHERE conversation_id = ?)
    `)
    .all(conversationId) as Array<{ storage_path: string }>;
  return new Set(rows.map((row) => row.storage_path));
}

function getLatestAssistantMessageId(conversationId: number) {
  const row = getDb()
    .prepare("SELECT id FROM chat_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get(conversationId) as { id: number } | undefined;
  return row?.id;
}

function toConversationStoragePath(conversationId: number, filePath: string) {
  return path.relative(getConversationFilesDir(conversationId), filePath).split(path.sep).join("/");
}

function guessMimeType(fileName: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".html": "text/html"
  };
  return map[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
