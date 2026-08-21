import type { RetrievalSearchResponse } from "./contracts";

export type KnowledgeRetrievalEvalCase = {
  id: string;
  query: string;
  shouldFind: boolean;
  relevantArtifactVersionIds: readonly string[];
  expectedQuotes: readonly string[];
  topK: number;
};

export type KnowledgeRetrievalEvalCaseResult = {
  id: string;
  query: string;
  shouldFind: boolean;
  passed: boolean;
  retrievedArtifactVersionIds: string[];
  recallAtK: number | null;
  reciprocalRank: number | null;
  ndcgAtK: number | null;
  quoteRecall: number | null;
  noAnswerCorrect: boolean | null;
  latencyMs: number;
  diagnostics: RetrievalSearchResponse["diagnostics"];
};

export type KnowledgeRetrievalEvalReport = {
  schemaVersion: 1;
  generatedAt: string;
  totals: { cases: number; passed: number; failed: number; positive: number; noAnswer: number };
  metrics: {
    recallAtK: number | null;
    mrr: number | null;
    ndcgAtK: number | null;
    quoteRecall: number | null;
    noAnswerAccuracy: number | null;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  results: KnowledgeRetrievalEvalCaseResult[];
};

export type KnowledgeRetrievalSearcher = {
  search(query: string, topK: number): Promise<RetrievalSearchResponse>;
};

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))];
}

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function ndcgAtK(relevance: number[], relevantCount: number): number {
  const dcg = relevance.reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0);
  const idealCount = Math.min(relevance.length, relevantCount);
  let ideal = 0;
  for (let index = 0; index < idealCount; index += 1) ideal += 1 / Math.log2(index + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

export async function evaluateKnowledgeRetrieval(
  searcher: KnowledgeRetrievalSearcher,
  cases: readonly KnowledgeRetrievalEvalCase[],
  now = () => new Date().toISOString(),
): Promise<KnowledgeRetrievalEvalReport> {
  const results: KnowledgeRetrievalEvalCaseResult[] = [];
  for (const evalCase of cases) {
    const response = await searcher.search(evalCase.query, evalCase.topK);
    const hits = response.hits.slice(0, evalCase.topK);
    const retrieved = hits.map((hit) => hit.citation.artifactVersionId);
    if (!evalCase.shouldFind) {
      const noAnswerCorrect = hits.length === 0;
      results.push({
        id: evalCase.id,
        query: evalCase.query,
        shouldFind: false,
        passed: noAnswerCorrect,
        retrievedArtifactVersionIds: retrieved,
        recallAtK: null,
        reciprocalRank: null,
        ndcgAtK: null,
        quoteRecall: null,
        noAnswerCorrect,
        latencyMs: response.diagnostics.elapsedMs,
        diagnostics: response.diagnostics,
      });
      continue;
    }

    const relevant = new Set(evalCase.relevantArtifactVersionIds);
    const relevantRetrieved = new Set(retrieved.filter((id) => relevant.has(id)));
    const rankedRelevant = new Set<string>();
    const relevance = hits.map((hit) => {
      const id = hit.citation.artifactVersionId;
      if (!relevant.has(id) || rankedRelevant.has(id)) return 0;
      rankedRelevant.add(id);
      return 1;
    });
    const firstRelevant = relevance.findIndex((value) => value === 1);
    const recallAtK = relevant.size === 0 ? 0 : relevantRetrieved.size / relevant.size;
    const reciprocalRank = firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
    const ndcg = ndcgAtK(relevance, relevant.size);
    const quotes = evalCase.expectedQuotes.map(normalized);
    const citedText = hits
      .filter((hit) => relevant.has(hit.citation.artifactVersionId))
      .map((hit) => normalized(hit.citation.quotedText));
    const quoteRecall = quotes.length === 0
      ? null
      : quotes.filter((quote) => citedText.some((text) => text.includes(quote))).length / quotes.length;
    const passed = recallAtK === 1 && (quoteRecall === null || quoteRecall === 1);
    results.push({
      id: evalCase.id,
      query: evalCase.query,
      shouldFind: true,
      passed,
      retrievedArtifactVersionIds: retrieved,
      recallAtK,
      reciprocalRank,
      ndcgAtK: ndcg,
      quoteRecall,
      noAnswerCorrect: null,
      latencyMs: response.diagnostics.elapsedMs,
      diagnostics: response.diagnostics,
    });
  }

  const positive = results.filter((result) => result.shouldFind);
  const noAnswer = results.filter((result) => !result.shouldFind);
  const passed = results.filter((result) => result.passed).length;
  return {
    schemaVersion: 1,
    generatedAt: now(),
    totals: { cases: results.length, passed, failed: results.length - passed, positive: positive.length, noAnswer: noAnswer.length },
    metrics: {
      recallAtK: average(positive.map((result) => result.recallAtK)),
      mrr: average(positive.map((result) => result.reciprocalRank)),
      ndcgAtK: average(positive.map((result) => result.ndcgAtK)),
      quoteRecall: average(positive.map((result) => result.quoteRecall)),
      noAnswerAccuracy: average(noAnswer.map((result) => result.noAnswerCorrect ? 1 : 0)),
      p50LatencyMs: percentile(results.map((result) => result.latencyMs), 0.5),
      p95LatencyMs: percentile(results.map((result) => result.latencyMs), 0.95),
    },
    results,
  };
}
