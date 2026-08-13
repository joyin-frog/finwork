import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactStore } from "@/lib/artifacts/store";
import { canonicalJson } from "@/lib/capability/hash";
import { annBucketKeys, vectorToBuffer } from "./ann";
import { RetrievalAccessController } from "./access";
import { chunkStructuredText } from "./chunker";
import {
  ParsedRetrievalDocumentSchema,
  RetrievalError,
  RetrievalRegistrationSchema,
  type RetrievalEmbedder,
  type RetrievalParser,
  type RetrievalRegistration,
} from "./contracts";
import { RetrievalJobQueue, type RetrievalJob } from "./jobs";
import { lexicalTermFrequency } from "./lexical";

export type RegisterResult = { documentId: string; jobId?: string; reused: boolean };

function asRetrievalError(error: unknown): RetrievalError {
  if (error instanceof RetrievalError) return error;
  return new RetrievalError("index_failed", error instanceof Error ? error.message : String(error), { cause: error });
}

export const defaultTextRetrievalParser: RetrievalParser = async ({ content, mediaType, title }) => {
  const normalizedType = mediaType.split(";")[0].trim().toLowerCase();
  const supported = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
  ]);
  if (!supported.has(normalizedType)) {
    throw new RetrievalError("parser_unavailable", `no retrieval parser registered for ${normalizedType}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  if (!text.trim()) throw new RetrievalError("parser_failed", "parsed document is empty");
  return ParsedRetrievalDocumentSchema.parse({ text, title, documentType: normalizedType, parserMetadata: {} });
};

export class RetrievalIndexer {
  readonly queue: RetrievalJobQueue;
  readonly access: RetrievalAccessController;

  constructor(
    readonly db: DatabaseSync,
    readonly artifacts: ArtifactStore,
    readonly parser: RetrievalParser,
    readonly embedder: RetrievalEmbedder,
  ) {
    this.queue = new RetrievalJobQueue(db);
    this.access = new RetrievalAccessController(db);
  }

  register(rawRegistration: RetrievalRegistration): RegisterResult {
    const registration = RetrievalRegistrationSchema.parse(rawRegistration);
    const artifact = this.db.prepare(`
      SELECT a.artifact_id, v.version_id, v.sha256, v.media_type
      FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
      WHERE v.version_id=?
    `).get(registration.artifactVersionId) as {
      artifact_id: string;
      version_id: string;
      sha256: string;
      media_type: string;
    } | undefined;
    if (!artifact) throw new RetrievalError("invalid_contract", `artifact version not found: ${registration.artifactVersionId}`);
    if (artifact.artifact_id !== registration.artifactId || artifact.sha256 !== registration.contentHash || artifact.media_type !== registration.mediaType) {
      throw new RetrievalError("invalid_contract", "retrieval registration does not match immutable artifact version");
    }

    const existing = this.db.prepare(`
      SELECT document_id, index_status FROM retrieval_documents
      WHERE artifact_version_id=? AND parser_version=? AND chunker_version=? AND embedding_model=?
    `).get(
      registration.artifactVersionId,
      registration.parserVersion,
      registration.chunkerVersion,
      registration.embeddingModel,
    ) as { document_id: string; index_status: string } | undefined;

    if (existing?.index_status === "ready") {
      for (const grant of registration.acl) this.access.grant(existing.document_id, grant.principal, grant.grantedAt);
      return { documentId: existing.document_id, reused: true };
    }

    const documentId = existing?.document_id ?? registration.documentId ?? randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO retrieval_documents
          (document_id, artifact_id, artifact_version_id, content_hash, title, document_type,
           entity_refs_json, period_start, period_end, effective_date, classification,
           parser_version, chunker_version, embedding_model, index_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          title=excluded.title, document_type=excluded.document_type,
          entity_refs_json=excluded.entity_refs_json, period_start=excluded.period_start,
          period_end=excluded.period_end, effective_date=excluded.effective_date,
          classification=excluded.classification, index_status='queued', error_code=NULL,
          error_message=NULL, updated_at=excluded.updated_at
      `).run(
        documentId,
        registration.artifactId,
        registration.artifactVersionId,
        registration.contentHash,
        registration.metadata.title,
        registration.metadata.documentType,
        canonicalJson(registration.metadata.entityRefs),
        registration.metadata.period?.start ?? null,
        registration.metadata.period?.end ?? null,
        registration.metadata.effectiveDate ?? null,
        registration.metadata.classification,
        registration.parserVersion,
        registration.chunkerVersion,
        registration.embeddingModel,
        registration.requestedAt,
        registration.requestedAt,
      );
      const acl = this.db.prepare(`
        INSERT INTO retrieval_document_acl(document_id, principal_type, principal_id, tenant_id, granted_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(document_id, principal_type, principal_id, tenant_id) DO UPDATE SET
          granted_at=excluded.granted_at, revoked_at=NULL
      `);
      for (const grant of registration.acl) {
        acl.run(documentId, grant.principal.type, grant.principal.id, grant.principal.tenantId ?? "", grant.grantedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const job = this.queue.enqueue(documentId, registration.requestedAt);
    return { documentId, jobId: job.jobId, reused: false };
  }

  async processNext(workerId: string, at = new Date().toISOString()): Promise<RetrievalJob | undefined> {
    const job = this.queue.claimNext(workerId, at);
    if (!job) return undefined;
    return await this.processClaimed(job, workerId, at);
  }

  async processJob(jobId: string, workerId: string, at = new Date().toISOString()): Promise<RetrievalJob> {
    return await this.processClaimed(this.queue.claim(jobId, workerId, at), workerId, at);
  }

  async processClaimed(job: RetrievalJob, workerId: string, at = new Date().toISOString()): Promise<RetrievalJob> {
    try {
      const document = this.db.prepare(`
        SELECT artifact_version_id, media_type, title, embedding_model
        FROM retrieval_documents d JOIN artifact_versions v ON v.version_id=d.artifact_version_id
        WHERE document_id=?
      `).get(job.documentId) as {
        artifact_version_id: string;
        media_type: string;
        title: string;
        embedding_model: string;
      } | undefined;
      if (!document) throw new RetrievalError("index_failed", `retrieval document not found: ${job.documentId}`);
      this.db.prepare(`
        UPDATE retrieval_documents
        SET index_status='indexing', error_code=NULL, error_message=NULL, updated_at=?
        WHERE document_id=?
      `)
        .run(at, job.documentId);

      let parsed;
      try {
        parsed = ParsedRetrievalDocumentSchema.parse(await this.parser({
          content: this.artifacts.read(document.artifact_version_id),
          mediaType: document.media_type,
          title: document.title,
        }));
      } catch (error) {
        if (error instanceof RetrievalError) throw error;
        throw new RetrievalError("parser_failed", error instanceof Error ? error.message : String(error), { cause: error });
      }

      const { chunks, edges } = chunkStructuredText(job.documentId, parsed.text);
      if (chunks.length === 0) throw new RetrievalError("parser_failed", "parser produced no indexable structures");
      let vectors: readonly (readonly number[])[];
      try {
        vectors = await this.embedder(chunks.map((chunk) => chunk.text), document.embedding_model);
      } catch (error) {
        if (error instanceof RetrievalError) throw error;
        throw new RetrievalError("embedding_failed", error instanceof Error ? error.message : String(error), { retryable: true, cause: error });
      }
      if (vectors.length !== chunks.length) {
        throw new RetrievalError("embedding_failed", `embedding count mismatch: expected ${chunks.length}, got ${vectors.length}`, { retryable: true });
      }
      const dimension = vectors[0]?.length ?? 0;
      if (dimension === 0 || vectors.some((vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))) {
        throw new RetrievalError("embedding_failed", "embedding vectors have invalid or inconsistent dimensions", { retryable: true });
      }

      this.db.exec("BEGIN");
      try {
        this.db.prepare("DELETE FROM retrieval_chunks WHERE document_id=?").run(job.documentId);
        const insertChunk = this.db.prepare(`
          INSERT INTO retrieval_chunks
            (chunk_id, document_id, artifact_version_id, parent_chunk_id, ordinal, node_type,
             depth, heading, text, text_hash, locator_json, char_start, char_end, token_count,
             embedding, embedding_dim, active, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `);
        const insertTerm = this.db.prepare(`
          INSERT INTO retrieval_lexical_terms(term, chunk_id, term_freq) VALUES (?, ?, ?)
        `);
        const insertBucket = this.db.prepare(`
          INSERT INTO retrieval_ann_buckets(model, band_no, bucket_hash, chunk_id) VALUES (?, ?, ?, ?)
        `);
        chunks.forEach((chunk, index) => {
          const vector = vectors[index];
          insertChunk.run(
            chunk.id,
            job.documentId,
            document.artifact_version_id,
            chunk.parentId ?? null,
            chunk.ordinal,
            chunk.nodeType,
            chunk.depth,
            chunk.heading ?? null,
            chunk.text,
            chunk.textHash,
            canonicalJson(chunk.locator),
            chunk.charStart,
            chunk.charEnd,
            chunk.tokenCount,
            vectorToBuffer(vector),
            vector.length,
            at,
          );
          for (const [term, frequency] of lexicalTermFrequency(chunk.text)) insertTerm.run(term, chunk.id, frequency);
          for (const key of annBucketKeys(vector)) insertBucket.run(document.embedding_model, key.bandNo, key.bucketHash, chunk.id);
        });
        const insertEdge = this.db.prepare(`
          INSERT INTO retrieval_chunk_edges(from_chunk_id, to_chunk_id, relation) VALUES (?, ?, ?)
        `);
        for (const edge of edges) insertEdge.run(edge.fromChunkId, edge.toChunkId, edge.relation);
        this.db.prepare(`
          UPDATE retrieval_documents
          SET index_status='ready', error_code=NULL, error_message=NULL, indexed_at=?, updated_at=?
          WHERE document_id=?
        `).run(at, at, job.documentId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new RetrievalError("index_failed", error instanceof Error ? error.message : String(error), { cause: error });
      }
      return this.queue.complete(job.jobId, workerId, at);
    } catch (rawError) {
      const error = asRetrievalError(rawError);
      this.db.prepare(`
        UPDATE retrieval_documents SET index_status='failed', error_code=?, error_message=?, updated_at=? WHERE document_id=?
      `).run(error.code, error.message, at, job.documentId);
      this.queue.fail(job.jobId, workerId, error, at);
      throw error;
    }
  }
}
