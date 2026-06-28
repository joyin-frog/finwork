import { readFileSync } from "node:fs";
import {
  deleteKnowledgeDocument,
  getKnowledgeDocumentByFileName,
  getKnowledgeDocumentById,
  getDb,
  insertKnowledgeDocument,
  updateKnowledgeDocumentMetadata,
} from "@/lib/db/sqlite";
import { parseDocument } from "./parsers";
import type { KnowledgeCategory } from "./types";
import { inferCategoryFromDocument } from "./category";
import { writeTextMirror, deleteTextMirror, computeFileHash } from "./storage";

export async function ingestDocument(params: {
  filePath: string;
  title: string;
  fileName: string;
  mimeType: string;
  category?: KnowledgeCategory;
  sizeBytes: number;
  storagePath?: string;
  onProgress?: (stage: string, percent: number) => void;
}): Promise<{ documentId: number; chunkCount: number }> {
  const { filePath, title, fileName, mimeType, category, sizeBytes, storagePath, onProgress } = params;

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
    if (oldDoc.content_hash !== contentHash) {
      // Hash changed, delete old text mirror
      deleteTextMirror(oldDoc.content_hash);
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

  onProgress?.("完成", 100);
  return { documentId, chunkCount: 0 };
}

export function deleteDocument(documentId: number): void {
  const doc = getKnowledgeDocumentById(documentId);
  if (doc?.content_hash) {
    deleteTextMirror(doc.content_hash);
  }
  deleteKnowledgeDocument(documentId);
}
