import { lexicalTerms, normalizeRetrievalText } from "@/lib/retrieval/lexical";

const GENERIC_TERMS = new Set([
  "用户", "工作", "任务", "处理", "进行", "需要", "使用", "当前", "相关",
  "这个", "那个", "一下", "帮我", "内容", "结果", "数据", "文件", "公司",
  "财务", "分析", "查看", "报表", "报告", "问题", "要求", "情况", "默认",
  "user", "task", "work", "current", "file", "data", "report", "analysis",
]);

function isCjk(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(lexicalTerms(value).filter((term) => {
    if (GENERIC_TERMS.has(term)) return false;
    if (isCjk(term)) return Array.from(term).length >= 2;
    return term.length >= 3 || /^\d+(?:\.\d+)?$/u.test(term);
  }));
}

export type MemoryRelevance = {
  relevant: boolean;
  score: number;
  matchedTerms: string[];
};

/**
 * Conservative lexical gate for global memory. Scope matching happens in the
 * store first; this function proves that the current task also names the same
 * topic. No query or no meaningful overlap deliberately returns no match.
 */
export function evaluateMemoryRelevance(queryText: string, memoryText: string): MemoryRelevance {
  const query = normalizeRetrievalText(queryText);
  const memory = normalizeRetrievalText(memoryText);
  if (!query || !memory) return { relevant: false, score: 0, matchedTerms: [] };

  const queryTerms = meaningfulTerms(query);
  const memoryTerms = meaningfulTerms(memory);
  if (queryTerms.size === 0 || memoryTerms.size === 0) {
    return { relevant: false, score: 0, matchedTerms: [] };
  }

  const matchedTerms = [...memoryTerms]
    .filter((term) => queryTerms.has(term))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (matchedTerms.length === 0) return { relevant: false, score: 0, matchedTerms: [] };

  // The smaller side represents the focused topic vocabulary. Requiring at
  // least one non-generic word/bigram lets short exact questions work while
  // generic requests such as “分析这个报表” select nothing.
  const score = Math.min(1, matchedTerms.length / Math.min(queryTerms.size, memoryTerms.size));
  return {
    relevant: score >= 0.2,
    score,
    matchedTerms: matchedTerms.slice(0, 6),
  };
}
