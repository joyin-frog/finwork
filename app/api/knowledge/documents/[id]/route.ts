import { NextRequest, NextResponse } from "next/server";
import { getDb, getKnowledgeDocumentById, listConfirmedMetaDocRows, setKnowledgeArchived, setKnowledgeDocumentMeta } from "@/lib/db/sqlite";
import { deleteDocument } from "@/lib/knowledge/pipeline";
import { deleteStoredFile, deleteTextMirror } from "@/lib/knowledge/storage";
import { deriveCashObligations, persistDerivedObligations } from "@/lib/domain/cash-obligations";
import type { DocMetadata, MetaStatus } from "@/lib/knowledge/types";

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
      const db = getDb();
      setKnowledgeDocumentMeta(docId, metadata, metaStatus, db);

      // WP1b 写钩子：confirmed → 重派生落盘；none/draft → 清行
      if (metaStatus === "confirmed") {
        const confirmedRows = listConfirmedMetaDocRows(db);
        const docRow = confirmedRows.find(r => r.id === docId);
        if (docRow) {
          let meta: DocMetadata | null = null;
          try { meta = JSON.parse(docRow.metadata) as DocMetadata; } catch { meta = null; }
          const obls = deriveCashObligations([{
            id: docRow.id,
            fileName: docRow.file_name,
            metadata: meta,
            metaStatus: docRow.meta_status as MetaStatus,
          }]);
          persistDerivedObligations(docId, obls, db);
        }
      } else {
        // none / draft → 清行（降级）
        db.prepare("DELETE FROM fact_obligations WHERE source_document_id = ?").run(docId);
      }

      return NextResponse.json({ ok: true });
    }

    // 归档/取消归档
    if (typeof body.archived !== "boolean") {
      return NextResponse.json({ ok: false, error: "缺少 archived 布尔字段或 metaStatus 字段" }, { status: 400 });
    }
    const db = getDb();
    setKnowledgeArchived(docId, body.archived, db);

    // WP1b 写钩子：归档 → 清行；取消归档 → 重派生落盘（若仍 confirmed）
    if (body.archived) {
      db.prepare("DELETE FROM fact_obligations WHERE source_document_id = ?").run(docId);
    } else {
      const confirmedRows = listConfirmedMetaDocRows(db);
      const docRow = confirmedRows.find(r => r.id === docId);
      if (docRow) {
        let meta: DocMetadata | null = null;
        try { meta = JSON.parse(docRow.metadata) as DocMetadata; } catch { meta = null; }
        const obls = deriveCashObligations([{
          id: docRow.id,
          fileName: docRow.file_name,
          metadata: meta,
          metaStatus: docRow.meta_status as MetaStatus,
        }]);
        persistDerivedObligations(docId, obls, db);
      }
    }

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
