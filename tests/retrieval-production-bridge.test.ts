import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { insertKnowledgeDocument } from "../lib/db/sqlite.ts";
import {
  createProductionRetrievalService,
  LOCAL_RETRIEVAL_PRINCIPAL,
  RetrievalError,
  type RetrievalEmbedder,
} from "../lib/retrieval/index.ts";

const NOW = "2026-08-09T08:00:00.000Z";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

const deterministicEmbedder: RetrievalEmbedder = async (texts) => texts.map((text) => {
  const normalized = text.toLowerCase();
  return [
    normalized.includes("差旅") ? 1 : 0,
    normalized.includes("住宿") ? 1 : 0,
    normalized.includes("税") ? 1 : 0,
    0.1,
  ];
});

function insertDoc(db: DatabaseSync, title: string, fileName: string, content: string): number {
  return insertKnowledgeDocument({
    title,
    file_name: fileName,
    mime_type: "text/plain",
    category: "finance_policy",
    size_bytes: Buffer.byteLength(content),
    chunk_count: 1,
    content_hash: sha256(content),
  }, db);
}

function binding(db: DatabaseSync, knowledgeDocumentId: number) {
  return db.prepare(`
    SELECT artifact_id, artifact_version_id, retrieval_document_id, source_content_hash
    FROM knowledge_retrieval_bindings WHERE knowledge_document_id=?
  `).get(knowledgeDocumentId) as {
    artifact_id: string;
    artifact_version_id: string;
    retrieval_document_id: string;
    source_content_hash: string;
  } | undefined;
}

export const retrievalProductionBridgeTestPromise = (async () => {
  const root = mkdtempSync(path.join(tmpdir(), "finwork-retrieval-production-"));
  const db = makeDb();
  try {
    const service = createProductionRetrievalService({
      db,
      casRoot: path.join(root, "cas"),
      embedder: deterministicEmbedder,
    });
    const firstText = "# 差旅制度\n\n差旅住宿标准为每晚 500 元，超出部分需要单独审批。";
    const knowledgeDocumentId = insertDoc(db, "差旅制度", "travel-policy.txt", firstText);
    const first = await service.indexKnowledgeDocument({
      knowledgeDocumentId,
      title: "差旅制度",
      fileName: "travel-policy.txt",
      sourceContentHash: sha256(firstText),
      parsedText: firstText,
      category: "finance_policy",
      now: NOW,
    });

    assert.equal(service.readKnowledgeDocument(knowledgeDocumentId), firstText);
    const currentArtifact = db.prepare(`
      SELECT lifecycle_state, current_version_id FROM artifacts WHERE artifact_id=?
    `).get(first.artifactId) as { lifecycle_state: string; current_version_id: string };
    assert.equal(currentArtifact.lifecycle_state, "candidate");
    assert.equal(currentArtifact.current_version_id, first.artifactVersionId);

    const firstSearch = await service.search("差旅住宿标准", 5, "2026-08-09T08:01:00.000Z");
    assert.ok(firstSearch.hits.length > 0, "production search should return an authorized indexed document");
    const cited = firstSearch.hits[0].citation;
    assert.equal(cited.artifactVersionId, first.artifactVersionId);
    assert.equal(cited.artifactHash.length, 64);
    assert.ok(cited.quotedText.includes("住宿标准"));
    assert.ok((db.prepare("SELECT COUNT(*) AS count FROM retrieval_query_cache").get() as { count: number }).count > 0);

    const unauthorized = createProductionRetrievalService({
      db,
      casRoot: path.join(root, "cas"),
      embedder: deterministicEmbedder,
      principal: { id: "other-user", type: "user", tenantId: "local" },
    });
    const unauthorizedSearch = await unauthorized.search("差旅住宿标准", 5, "2026-08-09T08:01:30.000Z");
    assert.equal(unauthorizedSearch.hits.length, 0);
    assert.throws(() => unauthorized.readKnowledgeDocument(knowledgeDocumentId), (error: unknown) => {
      assert.ok(error instanceof RetrievalError);
      assert.equal(error.code, "unauthorized");
      return true;
    });

    assert.equal(service.revokeKnowledgeDocument(knowledgeDocumentId, "2026-08-09T08:02:00.000Z"), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM retrieval_query_cache").get() as { count: number }).count, 0);
    assert.throws(() => service.readKnowledgeDocument(knowledgeDocumentId), /not available/);
    assert.equal((await service.search("差旅住宿标准", 5, "2026-08-09T08:02:30.000Z")).hits.length, 0);

    assert.equal(service.restoreKnowledgeDocument(knowledgeDocumentId, "2026-08-09T08:03:00.000Z"), true);
    assert.equal(service.readKnowledgeDocument(knowledgeDocumentId), firstText);
    assert.ok((await service.search("差旅住宿标准", 5, "2026-08-09T08:03:30.000Z")).hits.length > 0);

    const previousBinding = binding(db, knowledgeDocumentId);
    assert.ok(previousBinding);
    const failingService = createProductionRetrievalService({
      db,
      casRoot: path.join(root, "cas"),
      embedder: async () => {
        throw new RetrievalError("embedding_failed", "fixture embedding failure", { retryable: true });
      },
    });
    const failedText = "# 差旅制度\n\n差旅住宿标准改为每晚 600 元。";
    await assert.rejects(() => failingService.indexKnowledgeDocument({
      knowledgeDocumentId,
      title: "差旅制度（待发布）",
      fileName: "travel-policy.txt",
      sourceContentHash: sha256(failedText),
      parsedText: failedText,
      category: "finance_policy",
      now: "2026-08-09T08:04:00.000Z",
    }), /fixture embedding failure/);
    assert.deepEqual(binding(db, knowledgeDocumentId), previousBinding, "failed indexing must not switch the production binding");
    assert.equal(service.readKnowledgeDocument(knowledgeDocumentId), firstText);
    assert.equal((db.prepare("SELECT current_version_id FROM artifacts WHERE artifact_id=?").get(first.artifactId) as { current_version_id: string }).current_version_id, first.artifactVersionId, "failed staging version must not become current");

    const secondText = "# 差旅制度\n\n差旅住宿标准改为每晚 600 元，需提供合规发票。";
    const second = await service.indexKnowledgeDocument({
      knowledgeDocumentId,
      title: "差旅制度（新版）",
      fileName: "travel-policy.txt",
      sourceContentHash: sha256(secondText),
      parsedText: secondText,
      category: "finance_policy",
      now: "2026-08-09T08:05:00.000Z",
    });
    assert.notEqual(second.artifactVersionId, first.artifactVersionId);
    assert.notEqual(second.retrievalDocumentId, first.retrievalDocumentId);
    assert.equal(service.readKnowledgeDocument(knowledgeDocumentId), secondText);
    assert.equal((db.prepare("SELECT index_status FROM retrieval_documents WHERE document_id=?").get(first.retrievalDocumentId) as { index_status: string }).index_status, "stale");
    assert.equal((db.prepare("SELECT current_version_id FROM artifacts WHERE artifact_id=?").get(first.artifactId) as { current_version_id: string }).current_version_id, second.artifactVersionId);

    const hiddenText = "# 内部税务备忘\n\n仅归档索引，恢复前不得被当前用户检索。";
    const hiddenId = insertDoc(db, "内部税务备忘", "tax-note.txt", hiddenText);
    await service.indexKnowledgeDocument({
      knowledgeDocumentId: hiddenId,
      title: "内部税务备忘",
      fileName: "tax-note.txt",
      sourceContentHash: sha256(hiddenText),
      parsedText: hiddenText,
      category: "tax",
      available: false,
      now: "2026-08-09T08:06:00.000Z",
    });
    assert.throws(() => service.readKnowledgeDocument(hiddenId), /not available/);
    assert.equal((await service.search("内部税务备忘", 10, "2026-08-09T08:06:30.000Z")).hits.some((hit) => hit.citation.title === "内部税务备忘"), false);
    service.restoreKnowledgeDocument(hiddenId, "2026-08-09T08:07:00.000Z");
    assert.equal(service.readKnowledgeDocument(hiddenId), hiddenText);

    const rivalText = "# 其他公司的差旅制度\n\n差旅住宿标准同样包含住宿与审批关键词。";
    const rivalId = insertDoc(db, "其他公司的差旅制度", "rival-travel-policy.txt", rivalText);
    const rival = await service.indexKnowledgeDocument({
      knowledgeDocumentId: rivalId,
      title: "其他公司的差旅制度",
      fileName: "rival-travel-policy.txt",
      sourceContentHash: sha256(rivalText),
      parsedText: rivalText,
      category: "finance_policy",
      now: "2026-08-09T08:08:00.000Z",
    });
    const unscoped = await service.search("差旅住宿标准", 10, "2026-08-09T08:08:30.000Z");
    assert.ok(unscoped.hits.some((hit) => hit.citation.artifactVersionId === rival.artifactVersionId));
    const caseScoped = createProductionRetrievalService({
      db,
      casRoot: path.join(root, "cas"),
      embedder: deterministicEmbedder,
      allowedArtifactVersionIds: [second.artifactVersionId],
    });
    const scoped = await caseScoped.search("差旅住宿标准", 10, "2026-08-09T08:09:00.000Z");
    assert.ok(scoped.hits.length > 0, "case-scoped retrieval must retain the current case source");
    assert.ok(
      scoped.hits.every((hit) => hit.citation.artifactVersionId === second.artifactVersionId),
      "case-scoped retrieval must never return another case's source",
    );

    assert.deepEqual(LOCAL_RETRIEVAL_PRINCIPAL, { id: "local-user", type: "user", tenantId: "local" });
    console.log("retrieval-production-bridge: staged activation, immutable citations, ACL, archive restore and atomic version switching passed ✓");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("retrieval-production-bridge.test")) {
  retrievalProductionBridgeTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
