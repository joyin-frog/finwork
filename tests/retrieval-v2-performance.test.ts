import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  RetrievalSearchService,
  buildBm25MatchQuery,
  lexicalTerms,
} from "../lib/retrieval/index.ts";

const NOW = "2026-08-09T00:00:00.000Z";
const CHUNK_COUNT = 100_000;
const INDEX_PROFILE = "bm25-lexical-v1";

export const retrievalV2PerformanceTestPromise = (async () => {
  const root = mkdtempSync(path.join(tmpdir(), "finwork-retrieval-perf-"));
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  try {
    const artifact = new ArtifactStore(db, root).put({
      kind: "document",
      logicalName: "十万分块检索基准.md",
      classification: "internal",
      retention: { policy: "case" },
      mediaType: "text/markdown",
      producer: { capabilityId: "retrieval-performance-test", version: "1" },
      content: new TextEncoder().encode("十万分块检索基准"),
    });
    db.prepare(`
      INSERT INTO retrieval_documents(
        document_id, artifact_id, artifact_version_id, content_hash, title, document_type,
        entity_refs_json, period_start, period_end, effective_date, classification,
        parser_version, chunker_version, index_profile, index_status, indexed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
    `).run(
      "document-perf", artifact.artifactId, artifact.versionId, artifact.sha256,
      "十万分块检索基准", "finance_policy", '["entity-1"]', "2026-01-01", "2026-12-31",
      "2026-01-01", "internal", "retrieval-parser-v1", "structure-chunker-v1", INDEX_PROFILE,
      NOW, NOW, NOW,
    );
    db.prepare(`
      INSERT INTO retrieval_document_acl(document_id, principal_type, principal_id, tenant_id, granted_at)
      VALUES ('document-perf', 'user', 'user-1', 'tenant-1', ?)
    `).run(NOW);

    const insertChunk = db.prepare(`
      INSERT INTO retrieval_chunks(
        chunk_id, document_id, artifact_version_id, parent_chunk_id, ordinal, node_type, depth,
        heading, text, text_hash, locator_json, char_start, char_end, token_count,
        active, created_at
      ) VALUES (?, 'document-perf', ?, NULL, ?, 'paragraph', 0, NULL, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO retrieval_chunks_fts(chunk_id, body_terms, title_terms) VALUES (?, ?, ?)
    `);
    const insertTerm = db.prepare(`
      INSERT INTO retrieval_lexical_terms(term, chunk_id, term_freq) VALUES (?, ?, 1)
    `);
    const targetText = "增值税 申报 税率 6% 的权威证据";
    db.exec("BEGIN");
    try {
      for (let index = 0; index < CHUNK_COUNT; index += 1) {
        const chunkId = `chunk-${index.toString().padStart(6, "0")}`;
        const text = index === CHUNK_COUNT - 1 ? targetText : `普通会计凭证记录 ${index}`;
        const start = index * 32;
        insertChunk.run(
          chunkId,
          artifact.versionId,
          index,
          text,
          index.toString(16).padStart(64, "0"),
          JSON.stringify({ kind: "char_range", nodeId: chunkId, start, end: start + text.length }),
          start,
          start + text.length,
          Math.max(1, Math.ceil(text.length / 2)),
          NOW,
        );
        insertFts.run(
          chunkId,
          index === CHUNK_COUNT - 1 ? lexicalTerms(text).join(" ") : "普通 会计 凭证",
          "十万 分块 检索 基准",
        );
      }
      const targetChunkId = `chunk-${(CHUNK_COUNT - 1).toString().padStart(6, "0")}`;
      for (const term of new Set(lexicalTerms(targetText))) insertTerm.run(term, targetChunkId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const started = performance.now();
    const response = new RetrievalSearchService(db).search({
      principal: { id: "user-1", type: "user", tenantId: "tenant-1" },
      query: "增值税 申报 税率",
      mode: "bm25",
      indexProfile: INDEX_PROFILE,
      filters: {
        entityRefs: ["entity-1"],
        period: { start: "2026-01-01", end: "2026-12-31" },
        documentTypes: ["finance_policy"],
        effectiveAt: "2026-08-09",
        artifactVersionIds: [],
      },
      topK: 5,
      candidateLimit: 50,
      cacheTtlSeconds: 0,
      now: NOW,
    });
    const elapsedMs = performance.now() - started;
    assert.equal(response.diagnostics.authorizedDocumentCount, 1);
    assert.ok(response.hits.some((hit) => hit.text === targetText));
    assert.ok(response.diagnostics.bm25CandidateCount <= 50);
    assert.ok(response.diagnostics.scoredCandidateCount <= 100);
    assert.ok(elapsedMs < 3_000, `100k-chunk bounded retrieval took ${elapsedMs.toFixed(1)}ms`);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT chunk_id FROM retrieval_chunks_fts
      WHERE retrieval_chunks_fts MATCH ? LIMIT 50
    `).all(buildBm25MatchQuery("增值税 申报 税率")) as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes("VIRTUAL TABLE INDEX")), JSON.stringify(plan));

    console.log(
      `retrieval-v2-performance: ${CHUNK_COUNT.toLocaleString()} chunks, ` +
      `${response.diagnostics.scoredCandidateCount} scored candidates, ${elapsedMs.toFixed(1)}ms ✓`,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("retrieval-v2-performance.test")) {
  retrievalV2PerformanceTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
