import assert from "node:assert/strict";
import { evaluateKnowledgeRetrieval } from "../lib/retrieval/evaluation.ts";
import type { RetrievalSearchResponse } from "../lib/retrieval/contracts.ts";

function response(ids: string[], quotes: string[], elapsedMs: number): RetrievalSearchResponse {
  return {
    hits: ids.map((id, index) => ({
      chunkId: `chunk-${index}`,
      text: quotes[index] ?? "irrelevant",
      score: 1 - index / 10,
      citation: {
        artifactId: `artifact-${id}`,
        artifactVersionId: id,
        artifactHash: "a".repeat(64),
        documentId: `document-${id}`,
        documentType: "policy",
        title: `title-${id}`,
        locator: { kind: "paragraph", nodeId: `node-${index}` },
        quotedText: quotes[index] ?? "irrelevant",
        quoteHash: "b".repeat(64),
        bm25Score: 1,
        rerankScore: 1,
      },
    })),
    diagnostics: {
      mode: "bm25",
      cacheHit: false,
      authorizedDocumentCount: 3,
      bm25CandidateCount: 3,
      expandedCandidateCount: 3,
      scoredCandidateCount: 3,
      elapsedMs,
      indexVersion: "bm25-index-v1",
    },
  };
}

export const retrievalEvaluationTestPromise = (async () => {
  const report = await evaluateKnowledgeRetrieval({
    search: async (query) => query === "complete"
      ? response(["v1", "noise"], ["住宿费每晚不超过500元", "无关"], 10)
      : query === "rank-two"
        ? response(["noise", "v2"], ["无关", "董事会批准日期为2026年1月5日"], 20)
        : response(["noise"], ["无关"], 30),
  }, [
    { id: "one", query: "complete", shouldFind: true, relevantArtifactVersionIds: ["v1"], expectedQuotes: ["住宿费每晚不超过 500 元"], topK: 5 },
    { id: "two", query: "rank-two", shouldFind: true, relevantArtifactVersionIds: ["v2"], expectedQuotes: ["董事会批准日期为2026年1月5日"], topK: 5 },
    { id: "three", query: "no-answer", shouldFind: false, relevantArtifactVersionIds: [], expectedQuotes: [], topK: 5 },
  ], () => "2026-08-16T00:00:00.000Z");

  assert.deepEqual(report.totals, { cases: 3, passed: 2, failed: 1, positive: 2, noAnswer: 1 });
  assert.equal(report.metrics.recallAtK, 1);
  assert.equal(report.metrics.mrr, 0.75);
  assert.equal(report.metrics.quoteRecall, 1);
  assert.equal(report.metrics.noAnswerAccuracy, 0);
  assert.equal(report.metrics.p50LatencyMs, 20);
  assert.equal(report.metrics.p95LatencyMs, 30);
  assert.equal(report.results[1].reciprocalRank, 0.5);
  assert.equal(report.results[2].noAnswerCorrect, false);
  console.log("retrieval-evaluation: Recall@K, MRR, NDCG, quote, no-answer and latency metrics passed ✓");
})();

if (process.argv[1]?.includes("retrieval-evaluation.test")) {
  retrievalEvaluationTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
