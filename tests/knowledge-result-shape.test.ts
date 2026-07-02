import assert from "node:assert/strict";
import { createSearchKnowledgeTool, createQueryKnowledgeTool, createReadFileTool } from "../lib/agent/mcp-tools/knowledge.ts";

// 防回归:MCP 工具结果必须是 {content:[{type,text}]} object,不能是 string
// (曾因返回 string 触发 "Invalid tools/call result: expected object, received string",search_knowledge 长期 isError)。
export const knowledgeResultShapeTestPromise = (async () => {
  const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = { tool: (n: string, _d: string, _s: unknown, h: (a: unknown) => unknown) => { handlers.set(n, h); return { name: n }; } };
  createSearchKnowledgeTool(sdk);
  createQueryKnowledgeTool(sdk);
  createReadFileTool(sdk);

  function assertShape(r: unknown, label: string) {
    assert.ok(r && typeof r === "object" && !Array.isArray(r), `${label}: 应返回 object,不是 string/数组`);
    const c = (r as { content?: unknown }).content;
    assert.ok(Array.isArray(c) && c.length > 0, `${label}: 应有 content 数组`);
    const first = (c as Array<{ type?: string; text?: unknown }>)[0];
    assert.equal(first.type, "text", `${label}: content[0].type=text`);
    assert.equal(typeof first.text, "string", `${label}: content[0].text 是 string`);
  }

  // 三个工具的错误/空路径都必须返回 object(不依赖真实数据,不存在的文件/查询即可触发)
  assertShape(await handlers.get("read_file")!({ fileName: "__no_such_file_9999__" }), "read_file");
  assertShape(await handlers.get("search_knowledge")!({ query: "__no_such_kw_9999__" }), "search_knowledge");
  assertShape(await handlers.get("query_knowledge")!({ command: "ls" }), "query_knowledge");

  console.log("knowledge-result-shape: 三个知识库工具均返回合法 {content} object ✓");
})();
