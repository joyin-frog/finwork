import { readFileSync } from "node:fs";
import {
  deleteKnowledgeDocument,
  countKnowledgeDocumentsByContentHash,
  countKnowledgeDocumentsByStoragePath,
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
import {
  canonicalStoragePathKey,
  computeFileHash,
  deleteStoredFile,
  deleteTextMirror,
  hasActiveKnowledgeHashLease,
  hasActiveKnowledgePathLease,
  writeTextMirror,
} from "./storage";
import {
  getProductionRetrievalService,
  type ProductionRetrievalService,
} from "@/lib/retrieval/production";

function retrievalService(): ProductionRetrievalService {
  return getProductionRetrievalService();
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

  // 文本镜像只服务预览与旧数据迁移；生产检索的权威源是不可变 Artifact。
  onProgress?.("写入预览文本", 55);
  writeTextMirror(contentHash, text);

  if (oldDoc) {
    const hashChanged = oldDoc.content_hash !== contentHash;
    const nextStoragePath = storagePath ?? oldDoc.storage_path;
    const db = getDb();

    onProgress?.("建立受控检索索引", 75);
    try {
      await retrievalService().indexKnowledgeDocument({
        knowledgeDocumentId: oldDoc.id,
        title,
        fileName,
        sourceContentHash: contentHash,
        parsedText: text,
        category: resolvedCategory,
        beforeActivate: () => {
          updateKnowledgeDocumentMetadata(oldDoc.id, {
            title,
            file_name: fileName,
            mime_type: mimeType,
            category: resolvedCategory,
            size_bytes: sizeBytes,
            content_hash: contentHash,
            storage_path: nextStoragePath,
          });
          db.prepare("UPDATE knowledge_documents SET chunk_count = 0 WHERE id = ?").run(oldDoc.id);
        },
      });
    } catch (error) {
      if (hashChanged && countKnowledgeDocumentsByContentHash(contentHash, db) === 0) deleteTextMirror(contentHash);
      throw error;
    }

    // DB 已切换到新副本后再清理旧路径；历史共享/外部路径由 containment 守卫拒删。
    if (
      oldDoc.storage_path &&
      canonicalStoragePathKey(oldDoc.storage_path) !== canonicalStoragePathKey(nextStoragePath) &&
      countKnowledgeDocumentsByStoragePath(oldDoc.storage_path, db) === 0 &&
      !hasActiveKnowledgePathLease(oldDoc.storage_path)
    ) {
      deleteStoredFile(oldDoc.storage_path);
    }
    if (
      hashChanged &&
      oldDoc.content_hash &&
      countKnowledgeDocumentsByContentHash(oldDoc.content_hash, db) === 0 &&
      !hasActiveKnowledgeHashLease(oldDoc.content_hash)
    ) {
      deleteTextMirror(oldDoc.content_hash);
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

  onProgress?.("建立受控检索索引", 85);
  try {
    await retrievalService().indexKnowledgeDocument({
      knowledgeDocumentId: documentId,
      title,
      fileName,
      sourceContentHash: contentHash,
      parsedText: text,
      category: resolvedCategory,
    });
  } catch (error) {
    deleteKnowledgeDocument(documentId);
    if (countKnowledgeDocumentsByContentHash(contentHash, getDb()) === 0) deleteTextMirror(contentHash);
    throw error;
  }

  onProgress?.("完成", 100);
  return { documentId, chunkCount: 0 };
}

export function deleteDocument(documentId: number): void {
  const db = getDb();
  const doc = getKnowledgeDocumentById(documentId);
  // 先吊销检索 ACL/缓存，再删除业务行；吊销失败时禁止继续删除。
  getProductionRetrievalService().revokeKnowledgeDocument(documentId);
  // WP1b 写钩子：删文档前先清 fact_obligations 行（防悬空义务）
  db.prepare("DELETE FROM fact_obligations WHERE source_document_id = ?").run(documentId);
  deleteKnowledgeDocument(documentId);
  if (
    doc?.content_hash &&
    countKnowledgeDocumentsByContentHash(doc.content_hash, db) === 0 &&
    !hasActiveKnowledgeHashLease(doc.content_hash)
  ) {
    deleteTextMirror(doc.content_hash);
  }
}
