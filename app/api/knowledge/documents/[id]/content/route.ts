import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeDocumentById } from "@/lib/db/sqlite";
import { readTextMirror } from "@/lib/knowledge/storage";

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

  const text = readTextMirror(doc.content_hash);
  if (text === null) {
    return NextResponse.json({ error: "文本镜像丢失，请重新上传文档" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    data: {
      title: doc.title,
      fileName: doc.file_name,
      mimeType: doc.mime_type,
      text,
    },
  });
}
