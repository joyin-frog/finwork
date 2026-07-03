/**
 * TDD tests for three fixes in lib/agent/mcp-tools/knowledge.ts:
 *  1. topK clamp: topK > 5 should not throw, should clamp to 5
 *  2. search_knowledge description: must mention keyword/literal match and query_knowledge for exact match
 *  3. resolveDoc fallback: sanitized file name (e.g. "科目--新系统.txt") should resolve to matching doc
 */
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  initializeFinanceDatabase,
  openFinanceDatabase,
  insertKnowledgeDocument,
} from "../lib/db/sqlite.ts";
import { writeTextMirror } from "../lib/knowledge/storage.ts";
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

  // ── Seed: 复现生产 bug——上传原名是 .xlsx，模型却用镜像名 .txt 请求 ──
  // sanitizeDocFileName 只去扩展名/非法字符/控制字符，连字符保留。
  // DB: file_name="科目--新系统.xlsx", title="科目--新系统"；镜像文件 = "科目--新系统.txt"。
  // 生产 bug: read_file("科目--新系统.txt") 与 file_name/title 都不精确相等 → 未找到，
  // 而 query_knowledge 的 rg 能读到镜像文件。fallback 按净化 title 匹配后应命中。
  const docTitle = "科目--新系统";
  const docHash = "abc123fixture";
  writeTextMirror(docHash, "科目编码体系说明内容");
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

  // Also add a plain doc that matches by exact title (regression guard)
  const exactTitle = "差旅报销制度";
  const exactHash = "def456fixture";
  writeTextMirror(exactHash, "差旅住宿标准 500 元/晚");
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

  // ── Import tool creators (after env is set) ───────────────────────────────
  const { createSearchKnowledgeTool, createReadFileTool } = await import(
    "../lib/agent/mcp-tools/knowledge.ts"
  );

  // ── Fix 1: topK clamp ────────────────────────────────────────────────────
  // FAIL BEFORE FIX: topK:10 throws zod validation error
  {
    const { sdk, tools } = makeMockSdk();
    createSearchKnowledgeTool(sdk);

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
    createSearchKnowledgeTool(sdk);

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

  // ── Fix 2: description mentions keyword/literal match ────────────────────
  {
    const { sdk, tools } = makeMockSdk();
    createSearchKnowledgeTool(sdk);

    const entry = tools.get("search_knowledge");
    assert.ok(entry, "Fix2 FAIL: search_knowledge not found");

    const desc = entry.desc;
    // Must mention keyword/literal match (关键词/字面匹配 or 关键词匹配)
    const mentionsKeywordMatch =
      desc.includes("关键词") && (desc.includes("字面") || desc.includes("精确") || desc.includes("literal"));
    assert.ok(
      mentionsKeywordMatch,
      `Fix2 FAIL: description should mention keyword/literal match. Got: "${desc}"`
    );

    // Must NOT present itself as semantic search
    assert.ok(
      !desc.includes("语义"),
      `Fix2 FAIL: description should NOT mention semantic search. Got: "${desc}"`
    );

    // Must mention that numbers/proper nouns work better
    const mentionsNumerics = desc.includes("数字") || desc.includes("专有名词") || desc.includes("科目");
    assert.ok(
      mentionsNumerics,
      `Fix2 FAIL: description should hint that numbers/proper nouns work best. Got: "${desc}"`
    );

    // Must mention topK cap
    const mentionsTopKCap = desc.includes("5") && (desc.includes("最大") || desc.includes("超出") || desc.includes("clamp") || desc.includes("取 5"));
    assert.ok(
      mentionsTopKCap,
      `Fix2 FAIL: description should state topK max is 5. Got: "${desc}"`
    );

    console.log("knowledge-mcp-fixes Fix2: description updated correctly ✓");
  }

  // ── Fix 3: resolveDoc fallback for mirror name ───────────────────────────
  // read_file("科目--新系统.txt") — rg 在 text-by-name/ 看到的镜像名，
  // 与 DB 的 file_name("科目--新系统.xlsx")不相等 → 靠净化 title fallback 命中
  {
    const { sdk, tools } = makeMockSdk();
    createReadFileTool(sdk);

    const { handler } = tools.get("read_file")!;

    // Call with the mirror file name (what rg sees in text-by-name/)
    const result = await handler({ fileName: "科目--新系统.txt" }) as { content: Array<{ text: string }> };
    assert.ok(result && typeof result === "object", "Fix3 FAIL: result should be an object");
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      !text.startsWith("未找到"),
      `Fix3 FAIL: mirror name '科目--新系统.txt' should resolve to doc. Got: "${text.slice(0, 80)}"`
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
    createReadFileTool(sdk);

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
    createReadFileTool(sdk);

    const { handler } = tools.get("read_file")!;

    const result = await handler({ fileName: `${exactTitle}.txt` }) as { content: Array<{ text: string }> };
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      !text.startsWith("未找到"),
      `Fix3c FAIL: file_name '${exactTitle}.txt' should resolve. Got: "${text.slice(0, 80)}"`
    );

    console.log("knowledge-mcp-fixes Fix3c: file_name exact match still works ✓");
  }

  // Cleanup env (best-effort; test harness may re-run)
  delete process.env.FINANCE_AGENT_APP_DATA_DIR;
  delete process.env.FINANCE_AGENT_DB_PATH;
  delete process.env.FINANCE_AGENT_KNOWLEDGE_DIR;

  console.log("knowledge-mcp-fixes: all checks passed ✓");
})();
