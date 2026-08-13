import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "@/lib/artifacts/store";
import type { PrincipalRef } from "@/lib/capability/common";
import {
  getDb,
  listActiveKnowledgeDocuments,
  markKnowledgeHits,
  type KnowledgeDocumentRow,
} from "@/lib/db/sqlite";
import { EMBED_MODEL } from "@/lib/knowledge/embed-model";
import { readTextMirror } from "@/lib/knowledge/storage";
import { getAppDataDir } from "@/lib/runtime/paths";
import type { RetrievalEmbedder, RetrievalHit, RetrievalSearchResponse } from "./contracts";
import { RetrievalError } from "./contracts";
import { PersistentEmbeddingPool } from "./embedding-pool";
import { defaultTextRetrievalParser, RetrievalIndexer } from "./indexer";
import { RetrievalSearchService } from "./search";

export const LOCAL_RETRIEVAL_PRINCIPAL: PrincipalRef = {
  id: "local-user",
  type: "user",
  tenantId: "local",
};

type KnowledgeBindingRow = {
  knowledge_document_id: number;
  artifact_id: string;
  artifact_version_id: string;
  retrieval_document_id: string;
  source_content_hash: string;
  indexed_at: string;
  index_status: string;
};

export type IndexKnowledgeDocumentRequest = {
  knowledgeDocumentId: number;
  title: string;
  fileName: string;
  sourceContentHash: string;
  parsedText: string;
  category: string;
  now?: string;
  /** false 用于归档数据迁移：完成索引但不向当前用户开放。 */
  available?: boolean;
  /** 与检索版本切换处于同一数据库事务，用于同步更新知识库元数据。 */
  beforeActivate?: () => void;
};

export type IndexKnowledgeDocumentResult = {
  artifactId: string;
  artifactVersionId: string;
  retrievalDocumentId: string;
  reused: boolean;
};

export type KnowledgeSearchMatch = {
  lineNo: number;
  line: string;
  before: string[];
  after: string[];
  ranges: Array<[number, number]>;
};

export type KnowledgeSearchFile = {
  docId: number;
  title: string;
  fileName: string;
  category: string;
  hitCount: number;
  matches: KnowledgeSearchMatch[];
  titleHit?: boolean;
};

export type KnowledgeSearchApiResult = {
  ok: true;
  data: {
    files: KnowledgeSearchFile[];
    totalFiles: number;
    truncated: boolean;
    elapsedMs: number;
  };
};

export type ProductionRetrievalServiceOptions = {
  db: DatabaseSync;
  artifacts: ArtifactStore;
  embedder: RetrievalEmbedder;
  principal?: PrincipalRef;
};

function bindingFor(db: DatabaseSync, knowledgeDocumentId: number): KnowledgeBindingRow | undefined {
  return db.prepare(`
    SELECT b.*, d.index_status
    FROM knowledge_retrieval_bindings b
    JOIN retrieval_documents d ON d.document_id=b.retrieval_document_id
    WHERE b.knowledge_document_id=?
  `).get(knowledgeDocumentId) as KnowledgeBindingRow | undefined;
}

function artifactIdFor(knowledgeDocumentId: number): string {
  return `knowledge-${knowledgeDocumentId}`;
}

function clearRetrievalCache(db: DatabaseSync): void {
  db.prepare("DELETE FROM retrieval_query_cache").run();
}

function revokeDocumentInTransaction(db: DatabaseSync, retrievalDocumentId: string, at: string, status: "stale" | "revoked"): void {
  db.prepare("UPDATE retrieval_chunks SET active=0 WHERE document_id=?").run(retrievalDocumentId);
  db.prepare(`
    UPDATE retrieval_documents
    SET index_status=?, permission_revision=permission_revision+1, updated_at=?
    WHERE document_id=?
  `).run(status, at, retrievalDocumentId);
  db.prepare(`
    UPDATE retrieval_document_acl SET revoked_at=?
    WHERE document_id=? AND revoked_at IS NULL
  `).run(at, retrievalDocumentId);
}

export class ProductionRetrievalService {
  readonly db: DatabaseSync;
  readonly artifacts: ArtifactStore;
  readonly embedder: RetrievalEmbedder;
  readonly principal: PrincipalRef;
  readonly indexer: RetrievalIndexer;
  readonly searchService: RetrievalSearchService;

  constructor(options: ProductionRetrievalServiceOptions) {
    this.db = options.db;
    this.artifacts = options.artifacts;
    this.embedder = options.embedder;
    this.principal = options.principal ?? LOCAL_RETRIEVAL_PRINCIPAL;
    this.indexer = new RetrievalIndexer(this.db, this.artifacts, defaultTextRetrievalParser, this.embedder);
    this.searchService = new RetrievalSearchService(this.db);
  }

  hasKnowledgeBinding(knowledgeDocumentId: number): boolean {
    return Boolean(bindingFor(this.db, knowledgeDocumentId));
  }

  async indexKnowledgeDocument(request: IndexKnowledgeDocumentRequest): Promise<IndexKnowledgeDocumentResult> {
    const at = request.now ?? new Date().toISOString();
    const available = request.available ?? true;
    const indexingPrincipal = available
      ? this.principal
      : { id: "__retrieval_staging__", type: "service" as const, tenantId: this.principal.tenantId };
    if (!request.parsedText.trim()) throw new RetrievalError("parser_failed", "knowledge document text is empty");
    const current = bindingFor(this.db, request.knowledgeDocumentId);
    if (current?.source_content_hash === request.sourceContentHash && current.index_status === "ready") {
      this.db.exec("BEGIN");
      try {
        request.beforeActivate?.();
        this.db.prepare(`
          UPDATE retrieval_documents
          SET title=?, document_type=?, classification='internal', updated_at=?
          WHERE document_id=?
        `).run(request.title, request.category, at, current.retrieval_document_id);
        this.db.prepare(`UPDATE retrieval_chunks SET active=? WHERE document_id=?`).run(
          available ? 1 : 0,
          current.retrieval_document_id,
        );
        this.db.prepare(`
          INSERT INTO retrieval_document_acl(document_id, principal_type, principal_id, tenant_id, granted_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(document_id, principal_type, principal_id, tenant_id) DO UPDATE SET
            granted_at=excluded.granted_at, revoked_at=NULL
        `).run(
          current.retrieval_document_id,
          indexingPrincipal.type,
          indexingPrincipal.id,
          indexingPrincipal.tenantId ?? "",
          at,
        );
        if (!available) {
          revokeDocumentInTransaction(this.db, current.retrieval_document_id, at, "revoked");
        }
        clearRetrievalCache(this.db);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        artifactId: current.artifact_id,
        artifactVersionId: current.artifact_version_id,
        retrievalDocumentId: current.retrieval_document_id,
        reused: true,
      };
    }

    const artifact = this.artifacts.put({
      artifactId: artifactIdFor(request.knowledgeDocumentId),
      kind: "knowledge_document_text",
      logicalName: request.fileName,
      classification: "internal",
      retention: { policy: "knowledge-document", sourceContentHash: request.sourceContentHash },
      mediaType: "text/plain",
      producer: { component: "knowledge-pipeline", version: "retrieval-v2" },
      metadata: {
        knowledgeDocumentId: request.knowledgeDocumentId,
        title: request.title,
        category: request.category,
        sourceContentHash: request.sourceContentHash,
      },
      content: new TextEncoder().encode(request.parsedText),
      state: "staging",
      makeCurrent: false,
    });
    const registration = this.indexer.register({
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId,
      contentHash: artifact.sha256,
      mediaType: artifact.mediaType,
      metadata: {
        title: request.title,
        documentType: request.category,
        entityRefs: [],
        classification: "internal",
      },
      acl: [{ principal: indexingPrincipal, grantedAt: at }],
      embeddingModel: EMBED_MODEL,
      requestedAt: at,
      parserVersion: "retrieval-parser-v1",
      chunkerVersion: "structure-chunker-v1",
    });
    if (registration.jobId) {
      await this.indexer.processJob(registration.jobId, `knowledge-sync-${request.knowledgeDocumentId}`, at);
    }
    const ready = this.db.prepare(`
      SELECT index_status FROM retrieval_documents WHERE document_id=?
    `).get(registration.documentId) as { index_status: string } | undefined;
    if (ready?.index_status !== "ready") {
      throw new RetrievalError("index_failed", `retrieval document did not become ready: ${registration.documentId}`);
    }

    this.db.exec("BEGIN");
    try {
      request.beforeActivate?.();
      this.artifacts.activateVersion(artifact.versionId, "candidate", { inTransaction: true });
      if (current && current.retrieval_document_id !== registration.documentId) {
        revokeDocumentInTransaction(this.db, current.retrieval_document_id, at, "stale");
      }
      this.db.prepare(`
        INSERT INTO knowledge_retrieval_bindings
          (knowledge_document_id, artifact_id, artifact_version_id, retrieval_document_id, source_content_hash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(knowledge_document_id) DO UPDATE SET
          artifact_id=excluded.artifact_id,
          artifact_version_id=excluded.artifact_version_id,
          retrieval_document_id=excluded.retrieval_document_id,
          source_content_hash=excluded.source_content_hash,
          indexed_at=excluded.indexed_at
      `).run(
        request.knowledgeDocumentId,
        artifact.artifactId,
        artifact.versionId,
        registration.documentId,
        request.sourceContentHash,
        at,
      );
      if (!available) {
        revokeDocumentInTransaction(this.db, registration.documentId, at, "revoked");
      }
      clearRetrievalCache(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.versionId,
      retrievalDocumentId: registration.documentId,
      reused: registration.reused,
    };
  }

  revokeKnowledgeDocument(
    knowledgeDocumentId: number,
    at = new Date().toISOString(),
    options: { inTransaction?: boolean } = {},
  ): boolean {
    const binding = bindingFor(this.db, knowledgeDocumentId);
    if (!binding) return false;
    if (!options.inTransaction) this.db.exec("BEGIN");
    try {
      revokeDocumentInTransaction(this.db, binding.retrieval_document_id, at, "revoked");
      clearRetrievalCache(this.db);
      if (!options.inTransaction) this.db.exec("COMMIT");
      return true;
    } catch (error) {
      if (!options.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  restoreKnowledgeDocument(
    knowledgeDocumentId: number,
    at = new Date().toISOString(),
    options: { inTransaction?: boolean } = {},
  ): boolean {
    const binding = bindingFor(this.db, knowledgeDocumentId);
    if (!binding) return false;
    if (!options.inTransaction) this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE retrieval_documents
        SET index_status='ready', permission_revision=permission_revision+1, updated_at=?
        WHERE document_id=?
      `).run(at, binding.retrieval_document_id);
      this.db.prepare("UPDATE retrieval_chunks SET active=1 WHERE document_id=?").run(binding.retrieval_document_id);
      this.db.prepare(`
        INSERT INTO retrieval_document_acl(document_id, principal_type, principal_id, tenant_id, granted_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(document_id, principal_type, principal_id, tenant_id) DO UPDATE SET
          granted_at=excluded.granted_at, revoked_at=NULL
      `).run(
        binding.retrieval_document_id,
        this.principal.type,
        this.principal.id,
        this.principal.tenantId ?? "",
        at,
      );
      clearRetrievalCache(this.db);
      if (!options.inTransaction) this.db.exec("COMMIT");
      return true;
    } catch (error) {
      if (!options.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readKnowledgeDocument(knowledgeDocumentId: number): string {
    const binding = bindingFor(this.db, knowledgeDocumentId);
    if (!binding || binding.index_status !== "ready") {
      throw new RetrievalError("unauthorized", `knowledge document is not available: ${knowledgeDocumentId}`);
    }
    if (!this.indexer.access.canRead(binding.retrieval_document_id, this.principal)) {
      throw new RetrievalError("unauthorized", `knowledge document access denied: ${knowledgeDocumentId}`);
    }
    markKnowledgeHits([knowledgeDocumentId], this.db);
    return new TextDecoder("utf-8", { fatal: true }).decode(this.artifacts.read(binding.artifact_version_id));
  }

  async search(query: string, topK = 10, now = new Date().toISOString()): Promise<RetrievalSearchResponse> {
    const vectors = await this.embedder([query], EMBED_MODEL);
    const queryVector = vectors[0];
    if (!queryVector) throw new RetrievalError("embedding_failed", "query embedding is empty");
    return this.searchService.search({
      principal: this.principal,
      query,
      mode: "hybrid",
      queryVector: [...queryVector],
      embeddingModel: EMBED_MODEL,
      filters: { entityRefs: [], documentTypes: [], artifactVersionIds: [] },
      topK,
      candidateLimit: Math.max(100, topK * 20),
      cacheTtlSeconds: 300,
      now,
    });
  }

  async searchForKnowledgeApi(query: string, topK = 20): Promise<KnowledgeSearchApiResult> {
    const started = performance.now();
    const response = await this.search(query, Math.min(100, Math.max(topK * 4, topK)));
    const grouped = new Map<number, { doc: KnowledgeDocumentRow; hits: RetrievalHit[] }>();
    for (const hit of response.hits) {
      const row = this.db.prepare(`
        SELECT k.*
        FROM knowledge_retrieval_bindings b
        JOIN knowledge_documents k ON k.id=b.knowledge_document_id
        WHERE b.retrieval_document_id=? AND k.archived=0
      `).get(hit.citation.documentId) as KnowledgeDocumentRow | undefined;
      if (!row) continue;
      const entry = grouped.get(row.id) ?? { doc: row, hits: [] };
      entry.hits.push(hit);
      grouped.set(row.id, entry);
    }
    const files: KnowledgeSearchFile[] = [...grouped.values()].slice(0, topK).map(({ doc, hits }) => ({
      docId: doc.id,
      title: doc.title,
      fileName: doc.file_name,
      category: doc.category,
      hitCount: hits.length,
      matches: hits.map((hit, index) => ({
        lineNo: index + 1,
        line: hit.text,
        before: [],
        after: [],
        ranges: [],
      })),
    }));
    markKnowledgeHits(files.map((file) => file.docId), this.db);
    return {
      ok: true,
      data: {
        files,
        totalFiles: files.length,
        truncated: response.hits.length > files.reduce((count, file) => count + file.matches.length, 0),
        elapsedMs: performance.now() - started,
      },
    };
  }

  async reindexAll(): Promise<{ indexed: number; skipped: number; failed: number; failures: Array<{ id: number; error: string }> }> {
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    const failures: Array<{ id: number; error: string }> = [];
    for (const doc of listActiveKnowledgeDocuments(this.db)) {
      const text = readTextMirror(doc.content_hash);
      if (!text) {
        failed += 1;
        failures.push({ id: doc.id, error: "text mirror is missing; re-upload the source document" });
        continue;
      }
      try {
        const result = await this.indexKnowledgeDocument({
          knowledgeDocumentId: doc.id,
          title: doc.title,
          fileName: doc.file_name,
          sourceContentHash: doc.content_hash,
          parsedText: text,
          category: doc.category,
        });
        if (result.reused) skipped += 1;
        else indexed += 1;
      } catch (error) {
        failed += 1;
        failures.push({ id: doc.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { indexed, skipped, failed, failures };
  }
}

let singletonDb: DatabaseSync | undefined;
let singletonPool: PersistentEmbeddingPool | undefined;
let singletonService: ProductionRetrievalService | undefined;
let installedService: ProductionRetrievalService | undefined;

/**
 * 显式安装由应用组合根提供的 Retrieval v2 服务。
 *
 * 主要用于测试和受控宿主将确定性/远程 embedder 注入完整的知识入库链路；
 * 未安装时生产环境仍使用持久化本地 worker，绝不自动降级为词法检索。
 * 返回的恢复函数避免同一进程内的测试或多宿主相互污染。
 */
export function installProductionRetrievalService(service: ProductionRetrievalService): () => void {
  const previous = installedService;
  installedService = service;
  return () => {
    if (installedService === service) installedService = previous;
  };
}

export function hasInstalledProductionRetrievalService(): boolean {
  return Boolean(installedService);
}

export function getProductionRetrievalService(): ProductionRetrievalService {
  if (installedService) return installedService;
  const db = getDb();
  if (!singletonService || singletonDb !== db) {
    singletonDb = db;
    singletonPool = singletonPool ?? new PersistentEmbeddingPool();
    singletonService = new ProductionRetrievalService({
      db,
      artifacts: new ArtifactStore(db, path.join(getAppDataDir(), "artifacts", "cas")),
      embedder: singletonPool.embed,
    });
  }
  return singletonService;
}

export function createProductionRetrievalService(options: {
  db?: DatabaseSync;
  embedder: RetrievalEmbedder;
  casRoot?: string;
  principal?: PrincipalRef;
}): ProductionRetrievalService {
  const db = options.db ?? getDb();
  return new ProductionRetrievalService({
    db,
    artifacts: new ArtifactStore(db, options.casRoot ?? path.join(getAppDataDir(), "artifacts", "cas")),
    embedder: options.embedder,
    principal: options.principal,
  });
}
