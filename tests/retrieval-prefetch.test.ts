import assert from "node:assert/strict";
import type { ProductionRetrievalService } from "../lib/retrieval/production.ts";
import { prefetchRouterKnowledge } from "../lib/agent/retrieval-prefetch.ts";

const hit = {
  chunkId: "chunk-1",
  text: "差旅住宿上限为 500 元。",
  score: 1,
  citation: {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactHash: "a".repeat(64),
    documentId: "document-1",
    documentType: "policy",
    title: "差旅制度",
    locator: { kind: "text", nodeId: "paragraph-1", charStart: 0, charEnd: 14 },
    quotedText: "差旅住宿上限为 500 元。",
    quoteHash: "b".repeat(64),
    bm25Score: 1,
    rerankScore: 1,
  },
};

export const retrievalPrefetchTestPromise = (async () => {
  const messages = [{ role: "user" as const, content: "公司差旅住宿上限是多少？" }];
  let calls = 0;
  const service = {
    search: async () => {
      calls += 1;
      return {
        hits: [hit],
        diagnostics: {
          mode: "bm25" as const,
          cacheHit: false,
          authorizedDocumentCount: 1,
          bm25CandidateCount: 1,
          expandedCandidateCount: 1,
          scoredCandidateCount: 1,
          elapsedMs: 1,
          indexVersion: "bm25-index-v1",
        },
      };
    },
  } as unknown as ProductionRetrievalService;

  const untouched = await prefetchRouterKnowledge(messages, {
    intent: "trivial_qa",
    needsRag: false,
    ragQueries: ["差旅住宿"],
    reasoning: "fixture",
  }, () => service);
  assert.equal(untouched, messages);
  assert.equal(calls, 0);

  const enriched = await prefetchRouterKnowledge(messages, {
    intent: "rag_qa",
    needsRag: true,
    ragQueries: ["差旅住宿", "差旅住宿", "住宿上限"],
    reasoning: "fixture",
  }, () => service);
  assert.equal(calls, 2, "duplicate router queries should be coalesced before prefetch");
  assert.equal(messages[0].content, "公司差旅住宿上限是多少？", "prefetch must not mutate persisted messages");
  assert.match(enriched[0].content, /系统预取的知识库候选/);
  assert.match(enriched[0].content, /差旅住宿上限为 500 元/);
  assert.match(enriched[0].content, /version-1/);
  assert.equal((enriched[0].content.match(/来源：差旅制度/g) ?? []).length, 1, "duplicate hits should be collapsed");
  assert.match(enriched[0].content, /<external_context>/);

  const failed = await prefetchRouterKnowledge(messages, {
    intent: "rag_qa",
    needsRag: true,
    ragQueries: ["差旅住宿"],
    reasoning: "fixture",
  }, () => ({ search: async () => { throw new Error("offline"); } }) as unknown as ProductionRetrievalService);
  assert.equal(failed, messages, "prefetch failures must not block the Agent tool fallback");
  console.log("retrieval-prefetch: router query prefetch, dedupe and failure fallback passed ✓");
})();

if (process.argv[1]?.includes("retrieval-prefetch.test")) {
  retrievalPrefetchTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
