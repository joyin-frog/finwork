import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeDocumentById, setKnowledgeArchived, setKnowledgeDocumentMeta } from "@/lib/db/sqlite";
import { deleteDocument } from "@/lib/knowledge/pipeline";
import { deleteStoredFile, deleteTextMirror } from "@/lib/knowledge/storage";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const docId = Number(id);
    const body = await req.json().catch(() => ({}));

    if (!getKnowledgeDocumentById(docId)) {
      return NextResponse.json({ ok: false, error: "文档不存在" }, { status: 404 });
    }

    // P1 合同归纳: metadata + meta_status 写入
    if ("metaStatus" in body || "metadata" in body) {
      const validStatuses = ["none", "draft", "confirmed"] as const;
      const metaStatus: "none" | "draft" | "confirmed" =
        validStatuses.includes(body.metaStatus) ? body.metaStatus : "draft";
      const metadata = body.metadata !== undefined ? body.metadata : null;
      setKnowledgeDocumentMeta(docId, metadata, metaStatus);
      return NextResponse.json({ ok: true });
    }

    // 归档/取消归档
    if (typeof body.archived !== "boolean") {
      return NextResponse.json({ ok: false, error: "缺少 archived 布尔字段或 metaStatus 字段" }, { status: 400 });
    }
    setKnowledgeArchived(docId, body.archived);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const docId = Number(id);

    const doc = getKnowledgeDocumentById(docId);
    if (doc?.content_hash) {
      deleteTextMirror(doc.content_hash);
    }
    if (doc?.storage_path) {
      deleteStoredFile(doc.storage_path);
    }

    deleteDocument(docId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
