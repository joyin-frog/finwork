import type { DatabaseSync } from "node:sqlite";
import { DocumentLocatorSchema, type DocumentLocator } from "@/lib/artifacts/contracts";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { RetrievalAccessController } from "./access";
import {
  RETRIEVAL_INDEX_VERSION,
  RetrievalSearchRequestSchema,
  RetrievalSearchResponseSchema,
  type RetrievalSearchRequest,
  type RetrievalSearchResponse,
} from "./contracts";
import { lexicalTerms, lexicalOverlapScore } from "./lexical";

type CandidateRow = { chunk_id: string; bm25_score: number };

type ScoredRow = {
  chunk_id: string;
  text: string;
  heading: string | null;
  locator_json: string;
  artifact_id: string;
  artifact_version_id: string;
  artifact_hash: string;
  document_id: string;
  document_type: string;
  title: string;
  effective_date: string | null;
};

function principalArgs(request: RetrievalSearchRequest): [string, string, string] {
  return [request.principal.type, request.principal.id, request.principal.tenantId ?? ""];
}

function filterSql(request: RetrievalSearchRequest, alias = "d"): { sql: string; args: string[] } {
  const clauses: string[] = [];
  const args: string[] = [];
  if (request.filters.documentTypes.length > 0) {
    clauses.push(`${alias}.document_type IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(request.filters.documentTypes));
  }
  if (request.filters.artifactVersionIds.length > 0) {
    clauses.push(`${alias}.artifact_version_id IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(request.filters.artifactVersionIds));
  }
  if (request.filters.effectiveAt) {
    clauses.push(`(${alias}.effective_date IS NULL OR ${alias}.effective_date <= ?)`);
    args.push(request.filters.effectiveAt);
  }
  if (request.filters.period) {
    clauses.push(`(${alias}.period_start IS NULL OR (${alias}.period_start <= ? AND ${alias}.period_end >= ?))`);
    args.push(request.filters.period.end, request.filters.period.start);
  }
  if (request.filters.entityRefs.length > 0) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM json_each(?) requested
      WHERE NOT EXISTS (SELECT 1 FROM json_each(${alias}.entity_refs_json) actual WHERE actual.value=requested.value)
    )`);
    args.push(JSON.stringify(request.filters.entityRefs));
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", args };
}

function authorizationJoin(): string {
  return `JOIN retrieval_document_acl acl ON acl.document_id=d.document_id
    AND acl.principal_type=? AND acl.principal_id=? AND acl.tenant_id=? AND acl.revoked_at IS NULL`;
}

function quoteForCitation(text: string): string {
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

/** Build a literal-token FTS query from deterministic CJK/word tokens. */
export function buildBm25MatchQuery(query: string): string {
  return [...new Set(lexicalTerms(query))]
    .slice(0, 64)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export class RetrievalSearchService {
  readonly access: RetrievalAccessController;

  constructor(readonly db: DatabaseSync) {
    this.access = new RetrievalAccessController(db);
  }

  search(rawRequest: RetrievalSearchRequest): RetrievalSearchResponse {
    const started = performance.now();
    const request = RetrievalSearchRequestSchema.parse(rawRequest);
    const permissionFingerprint = this.access.permissionFingerprint(request.principal);
    const principalFingerprint = sha256Json(request.principal);
    const queryHash = sha256Json({
      query: request.query,
      mode: request.mode,
      indexProfile: request.indexProfile,
      filters: request.filters,
      topK: request.topK,
      candidateLimit: request.candidateLimit,
      indexVersion: RETRIEVAL_INDEX_VERSION,
    });
    const cacheKey = sha256Json({ principalFingerprint, permissionFingerprint, queryHash });
    if (request.cacheTtlSeconds > 0) {
      const cached = this.db.prepare(`
        SELECT result_json FROM retrieval_query_cache
        WHERE cache_key=? AND principal_fingerprint=? AND permission_fingerprint=? AND expires_at>?
      `).get(cacheKey, principalFingerprint, permissionFingerprint, request.now) as { result_json: string } | undefined;
      if (cached) {
        const response = RetrievalSearchResponseSchema.parse(JSON.parse(cached.result_json));
        return {
          ...response,
          diagnostics: { ...response.diagnostics, cacheHit: true, elapsedMs: performance.now() - started },
        };
      }
    }

    const filters = filterSql(request);
    const authArgs = principalArgs(request);
    const authorizedDocumentCount = Number((this.db.prepare(`
      SELECT COUNT(DISTINCT d.document_id) AS count
      FROM retrieval_documents d ${authorizationJoin()}
      WHERE d.index_status='ready' AND d.index_profile=? ${filters.sql}
    `).get(...authArgs, request.indexProfile, ...filters.args) as { count: number }).count);

    const terms = [...new Set(lexicalTerms(request.query))].slice(0, 64);
    const matchQuery = buildBm25MatchQuery(request.query);
    const bm25Scores = new Map<string, number>();
    if (matchQuery && authorizedDocumentCount > 0) {
      const rows = this.db.prepare(`
        SELECT f.chunk_id,
               -bm25(retrieval_chunks_fts, 0.0, 1.0, 4.0) AS bm25_score
        FROM retrieval_chunks_fts f
        JOIN retrieval_chunks c ON c.chunk_id=f.chunk_id AND c.active=1
        JOIN retrieval_documents d ON d.document_id=c.document_id
        ${authorizationJoin()}
        WHERE retrieval_chunks_fts MATCH ?
          AND d.index_status='ready' AND d.index_profile=? ${filters.sql}
        ORDER BY bm25(retrieval_chunks_fts, 0.0, 1.0, 4.0), f.chunk_id
        LIMIT ?
      `).all(
        ...authArgs,
        matchQuery,
        request.indexProfile,
        ...filters.args,
        request.candidateLimit,
      ) as CandidateRow[];
      for (const row of rows) bm25Scores.set(row.chunk_id, Math.max(0, Number(row.bm25_score)));
    }

    const directCandidates = new Set(bm25Scores.keys());
    const expandedCandidates = new Set(directCandidates);
    if (directCandidates.size > 0) {
      const maxExpanded = Math.min(request.candidateLimit * 2, 20_000);
      const rows = this.db.prepare(`
        SELECT DISTINCT e.to_chunk_id AS chunk_id
        FROM retrieval_chunk_edges e
        JOIN retrieval_chunks c ON c.chunk_id=e.to_chunk_id AND c.active=1
        JOIN retrieval_documents d ON d.document_id=c.document_id
        ${authorizationJoin()}
        WHERE e.from_chunk_id IN (SELECT value FROM json_each(?))
          AND e.relation IN ('parent','next','previous','same_section')
          AND d.index_status='ready' AND d.index_profile=? ${filters.sql}
        LIMIT ?
      `).all(
        ...authArgs,
        JSON.stringify([...directCandidates]),
        request.indexProfile,
        ...filters.args,
        maxExpanded,
      ) as Array<{ chunk_id: string }>;
      for (const row of rows) {
        if (expandedCandidates.size >= maxExpanded) break;
        expandedCandidates.add(row.chunk_id);
      }
    }

    const candidates = [...expandedCandidates];
    const rows = candidates.length === 0 ? [] : this.db.prepare(`
      SELECT c.chunk_id, c.text, c.heading, c.locator_json,
             d.artifact_id, d.artifact_version_id, v.sha256 AS artifact_hash,
             d.document_id, d.document_type, d.title, d.effective_date
      FROM retrieval_chunks c
      JOIN retrieval_documents d ON d.document_id=c.document_id
      JOIN artifact_versions v ON v.version_id=d.artifact_version_id
      ${authorizationJoin()}
      WHERE c.chunk_id IN (SELECT value FROM json_each(?)) AND c.active=1
        AND d.index_status='ready' AND d.index_profile=? ${filters.sql}
    `).all(
      ...authArgs,
      JSON.stringify(candidates),
      request.indexProfile,
      ...filters.args,
    ) as ScoredRow[];

    const maxBm25 = Math.max(1e-9, ...bm25Scores.values());
    const scored = rows.map((row) => {
      const bm25Score = bm25Scores.get(row.chunk_id) ?? 0;
      const overlap = lexicalOverlapScore(terms, `${row.title} ${row.heading ?? ""} ${row.text}`);
      const directMatch = bm25Score > 0;
      // Query coverage is the stronger evidence signal; BM25 resolves ties
      // without letting a tiny title chunk outrank a paragraph matching the
      // complete question.
      const rerankScore = directMatch
        ? (bm25Score / maxBm25) * 0.35 + overlap * 0.65
        : overlap * 0.1;
      const quotedText = quoteForCitation(row.text);
      const locator = DocumentLocatorSchema.parse(JSON.parse(row.locator_json)) as DocumentLocator;
      return {
        chunkId: row.chunk_id,
        text: row.text,
        heading: row.heading ?? undefined,
        score: rerankScore,
        directMatch,
        citation: {
          artifactId: row.artifact_id,
          artifactVersionId: row.artifact_version_id,
          artifactHash: row.artifact_hash,
          documentId: row.document_id,
          documentType: row.document_type,
          title: row.title,
          locator,
          quotedText,
          quoteHash: sha256Json(quotedText),
          effectiveDate: row.effective_date ?? undefined,
          bm25Score,
          rerankScore,
        },
      };
    }).sort((left, right) => {
      if (left.directMatch !== right.directMatch) return left.directMatch ? -1 : 1;
      return right.score - left.score || left.chunkId.localeCompare(right.chunkId);
    });

    const response = RetrievalSearchResponseSchema.parse({
      hits: scored.slice(0, request.topK).map(({ directMatch: _directMatch, ...hit }) => hit),
      diagnostics: {
        mode: "bm25",
        cacheHit: false,
        authorizedDocumentCount,
        bm25CandidateCount: bm25Scores.size,
        expandedCandidateCount: expandedCandidates.size,
        scoredCandidateCount: rows.length,
        rejectedCandidateCount: 0,
        elapsedMs: performance.now() - started,
        indexVersion: RETRIEVAL_INDEX_VERSION,
      },
    });
    if (request.cacheTtlSeconds > 0) {
      const expiresAt = new Date(new Date(request.now).getTime() + request.cacheTtlSeconds * 1_000).toISOString();
      this.db.prepare(`
        INSERT INTO retrieval_query_cache
          (cache_key, principal_fingerprint, permission_fingerprint, query_hash, result_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,
          created_at=excluded.created_at, expires_at=excluded.expires_at
      `).run(cacheKey, principalFingerprint, permissionFingerprint, queryHash, canonicalJson(response), request.now, expiresAt);
    }
    return response;
  }
}
