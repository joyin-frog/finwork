/**
 * 统一文件库 API
 *
 * GET  /api/files-library           列出所有文件(支持 kind/q/sort 参数)
 * POST /api/files-library           动作:keep / delete / reveal / export / promote / analyze-duplicates / cleanup-duplicates
 *
 * 红线约束:
 * - 红线 5: delete/cleanup-duplicates 动作需前端已确认(API 只执行)
 * - 红线 7: export/promote 仅操作本地路径,不上传任何文件
 * - 红线 8: delete/keep/export/promote/cleanup-duplicates 动作落 audit_logs
 */

import { NextResponse } from "next/server";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, copyFile, mkdir } from "node:fs/promises";
import {
  listAllFiles,
  setAttachmentKept,
  deleteLibraryFile,
  insertAuditLog,
  getKnowledgeDocumentByHash,
} from "@/lib/db/sqlite";
import { analyzeConversationDuplicates, cleanupConversationDuplicates } from "@/lib/maintenance/dedup";
import { getConversationFilesDir } from "@/lib/runtime/paths";
import { ingestDocument } from "@/lib/knowledge/pipeline";
import { computeFileHash } from "@/lib/knowledge/storage";
import type { ListFilesOptions } from "@/lib/db/sqlite";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);

    // 下载文件字节(供「添加到对话」用):本机读盘返回给本地 webview,不外发(红线7);落审计(红线8)
    const downloadId = url.searchParams.get("download");
    if (downloadId) {
      const abs = resolveFilePath(downloadId);
      if (!abs) return NextResponse.json({ ok: false, error: "文件不存在" }, { status: 404 });
      const buf = await readFile(abs);
      const fileName = path.basename(abs);
      insertAuditLog("file_download", { fileId: downloadId, path: abs, at: new Date().toISOString() });
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "content-type": guessMimeByExt(path.extname(fileName)),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        },
      });
    }

    const kind = url.searchParams.get("kind") as ListFilesOptions["kind"] | null;
    const q = url.searchParams.get("q") ?? undefined;
    const sort = (url.searchParams.get("sort") ?? "date") as ListFilesOptions["sort"];

    const files = listAllFiles({
      kind: kind ?? undefined,
      q,
      sort,
    });

    return NextResponse.json({ ok: true, data: { files } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action: "keep" | "delete" | "reveal" | "export" | "promote" | "analyze-duplicates" | "cleanup-duplicates";
      fileId?: string;
      kept?: boolean;
      destPath?: string;
    };

    const { action } = body;
    if (!action) {
      return NextResponse.json({ ok: false, error: "Missing action" }, { status: 400 });
    }

    // ─── 去重分析(只读) ──────────────────────────────────────────────────────
    if (action === "analyze-duplicates") {
      const analysis = analyzeConversationDuplicates();
      return NextResponse.json({ ok: true, data: analysis });
    }

    // ─── 去重清理(写,前端须已确认;红线 5) ────────────────────────────────────
    if (action === "cleanup-duplicates") {
      // 红线 5:前端必须已经过用户确认再调用此接口
      insertAuditLog("dedup_cleanup_start", { at: new Date().toISOString() });
      const result = cleanupConversationDuplicates();
      insertAuditLog("dedup_cleanup_done", { ...result, at: new Date().toISOString() });
      return NextResponse.json({ ok: true, data: result });
    }

    const fileId = body.fileId;
    if (!fileId) {
      return NextResponse.json({ ok: false, error: "Missing fileId" }, { status: 400 });
    }

    if (action === "keep") {
      if (!fileId.startsWith("attach:")) {
        return NextResponse.json({ ok: false, error: "只能对对话附件标保留" }, { status: 400 });
      }
      const kept = body.kept ?? true;
      const attachmentId = fileId.slice(7);
      setAttachmentKept(attachmentId, kept);
      return NextResponse.json({ ok: true });
    }

    if (action === "delete") {
      // 红线 5: 前端必须已经过用户确认
      deleteLibraryFile(fileId);
      return NextResponse.json({ ok: true });
    }

    if (action === "reveal") {
      const absPath = resolveFilePath(fileId);
      if (!absPath) return NextResponse.json({ ok: false, error: "文件不存在" }, { status: 404 });
      await revealInFileManager(absPath);
      insertAuditLog("file_reveal", { fileId, path: absPath, at: new Date().toISOString() });
      return NextResponse.json({ ok: true });
    }

    if (action === "export") {
      const destPath = body.destPath;
      if (!destPath || !path.isAbsolute(destPath)) {
        return NextResponse.json({ ok: false, error: "destPath 必须是绝对路径" }, { status: 400 });
      }
      const srcPath = resolveFilePath(fileId);
      if (!srcPath) return NextResponse.json({ ok: false, error: "源文件不存在" }, { status: 404 });
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      insertAuditLog("file_export", { fileId, srcPath, destPath, at: new Date().toISOString() });
      return NextResponse.json({ ok: true });
    }

    if (action === "promote") {
      // 红线 7: 全本地, 不外发; 红线 8: 落审计
      // 只允许 upload / generated 类型(kind != knowledge)
      if (!fileId.startsWith("attach:") && !fileId.startsWith("lib:")) {
        return NextResponse.json({ ok: false, error: "只能对上传/生成文件执行加入知识库操作" }, { status: 400 });
      }

      const absPath = resolveFilePath(fileId);
      if (!absPath) return NextResponse.json({ ok: false, error: "文件不存在" }, { status: 404 });

      // 读文件，先检查 content_hash 去重
      const fileBuffer = await readFile(absPath);
      const contentHash = computeFileHash(fileBuffer);
      const existing = getKnowledgeDocumentByHash(contentHash);

      if (existing) {
        // 已存在相同内容, 优雅提示不重复入库
        insertAuditLog("file_promote_skip", {
          fileId,
          absPath,
          contentHash,
          existingDocId: existing.id,
          at: new Date().toISOString(),
        });
        return NextResponse.json({ ok: true, alreadyExists: true, documentId: existing.id });
      }

      const fileName = path.basename(absPath);
      const ext = path.extname(fileName).toLowerCase();
      const mimeType = guessMimeByExt(ext);
      const sizeBytes = fileBuffer.byteLength;

      const { documentId } = await ingestDocument({
        filePath: absPath,
        title: fileName,
        fileName,
        mimeType,
        sizeBytes,
        storagePath: absPath,
      });

      insertAuditLog("file_promoted", {
        fileId,
        absPath,
        documentId,
        at: new Date().toISOString(),
      });

      return NextResponse.json({ ok: true, documentId });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/**
 * 根据 fileId 前缀解析文件绝对路径。
 */
function resolveFilePath(fileId: string): string | null {
  const { getDb } = require("@/lib/db/sqlite") as typeof import("@/lib/db/sqlite");
  const nodePath = require("node:path") as typeof import("node:path");
  const db = getDb();

  if (fileId.startsWith("lib:")) {
    const id = fileId.slice(4);
    const row = db.prepare("SELECT storage_path FROM library_files WHERE id = ?").get(id) as { storage_path: string } | undefined;
    if (!row || !row.storage_path) return null;
    return existsSync(row.storage_path) ? row.storage_path : null;
  }

  if (fileId.startsWith("attach:")) {
    const id = fileId.slice(7);
    const row = db.prepare(`
      SELECT a.storage_path, m.conversation_id
      FROM chat_attachments a
      LEFT JOIN chat_messages m ON a.message_id = m.id
      WHERE a.id = ?
    `).get(id) as { storage_path: string; conversation_id: number | null } | undefined;
    if (!row) return null;
    if (row.conversation_id) {
      const abs = nodePath.join(getConversationFilesDir(row.conversation_id), row.storage_path);
      return existsSync(abs) ? abs : null;
    }
    return row.storage_path && existsSync(row.storage_path) ? row.storage_path : null;
  }

  if (fileId.startsWith("know:")) {
    const id = Number(fileId.slice(5));
    const row = db.prepare("SELECT storage_path FROM knowledge_documents WHERE id = ?").get(id) as { storage_path: string } | undefined;
    if (!row || !row.storage_path) return null;
    return existsSync(row.storage_path) ? row.storage_path : null;
  }

  return null;
}

/** 按扩展名推断 MIME 类型(promote 用,精度够用即可) */
function guessMimeByExt(ext: string): string {
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function revealInFileManager(filePath: string): Promise<void> {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const args = process.platform === "darwin"
    ? ["-R", filePath]
    : process.platform === "win32"
      ? ["/select,", filePath]
      : [path.dirname(filePath)];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}
