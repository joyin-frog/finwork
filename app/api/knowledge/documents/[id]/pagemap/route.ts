import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeDocumentById } from "@/lib/db/sqlite";
import { readTextMirror } from "@/lib/knowledge/storage";
import { buildPdfPageMap } from "@/lib/knowledge/parsers";

/**
 * PDF 行级页码映射:解析存好的文本镜像(检索所依据的同一份文本)里的 `--- Page N ---` 标记,
 * 返回 lineMeta(镜像第 i 行 → { page } 或 null)。供"搜索命中行 → 跳到原文那一页"。
 * 非 PDF / 镜像丢失 → lineMeta = null(前端据此降级:只开文件、不跳)。
 */
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

  const isPdf = doc.mime_type === "application/pdf" || (doc.file_name ?? "").toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json({ ok: true, data: { lineMeta: null } });
  }

  const text = readTextMirror(doc.content_hash);
  if (text === null) {
    return NextResponse.json({ ok: true, data: { lineMeta: null } });
  }

  return NextResponse.json({ ok: true, data: { lineMeta: buildPdfPageMap(text) } });
}
