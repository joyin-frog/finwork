import { NextRequest, NextResponse } from "next/server";
import { countKnowledgeDocumentsByStoragePath, getDb, getKnowledgeDocumentById, listConfirmedMetaDocRows, setKnowledgeArchived, setKnowledgeDocumentMeta } from "@/lib/db/sqlite";
import { deleteDocument } from "@/lib/knowledge/pipeline";
import { deleteStoredFile, hasActiveKnowledgePathLease, readTextMirror } from "@/lib/knowledge/storage";
import { deriveCashObligations, persistDerivedObligations } from "@/lib/domain/cash-obligations";
import type { DocMetadata, MetaStatus } from "@/lib/knowledge/types";
import { ensureEmbedModel } from "@/lib/knowledge/embed-model";
import { getProductionRetrievalService } from "@/lib/retrieval/production";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const docId = Number(id);
    if (Number.isNaN(docId)) {
      return NextResponse.json({ ok: false, error: "文档 id 无效" }, { status: 400 });
    }
    const body = await req.json().catch(() => ({}));

    const knowledgeDocument = getKnowledgeDocumentById(docId);
    if (!knowledgeDocument) {
      return NextResponse.json({ ok: false, error: "文档不存在" }, { status: 404 });
    }

    // P1 合同归纳: metadata + meta_status 写入
    if ("metaStatus" in body || "metadata" in body) {
      const validStatuses = ["none", "draft", "confirmed"] as const;
      // 非法 metaStatus → 400，不做任何写（修复：之前静默降级 draft 并删义务）
      if ("metaStatus" in body && !validStatuses.includes(body.metaStatus)) {
        return NextResponse.json({ ok: false, error: `非法 metaStatus: ${body.metaStatus}` }, { status: 400 });
      }
      const metaStatus: "none" | "draft" | "confirmed" =
        validStatuses.includes(body.metaStatus) ? body.metaStatus : "draft";
      // metadata 不在 body 时传 undefined → setKnowledgeDocumentMeta 不覆盖该列
      const metadata = "metadata" in body ? body.metadata : undefined;
      const db = getDb();

      // WP1b 写钩子：setKnowledgeDocumentMeta + persistDerivedObligations 包进同一事务
      db.exec("BEGIN");
      try {
        setKnowledgeDocumentMeta(docId, metadata, metaStatus, db);

        // confirmed → 重派生落盘；none/draft → 清行
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
            persistDerivedObligations(docId, obls, db, { inTx: true });
          }
        } else {
          // none / draft → 清行（降级）
          db.prepare("DELETE FROM fact_obligations WHERE source_document_id = ?").run(docId);
        }

        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* 保留原始错误 */ }
        throw err;
      }

      return NextResponse.json({ ok: true });
    }

    // 归档/取消归档
    if (typeof body.archived !== "boolean") {
      return NextResponse.json({ ok: false, error: "缺少 archived 布尔字段或 metaStatus 字段" }, { status: 400 });
    }
    const db = getDb();
    const retrieval = getProductionRetrievalService();

    // 旧知识库数据可能尚未建立 Retrieval v2 绑定。恢复前必须先完成索引，
    // 不能把“界面已取消归档、Agent 仍不可见”的半状态暴露出去。
    if (!body.archived && !retrieval.hasKnowledgeBinding(docId)) {
      const model = await ensureEmbedModel();
      if (!model.ok) throw new Error(`检索模型不可用：${model.detail}`);
      const parsedText = readTextMirror(knowledgeDocument.content_hash);
      if (!parsedText) throw new Error("文档解析文本已丢失，请重新上传后再恢复");
      await retrieval.indexKnowledgeDocument({
        knowledgeDocumentId: docId,
        title: knowledgeDocument.title,
        fileName: knowledgeDocument.file_name,
        sourceContentHash: knowledgeDocument.content_hash,
        parsedText,
        category: knowledgeDocument.category,
        available: false,
      });
    }

    db.exec("BEGIN");
    try {
      if (body.archived) {
        retrieval.revokeKnowledgeDocument(docId, new Date().toISOString(), { inTransaction: true });
      } else {
        // 已有绑定时上面的恢复已经完成；再次调用是幂等的，并确保本事务内
        // 与知识库状态同步刷新 ACL revision 和查询缓存。
        retrieval.restoreKnowledgeDocument(docId, new Date().toISOString(), { inTransaction: true });
      }
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
          persistDerivedObligations(docId, obls, db, { inTx: true });
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
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
    if (Number.isNaN(docId)) {
      return NextResponse.json({ ok: false, error: "文档 id 无效" }, { status: 400 });
    }

    const doc = getKnowledgeDocumentById(docId);
    deleteDocument(docId);
    if (
      doc?.storage_path &&
      countKnowledgeDocumentsByStoragePath(doc.storage_path) === 0 &&
      !hasActiveKnowledgePathLease(doc.storage_path)
    ) {
      deleteStoredFile(doc.storage_path);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
