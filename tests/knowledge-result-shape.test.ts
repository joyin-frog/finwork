import assert from "node:assert/strict";
import { createSearchKnowledgeTool } from "../lib/agent/mcp-tools/knowledge.ts";
import type { ProductionRetrievalService } from "../lib/retrieval/production.ts";

// 防回归:MCP 工具结果必须是 {content:[{type,text}]} object,不能是 string
// (曾因返回 string 触发 "Invalid tools/call result: expected object, received string",search_knowledge 长期 isError)。
export const knowledgeResultShapeTestPromise = (async () => {
  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = { tool: (n: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => { handlers.set(n, h); return { name: n }; } };
  const service = {
    search: async () => ({
      hits: [],
      diagnostics: {
        mode: "bm25",
        cacheHit: false,
        authorizedDocumentCount: 0,
        bm25CandidateCount: 0,
        expandedCandidateCount: 0,
        scoredCandidateCount: 0,
        elapsedMs: 0,
        indexVersion: "bm25-index-v1",
      },
    }),
    ensureKnowledgeDocumentsReady: async () => ({ indexed: 0, skipped: 0, failed: 0, failures: [] }),
  } as unknown as ProductionRetrievalService;
  const options = { getRetrievalService: () => service };
  createSearchKnowledgeTool(sdk, options);

  function assertShape(r: unknown, label: string) {
    assert.ok(r && typeof r === "object" && !Array.isArray(r), `${label}: 应返回 object,不是 string/数组`);
    const c = (r as { content?: unknown }).content;
    assert.ok(Array.isArray(c) && c.length > 0, `${label}: 应有 content 数组`);
    const first = (c as Array<{ type?: string; text?: unknown }>)[0];
    assert.equal(first.type, "text", `${label}: content[0].type=text`);
    assert.equal(typeof first.text, "string", `${label}: content[0].text 是 string`);
  }

  // 检索与精读共用同一个工具，两条路径都必须返回合法 MCP object。
  assertShape(await handlers.get("search_knowledge")!({ query: "__no_such_kw_9999__" }), "search_knowledge");
  assertShape(await handlers.get("search_knowledge")!({ fileName: "__no_such_file_9999__" }), "search_knowledge(fileName)");

  console.log("knowledge-result-shape: unified search/read tool returns valid {content} objects ✓");
})();
