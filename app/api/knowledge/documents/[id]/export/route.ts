/**
 * POST /api/knowledge/documents/[id]/export
 *
 * 知识库文档另存为本地路径(红线 7:仅本机存储,不外发)。
 * 由 Tauri 保存对话框提供 destPath。
 */

import { NextResponse } from "next/server";
import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { getDb, insertAuditLog } from "@/lib/db/sqlite";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const docId = Number(id);
    if (!Number.isFinite(docId)) {
      return NextResponse.json({ ok: false, error: "无效的文档 ID" }, { status: 400 });
    }

    const body = (await request.json()) as { destPath?: string };
    const { destPath } = body;
    if (!destPath || !path.isAbsolute(destPath)) {
      return NextResponse.json({ ok: false, error: "destPath 必须是绝对路径" }, { status: 400 });
    }

    const db = getDb();
    const row = db
      .prepare("SELECT storage_path FROM knowledge_documents WHERE id = ?")
      .get(docId) as { storage_path: string } | undefined;

    if (!row?.storage_path) {
      return NextResponse.json({ ok: false, error: "文档不存在" }, { status: 404 });
    }
    if (!existsSync(row.storage_path)) {
      return NextResponse.json({ ok: false, error: "源文件不存在" }, { status: 404 });
    }

    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(row.storage_path, destPath);

    insertAuditLog("knowledge_export", {
      docId,
      srcPath: row.storage_path,
      destPath,
      at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
