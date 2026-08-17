/**
 * Retrieval v2 MCP contract tests for lib/agent/mcp-tools/knowledge.ts:
 *  1. topK clamp: topK > 5 should not throw, should clamp to 5
 *  2. search_knowledge advertises governed hybrid retrieval and immutable citations
 *  3. sanitized file names still resolve, but content comes from ArtifactStore rather than text mirrors
 */
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  initializeFinanceDatabase,
  openFinanceDatabase,
  insertKnowledgeDocument,
} from "../lib/db/sqlite.ts";
import { createHash } from "node:crypto";
import { createProductionRetrievalService } from "../lib/retrieval/index.ts";
import type { SdkLike } from "../lib/agent/mcp-tools/sdk-types.ts";

// ── mock SDK that captures name, description, schema, handler ────────────────
type HandlerFn = (args: unknown) => Promise<unknown>;
type ToolEntry = { desc: string; schema: unknown; handler: HandlerFn };

function makeMockSdk() {
  const tools = new Map<string, ToolEntry>();
  const sdk: SdkLike = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool(name: string, desc: string, schema: any, handler: HandlerFn) {
      tools.set(name, { desc, schema, handler });
      return { name };
    },
  };
  return { sdk, tools };
}

export const knowledgeMcpFixesTestPromise = (async () => {
  // ── Env setup: temp DB + knowledge dirs ──────────────────────────────────
  const baseDir = `/tmp/finance-agent-mcp-fixes-${process.pid}`;
  rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(baseDir, { recursive: true });

  process.env.FINANCE_AGENT_APP_DATA_DIR = baseDir;
  process.env.FINANCE_AGENT_DB_PATH = path.join(baseDir, "fixes.db");
  process.env.FINANCE_AGENT_KNOWLEDGE_DIR = path.join(baseDir, "knowledge");
  delete process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR;

  const db = initializeFinanceDatabase(openFinanceDatabase(path.join(baseDir, "fixes.db")));

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const retrieval = createProductionRetrievalService({
    db,
    casRoot: path.join(baseDir, "artifacts", "cas"),
  });

  // ── Seed immutable Retrieval v2 artifacts ───────────────────────────────
  // sanitizeDocFileName 只去扩展名/非法字符/控制字符，连字符保留。
  // DB: file_name="科目--新系统.xlsx", title="科目--新系统"；调用方仍可能请求 .txt 别名。
  const docTitle = "科目--新系统";
  const docText = "科目编码体系说明内容";
  const docHash = sha256(docText);
  const docId = insertKnowledgeDocument(
    {
      title: docTitle,
      file_name: `${docTitle}.xlsx`,
      mime_type: "text/plain",
      category: "general",
      size_bytes: 18,
      chunk_count: 0,
      content_hash: docHash,
    },
    db
  );
  await retrieval.indexKnowledgeDocument({
    knowledgeDocumentId: docId,
    title: docTitle,
    fileName: `${docTitle}.xlsx`,
    sourceContentHash: docHash,
    parsedText: docText,
    category: "general",
  });

  // Also add a plain doc that matches by exact title (regression guard)
  const exactTitle = "差旅报销制度";
  const exactText = "差旅住宿标准 500 元/晚";
  const exactHash = sha256(exactText);
  const exactId = insertKnowledgeDocument(
    {
      title: exactTitle,
      file_name: `${exactTitle}.txt`,
      mime_type: "text/plain",
      category: "general",
      size_bytes: 21,
      chunk_count: 0,
      content_hash: exactHash,
    },
    db
  );
  await retrieval.indexKnowledgeDocument({
    knowledgeDocumentId: exactId,
    title: exactTitle,
    fileName: `${exactTitle}.txt`,
    sourceContentHash: exactHash,
    parsedText: exactText,
    category: "general",
  });

  // ── Import tool creators (after env is set) ───────────────────────────────
  const { createSearchKnowledgeTool, createReadFileTool } = await import(
    "../lib/agent/mcp-tools/knowledge.ts"
  );
  const retrievalOptions = { getRetrievalService: () => retrieval };

  // ── Fix 1: topK clamp ────────────────────────────────────────────────────
  // FAIL BEFORE FIX: topK:10 throws zod validation error
  {
    const { sdk, tools } = makeMockSdk();
    createSearchKnowledgeTool(sdk, retrievalOptions);

    const entry = tools.get("search_knowledge");
    assert.ok(entry, "Fix1 FAIL: search_knowledge not registered");
    const { handler } = entry;

    // topK=10 must NOT throw; result should be an object (error or empty is fine,
    // but the schema must not reject it).
    let threw = false;
    let result: unknown;
    try {
      result = await handler({ query: "任意查询", topK: 10 });
    } catch (e) {
      threw = true;
      console.error("Fix1 threw:", e);
    }
    assert.equal(threw, false, "Fix1 FAIL: topK=10 threw an error (should clamp, not throw)");
    assert.ok(result && typeof result === "object", "Fix1 FAIL: result should be content object");

    console.log("knowledge-mcp-fixes Fix1: topK=10 no longer throws ✓");
  }

  // ── Fix 1b: default topK=3 path still works ──────────────────────────────
  {
    const { sdk, tools } = makeMockSdk();
    createSearchKnowledgeTool(sdk, retrievalOptions);

    const { handler } = tools.get("search_knowledge")!;
    let threw = false;
    try {
      await handler({ query: "测试" }); // no topK → default 3
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "Fix1b FAIL: default topK path threw");
    console.log("knowledge-mcp-fixes Fix1b: default topK=3 still works ✓");
  }

  // ── Fix 2: description exposes governed hybrid retrieval ────────────────
  {
    const { sdk, tools } = makeMockSdk();
    createSearchKnowledgeTool(sdk, retrievalOptions);

    const entry = tools.get("search_knowledge");
    assert.ok(entry, "Fix2 FAIL: search_knowledge not found");

    const desc = entry.desc;
    const mentionsBm25 = desc.includes("BM25");
    assert.ok(
      mentionsBm25,
      `Fix2 FAIL: description should mention BM25 retrieval. Got: "${desc}"`
    );

    assert.ok(
      desc.includes("ACL"),
      `Fix2 FAIL: description should mention ACL enforcement. Got: "${desc}"`
    );

    assert.ok(
      desc.includes("不可变来源版本") && desc.includes("定位") && desc.includes("内容哈希"),
      `Fix2 FAIL: description should require immutable citation evidence. Got: "${desc}"`
    );

    // Must mention topK cap
    const mentionsTopKCap = desc.includes("5") && (desc.includes("最大") || desc.includes("超出") || desc.includes("clamp") || desc.includes("取 5"));
    assert.ok(
      mentionsTopKCap,
      `Fix2 FAIL: description should state topK max is 5. Got: "${desc}"`
    );

    console.log("knowledge-mcp-fixes Fix2: description updated correctly ✓");
  }

  // ── Fix 3: resolveDoc fallback for a sanitized alias ─────────────────────
  {
    const { sdk, tools } = makeMockSdk();
    createReadFileTool(sdk, retrievalOptions);

    const { handler } = tools.get("read_file")!;

    // .txt alias resolves by normalized title; returned bytes come from ArtifactStore.
    const result = await handler({ fileName: "科目--新系统.txt" }) as { content: Array<{ text: string }> };
    assert.ok(result && typeof result === "object", "Fix3 FAIL: result should be an object");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      !text.startsWith("未找到"),
      `Fix3 FAIL: sanitized alias '科目--新系统.txt' should resolve to doc. Got: "${text.slice(0, 80)}"`
    );
    assert.ok(
      text.includes("科目编码体系说明内容") || text.includes("科目"),
      `Fix3 FAIL: resolved content should contain document text. Got: "${text.slice(0, 80)}"`
    );

    console.log("knowledge-mcp-fixes Fix3: sanitized name fallback resolves doc ✓");
  }

  // ── Fix 3b: exact title match still works (regression guard) ─────────────
  {
    const { sdk, tools } = makeMockSdk();
    createReadFileTool(sdk, retrievalOptions);

    const { handler } = tools.get("read_file")!;

    const result = await handler({ fileName: exactTitle }) as { content: Array<{ text: string }> };
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      !text.startsWith("未找到"),
      `Fix3b FAIL: exact title '${exactTitle}' should still resolve. Got: "${text.slice(0, 80)}"`
    );
    assert.ok(
      text.includes("差旅") || text.includes("500"),
      `Fix3b FAIL: exact doc content missing. Got: "${text.slice(0, 80)}"`
    );

    console.log("knowledge-mcp-fixes Fix3b: exact title still resolves ✓");
  }

  // ── Fix 3c: file_name exact match still works ────────────────────────────
  {
    const { sdk, tools } = makeMockSdk();
    createReadFileTool(sdk, retrievalOptions);

    const { handler } = tools.get("read_file")!;

    const result = await handler({ fileName: `${exactTitle}.txt` }) as { content: Array<{ text: string }> };
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      !text.startsWith("未找到"),
      `Fix3c FAIL: file_name '${exactTitle}.txt' should resolve. Got: "${text.slice(0, 80)}"`
    );

    console.log("knowledge-mcp-fixes Fix3c: file_name exact match still works ✓");
  }

  // ── Fix 4: large documents are read in bounded, addressable line ranges ──
  {
    const longTitle = "长篇财务制度";
    const longText = Array.from({ length: 450 }, (_, index) => `制度条款 ${index + 1}`).join("\n");
    const longHash = sha256(longText);
    const longId = insertKnowledgeDocument({
      title: longTitle,
      file_name: `${longTitle}.txt`,
      mime_type: "text/plain",
      category: "general",
      size_bytes: Buffer.byteLength(longText),
      chunk_count: 0,
      content_hash: longHash,
    }, db);
    await retrieval.indexKnowledgeDocument({
      knowledgeDocumentId: longId,
      title: longTitle,
      fileName: `${longTitle}.txt`,
      sourceContentHash: longHash,
      parsedText: longText,
      category: "general",
    });
    const { sdk, tools } = makeMockSdk();
    createReadFileTool(sdk, retrievalOptions);
    const result = await tools.get("read_file")!.handler({
      fileName: `${longTitle}.txt`,
      startLine: 401,
      endLine: 410,
    }) as { content: Array<{ text: string }> };
    const text = result.content[0]?.text ?? "";
    assert.match(text, /第 401-410 行/);
    assert.match(text, /401: 制度条款 401/);
    assert.doesNotMatch(text, /400: 制度条款 400/);
    assert.match(text, /startLine=411/);
    console.log("knowledge-mcp-fixes Fix4: bounded line-range reading ✓");
  }

  // ── Fix 4b: one giant line can continue by stable character offset ───────
  {
    const giantTitle = "单行压缩制度";
    const giantText = "A".repeat(60_000);
    const giantHash = sha256(giantText);
    const giantId = insertKnowledgeDocument({
      title: giantTitle,
      file_name: `${giantTitle}.txt`,
      mime_type: "text/plain",
      category: "general",
      size_bytes: Buffer.byteLength(giantText),
      chunk_count: 0,
      content_hash: giantHash,
    }, db);
    await retrieval.indexKnowledgeDocument({
      knowledgeDocumentId: giantId,
      title: giantTitle,
      fileName: `${giantTitle}.txt`,
      sourceContentHash: giantHash,
      parsedText: giantText,
      category: "general",
    });
    const { sdk, tools } = makeMockSdk();
    createReadFileTool(sdk, retrievalOptions);
    const first = await tools.get("read_file")!.handler({ fileName: `${giantTitle}.txt` }) as {
      content: Array<{ text: string }>;
    };
    assert.match(first.content[0]?.text ?? "", /startChar=50000/);
    const second = await tools.get("read_file")!.handler({
      fileName: `${giantTitle}.txt`,
      startChar: 50_000,
      maxChars: 10_000,
    }) as { content: Array<{ text: string }> };
    assert.match(second.content[0]?.text ?? "", /字符 50000-59999/);
    assert.doesNotMatch(second.content[0]?.text ?? "", /内容未读完/);
    console.log("knowledge-mcp-fixes Fix4b: giant-line character pagination ✓");
  }

  // Cleanup env (best-effort; test harness may re-run)
  delete process.env.FINANCE_AGENT_APP_DATA_DIR;
  delete process.env.FINANCE_AGENT_DB_PATH;
  delete process.env.FINANCE_AGENT_KNOWLEDGE_DIR;

  db.close();

  console.log("knowledge-mcp-fixes: all checks passed ✓");
})();
