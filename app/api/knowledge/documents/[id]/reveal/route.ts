/**
 * POST /api/knowledge/documents/[id]/reveal
 *
 * 在系统文件管理器中显示知识库文档所在目录。
 */

import { NextResponse } from "next/server";
import path from "node:path";
import { existsSync } from "node:fs";
import { getDb, insertAuditLog } from "@/lib/db/sqlite";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const docId = Number(id);
    if (!Number.isFinite(docId)) {
      return NextResponse.json({ ok: false, error: "无效的文档 ID" }, { status: 400 });
    }

    const db = getDb();
    const row = db
      .prepare("SELECT storage_path FROM knowledge_documents WHERE id = ?")
      .get(docId) as { storage_path: string } | undefined;

    if (!row?.storage_path) {
      return NextResponse.json({ ok: false, error: "文档不存在" }, { status: 404 });
    }
    if (!existsSync(row.storage_path)) {
      return NextResponse.json({ ok: false, error: "文件不存在" }, { status: 404 });
    }

    await revealInFileManager(row.storage_path);
    insertAuditLog("knowledge_reveal", {
      docId,
      path: row.storage_path,
      at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

function revealInFileManager(filePath: string): Promise<void> {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const command =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "explorer" :
    "xdg-open";
  const args =
    process.platform === "darwin" ? ["-R", filePath] :
    process.platform === "win32" ? ["/select,", filePath] :
    [path.dirname(filePath)];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}
