import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// 复用全套既有 mockSdk 模式:捕获 sdk.tool(name, desc, schema, handler) 注册的 handler。
type Handler = (args: unknown) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;
function capturingSdk() {
  const handlers = new Map<string, Handler>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return { name };
    },
  };
  return { sdk, handlers };
}

export const mcpToolHandlersTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-mcp-test-"));
  const origDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = path.join(dir, "test.db");

  try {
    // ════ finalize_deliverable ═══════════════════════════════════════════
    {
      const outputDir = mkdtempSync(path.join(dir, "out-"));
      const { createFinalizeDeliverableTool, FINALIZED_MARKER } = await import("../lib/agent/mcp-tools/finalize-deliverable.ts");
      const { sdk, handlers } = capturingSdk();
      createFinalizeDeliverableTool(sdk, outputDir);
      const finalize = handlers.get("finalize_deliverable")!;
      assert.ok(finalize, "finalize_deliverable 应注册");
      const markerPath = path.join(outputDir, FINALIZED_MARKER);
      const readMarker = () => JSON.parse(readFileSync(markerPath, "utf8")) as string[];

      // 1) 合法声明 → 写 marker(dotfile),structuredContent.finalized 一致
      const r1 = await finalize({ files: ["科目表.xlsx", "对账单.csv"] });
      assert.ok(!r1.isError, "合法声明不应报错");
      assert.deepEqual(r1.structuredContent?.finalized, ["科目表.xlsx", "对账单.csv"]);
      assert.deepEqual(readMarker(), ["科目表.xlsx", "对账单.csv"], "marker 应写入声明文件名");

      // 2) 路径被裁成 basename(防目录穿越)
      const r2 = await finalize({ files: ["../../etc/secret.pdf"] });
      assert.ok(!r2.isError);
      assert.ok(readMarker().includes("secret.pdf"), "应只保留 basename");
      assert.ok(!readMarker().some((n) => n.includes("/")), "marker 中不应含路径分隔符");

      // 3) 合并去重:重复声明不产生重复项
      const r3 = await finalize({ files: ["科目表.xlsx", "工资表.xlsx"] });
      const merged = r3.structuredContent?.finalized as string[];
      assert.equal(merged.filter((n) => n === "科目表.xlsx").length, 1, "重复声明应去重");
      assert.ok(merged.includes("工资表.xlsx"), "新声明应并入");

      // 4) 空/纯空白文件名 → isError,且 marker 不被破坏
      const before = readMarker();
      const r4 = await finalize({ files: ["   "] });
      assert.ok(r4.isError, "无有效文件名应报错");
      assert.deepEqual(readMarker(), before, "报错路径不应改动 marker");
    }

    // ════ record_document_metadata ═══════════════════════════════════════
    {
      const { createRecordDocumentMetadataTool } = await import("../lib/agent/mcp-tools/document-metadata.ts");
      const { insertKnowledgeDocument, getKnowledgeDocumentById } = await import("../lib/db/sqlite.ts");
      const { sdk, handlers } = capturingSdk();
      createRecordDocumentMetadataTool(sdk);
      const recordMeta = handlers.get("record_document_metadata")!;
      assert.ok(recordMeta, "record_document_metadata 应注册");

      // 1) 文档不存在 → isError
      const miss = await recordMeta({ documentId: 99999, metadata: { docType: "合同" } });
      assert.ok(miss.isError, "不存在的文档应报错");
      assert.ok(miss.content.map((c) => c.text).join("").includes("不存在"), "错误文案应说明不存在");

      // 2) 存在的文档 → 写 draft metadata 并持久化
      const docId = insertKnowledgeDocument({
        title: "采购合同", file_name: "采购合同.pdf", mime_type: "application/pdf",
        category: "general", size_bytes: 100, chunk_count: 0, content_hash: "hash-meta-1",
      });
      const ok = await recordMeta({
        documentId: docId,
        metadata: { docType: "合同", counterparty: "ACME 供应商", amount: 50000, amountCurrency: "CNY" },
      });
      assert.ok(!ok.isError, "合法写入不应报错");
      assert.deepEqual(ok.structuredContent, { documentId: docId, metaStatus: "draft" });

      const row = getKnowledgeDocumentById(docId)!;
      assert.equal(row.meta_status, "draft", "写入后状态应为 draft(待用户确认)");
      const persisted = JSON.parse(row.metadata as string) as { docType: string; amount: number };
      assert.equal(persisted.docType, "合同", "metadata 应持久化");
      assert.equal(persisted.amount, 50000);

      // 3) 幂等:同 key 二次调用返回同一结果(命中缓存)
      const key = "doc-meta-key-001";
      const a = await recordMeta({ documentId: docId, metadata: { docType: "合同" }, idempotency_key: key });
      const b = await recordMeta({ documentId: docId, metadata: { docType: "合同" }, idempotency_key: key });
      assert.deepEqual(b.structuredContent, a.structuredContent, "同 idempotency_key 应返回缓存结果");
    }
  } finally {
    if (origDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = origDb;
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("mcp-tool-handlers: all checks passed ✓");
})();
