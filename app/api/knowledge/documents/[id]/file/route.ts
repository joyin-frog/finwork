import { existsSync, readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeDocumentById } from "@/lib/db/sqlite";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const docId = Number(id);
  if (!Number.isFinite(docId) || docId < 1) {
    return NextResponse.json({ error: "无效的文档 ID" }, { status: 400 });
  }

  const doc = getKnowledgeDocumentById(docId);
  if (!doc) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }

  const filePath = doc.storage_path;
  if (!filePath || !existsSync(filePath)) {
    return NextResponse.json({ error: "文件丢失" }, { status: 404 });
  }

  const buffer = readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": doc.mime_type || "application/octet-stream",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
