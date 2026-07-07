import { readFileSync } from "node:fs";
import {
  deleteKnowledgeDocument,
  getKnowledgeDocumentByFileName,
  getKnowledgeDocumentById,
  getDb,
  insertKnowledgeDocument,
  updateKnowledgeDocumentMetadata,
} from "@/lib/db/sqlite";
// WP1b: 删文档时同步清 fact_obligations 行
import { parseDocument } from "./parsers";
import type { KnowledgeCategory } from "./types";
import { inferCategoryFromDocument } from "./category";
import { writeTextMirror, deleteTextMirror, computeFileHash } from "./storage";
import { chunkText } from "./chunker";
import { embedTexts, storeEmbeddings, deleteEmbeddings, type EmbedRunner } from "./embeddings";
import { EMBED_MODEL } from "./embed-model";

/** 建立语义索引（切块 → embed → 落库），任何失败静默降级不阻断入库 */
async function buildSemanticIndex(
  documentId: number,
  text: string,
  runner?: EmbedRunner
): Promise<void> {
  try {
    const db = getDb();
    const chunks = chunkText(text);
    if (chunks.length === 0) return;
    const vectors = await embedTexts(chunks, runner);
    if (!vectors || vectors.length === 0) return;
    storeEmbeddings(db, documentId, chunks, vectors, EMBED_MODEL);
  } catch (err) {
    console.warn("[knowledge/pipeline] 语义索引建立失败（降级，不影响入库）:", err instanceof Error ? err.message : String(err));
  }
}

export async function ingestDocument(params: {
  filePath: string;
  title: string;
  fileName: string;
  mimeType: string;
  category?: KnowledgeCategory;
  sizeBytes: number;
  storagePath?: string;
  onProgress?: (stage: string, percent: number) => void;
  /** 可注入 embed runner（测试用）；未提供则走真实 worker */
  embedRunner?: EmbedRunner;
}): Promise<{ documentId: number; chunkCount: number }> {
  const { filePath, title, fileName, mimeType, category, sizeBytes, storagePath, onProgress, embedRunner } = params;

  onProgress?.("计算文件哈希", 5);
  const fileBuffer = readFileSync(filePath);
  const contentHash = computeFileHash(fileBuffer);
  const oldDoc = getKnowledgeDocumentByFileName(fileName);

  onProgress?.("解析文档", 20);
  const text = await parseDocument(filePath, mimeType);
  const resolvedCategory = category ?? inferCategoryFromDocument({ fileName, title, text });

  if (!text.trim()) throw new Error("文档内容为空，无法建立索引");

  // Write text mirror for ripgrep search
  onProgress?.("写入搜索索引", 60);
  writeTextMirror(contentHash, text);

  if (oldDoc) {
    const hashChanged = oldDoc.content_hash !== contentHash;
    if (hashChanged) {
      // Hash changed, delete old text mirror + embeddings
      deleteTextMirror(oldDoc.content_hash);
      try {
        const db = getDb();
        deleteEmbeddings(db, oldDoc.id);
      } catch {
        // 降级
      }
    }
    updateKnowledgeDocumentMetadata(oldDoc.id, {
      title,
      file_name: fileName,
      mime_type: mimeType,
      category: resolvedCategory,
      size_bytes: sizeBytes,
    });
    // chunk_count is kept as column but always 0 now
    const db = getDb();
    db.prepare("UPDATE knowledge_documents SET chunk_count = 0 WHERE id = ?").run(oldDoc.id);

    // 建立语义索引（hash 变化则重嵌；hash 不变则 embeddings 已存在，保留不动）
    if (hashChanged) {
      onProgress?.("建立语义索引", 85);
      await buildSemanticIndex(oldDoc.id, text, embedRunner);
    }

    onProgress?.("完成", 100);
    return { documentId: oldDoc.id, chunkCount: 0 };
  }

  // New document
  onProgress?.("写入数据库", 80);
  const documentId = insertKnowledgeDocument({
    title,
    file_name: fileName,
    mime_type: mimeType,
    category: resolvedCategory,
    size_bytes: sizeBytes,
    chunk_count: 0,
    content_hash: contentHash,
    storage_path: storagePath ?? "",
  });

  // 建立语义索引
  onProgress?.("建立语义索引", 90);
  await buildSemanticIndex(documentId, text, embedRunner);

  onProgress?.("完成", 100);
  return { documentId, chunkCount: 0 };
}

export function deleteDocument(documentId: number): void {
  const db = getDb();
  const doc = getKnowledgeDocumentById(documentId);
  if (doc?.content_hash) {
    deleteTextMirror(doc.content_hash);
  }
  // WP1b 写钩子：删文档前先清 fact_obligations 行（防悬空义务）
  db.prepare("DELETE FROM fact_obligations WHERE source_document_id = ?").run(documentId);
  // CASCADE 通常已处理 embeddings，兜底显式清（存量无 CASCADE 路径）
  deleteEmbeddings(db, documentId);
  deleteKnowledgeDocument(documentId);
}
