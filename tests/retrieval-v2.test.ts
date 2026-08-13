import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  RetrievalCitationBinder,
  RetrievalError,
  RetrievalIndexer,
  RetrievalSearchRequestSchema,
  RetrievalSearchService,
  annBucketKeys,
  chunkStructuredText,
  defaultTextRetrievalParser,
  lexicalTerms,
  type RetrievalEmbedder,
  type RetrievalParser,
  type RetrievalRegistration,
} from "../lib/retrieval/index.ts";

const NOW = "2026-08-09T00:00:00.000Z";
const OWNER = { id: "user-1", type: "user" as const, tenantId: "tenant-1" };

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

function makeRegistration(
  artifact: ReturnType<ArtifactStore["put"]>,
  title: string,
): RetrievalRegistration {
  return {
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.versionId,
    contentHash: artifact.sha256,
    mediaType: artifact.mediaType,
    metadata: {
      title,
      documentType: "finance_policy",
      entityRefs: ["entity-1"],
      period: { start: "2026-01-01", end: "2026-12-31" },
      effectiveDate: "2026-01-01",
      classification: "confidential",
    },
    acl: [{ principal: OWNER, grantedAt: NOW }],
    embeddingModel: "bge-small-zh-v1.5",
    requestedAt: NOW,
    parserVersion: "retrieval-parser-v1",
    chunkerVersion: "structure-chunker-v1",
  };
}

function searchRequest(overrides: Record<string, unknown> = {}) {
  return {
    principal: OWNER,
    query: "增值税 申报 税率",
    mode: "hybrid" as const,
    queryVector: [1, 0],
    embeddingModel: "bge-small-zh-v1.5",
    filters: {
      entityRefs: ["entity-1"],
      period: { start: "2026-01-01", end: "2026-12-31" },
      documentTypes: ["finance_policy"],
      effectiveAt: "2026-08-09",
      artifactVersionIds: [],
    },
    topK: 5,
    candidateLimit: 20,
    cacheTtlSeconds: 300,
    now: NOW,
    ...overrides,
  };
}

const embedder: RetrievalEmbedder = async (texts) => texts.map((_, index) => [1, index % 2]);

export const retrievalV2TestPromise = (async () => {
  assert.throws(
    () => RetrievalSearchRequestSchema.parse({ ...searchRequest(), queryVector: undefined }),
    /requires queryVector/,
  );
  assert.deepEqual(lexicalTerms("增值税 VAT 2026"), lexicalTerms("增值税 VAT 2026"));
  assert.deepEqual(annBucketKeys([1, 0, 0]), annBucketKeys([1, 0, 0]));

  const longText = `# 税务政策\n\n${"增值税申报规则。".repeat(700)}`;
  const structured = chunkStructuredText("doc-structure", longText);
  const heading = structured.chunks.find((chunk) => chunk.nodeType === "section");
  const paragraphs = structured.chunks.filter((chunk) => chunk.nodeType === "paragraph");
  assert.ok(heading);
  assert.ok(paragraphs.length > 1);
  assert.ok(paragraphs.every((chunk) => chunk.parentId === heading.id));
  assert.ok(structured.chunks.every((chunk) => chunk.text.length <= 2_000));

  const root = mkdtempSync(path.join(tmpdir(), "finwork-retrieval-v2-"));
  const db = makeDb();
  try {
    const artifacts = new ArtifactStore(db, root);
    const artifact = artifacts.put({
      kind: "document",
      logicalName: "增值税政策.md",
      classification: "confidential",
      retention: { policy: "case" },
      mediaType: "text/markdown",
      producer: { capabilityId: "test", version: "1" },
      content: new TextEncoder().encode("# 增值税申报\n\n本期一般纳税人适用税率为 6%，申报截止日为次月十五日。"),
    });
    const parser: RetrievalParser = async (input) => {
      if (input.title.includes("解析失败")) throw new RetrievalError("parser_failed", "fixture parser rejected document");
      return defaultTextRetrievalParser(input);
    };
    const indexer = new RetrievalIndexer(db, artifacts, parser, embedder);
    const registration = makeRegistration(artifact, "增值税申报政策");
    const registered = indexer.register(registration);
    assert.equal(registered.reused, false);
    assert.ok(registered.jobId);
    const completed = await indexer.processNext("test-worker", NOW);
    assert.equal(completed?.status, "succeeded");
    assert.equal((db.prepare("SELECT index_status FROM retrieval_documents WHERE document_id=?").get(registered.documentId) as { index_status: string }).index_status, "ready");

    const reused = indexer.register(registration);
    assert.equal(reused.reused, true);
    assert.equal(reused.jobId, undefined);
    assert.equal(reused.documentId, registered.documentId);

    const search = new RetrievalSearchService(db);
    const first = search.search(searchRequest());
    assert.equal(first.diagnostics.cacheHit, false);
    assert.ok(first.hits.length > 0);
    assert.equal(first.hits[0].citation.artifactVersionId, artifact.versionId);
    assert.equal(first.hits[0].citation.artifactHash, artifact.sha256);
    const evidenceHit = first.hits.find((hit) => hit.citation.quotedText.includes("6%"));
    assert.ok(evidenceHit, "hybrid retrieval should return the paragraph containing the cited tax rate");
    const cached = search.search(searchRequest());
    assert.equal(cached.diagnostics.cacheHit, true);

    db.prepare(`
      INSERT INTO task_contracts(task_id, contract_version, contract_json, contract_hash, created_at, updated_at)
      VALUES ('task-retrieval', 3, '{}', 'hash', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO cases(case_id, task_id, state, created_at, updated_at)
      VALUES ('case-retrieval', 'task-retrieval', 'running', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO claims(claim_id, case_id, statement, status, created_at, updated_at)
      VALUES ('claim-retrieval', 'case-retrieval', '一般纳税人税率为 6%', 'verified', ?, ?)
    `).run(NOW, NOW);
    const binder = new RetrievalCitationBinder(db);
    const citationId = binder.bind("claim-retrieval", evidenceHit.chunkId, evidenceHit.citation, NOW, "citation-valid");
    assert.equal(citationId, "citation-valid");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM citation_records").get() as { count: number }).count, 1);
    assert.throws(
      () => binder.bind("claim-retrieval", evidenceHit.chunkId, { ...evidenceHit.citation, title: "伪造标题" }, NOW),
      /no longer matches immutable source/,
    );

    indexer.access.revoke(registered.documentId, OWNER, "2026-08-09T00:01:00.000Z");
    const revoked = search.search(searchRequest({ now: "2026-08-09T00:02:00.000Z" }));
    assert.equal(revoked.hits.length, 0);
    assert.equal(revoked.diagnostics.authorizedDocumentCount, 0);
    assert.equal(revoked.diagnostics.cacheHit, false);

    const brokenArtifact = artifacts.put({
      kind: "document",
      logicalName: "broken.md",
      classification: "confidential",
      retention: { policy: "case" },
      mediaType: "text/markdown",
      producer: { capabilityId: "test", version: "1" },
      content: new TextEncoder().encode("无法解析"),
    });
    const brokenRegistration = indexer.register(makeRegistration(brokenArtifact, "解析失败"));
    await assert.rejects(() => indexer.processNext("broken-worker", "2026-08-09T00:03:00.000Z"), (error: unknown) => {
      assert.ok(error instanceof RetrievalError);
      assert.equal(error.code, "parser_failed");
      return true;
    });
    const failed = db.prepare(`
      SELECT index_status, error_code FROM retrieval_documents WHERE document_id=?
    `).get(brokenRegistration.documentId) as { index_status: string; error_code: string };
    assert.equal(failed.index_status, "failed");
    assert.equal(failed.error_code, "parser_failed");

    console.log("retrieval-v2: contracts, structure, immutable indexing, ACL cache safety and citation integrity passed ✓");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("retrieval-v2.test")) {
  retrievalV2TestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
