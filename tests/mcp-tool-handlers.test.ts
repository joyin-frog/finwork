import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { DeliverySpec } from "../lib/agent/run-contract.ts";

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
    // ════ finalize_deliverable (CR-Q1) ═══════════════════════════════════
    {
      const conv = mkdtempSync(path.join(dir, "conv-"));
      const outputDir = path.join(conv, "generate");
      mkdirSync(outputDir, { recursive: true });
      // 用 txt/csv 避免依赖 LibreOffice；合同 mime 对齐扩展名
      writeFileSync(path.join(outputDir, "科目表.txt"), "科目表内容");
      writeFileSync(path.join(outputDir, "对账单.csv"), "a,b\n1,2\n");
      writeFileSync(path.join(outputDir, "工资表.txt"), "payroll");
      writeFileSync(path.join(outputDir, "secret.txt"), "x");

      const contract: DeliverySpec = {
        version: 1,
        taskKind: "text",
        requiredDeliverables: [
          { id: "coa", mime: "text/plain", count: 1, qualityProfile: "generic" },
          { id: "stmt", mime: "text/csv", count: 1, qualityProfile: "generic" },
          { id: "payroll", mime: "text/plain", count: 1, qualityProfile: "generic" },
        ],
        expectationSnapshot: {},
      };

      const { createFinalizeDeliverableTool, FINALIZED_MARKER } = await import(
        "../lib/agent/mcp-tools/finalize-deliverable.ts"
      );
      const { sdk, handlers } = capturingSdk();
      createFinalizeDeliverableTool(sdk, outputDir, {
        runId: "mcp-run-1",
        deliverySpec: contract,
        conversationFilesDir: conv,
      });
      const finalize = handlers.get("finalize_deliverable")!;
      assert.ok(finalize, "finalize_deliverable 应注册");
      const markerPath = path.join(outputDir, FINALIZED_MARKER);

      // 1) FinalizeFile 合法声明 → delivered + evidence；不写 Run completed
      const r1 = await finalize({
        files: [
          { name: "科目表.txt", contractDeliverableId: "coa" },
          { name: "对账单.csv", contractDeliverableId: "stmt" },
        ],
      });
      assert.ok(!r1.isError, `合法声明不应报错: ${r1.content.map((c) => c.text).join("")}`);
      const finalized = r1.structuredContent?.finalized as Array<{ name: string; deliveredPath: string }>;
      assert.ok(Array.isArray(finalized) && finalized.length === 2);
      assert.ok(finalized.every((f) => f.deliveredPath.includes(`${path.sep}delivered${path.sep}`)));
      assert.ok(!("runStatus" in (r1.structuredContent ?? {})));
      assert.ok(existsSync(markerPath));
      assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf8")), ["科目表.txt", "对账单.csv"]);

      // 2) 路径被裁成 basename；未知 contractDeliverableId → 失败
      const r2 = await finalize({
        files: [{ name: "../../etc/secret.txt", contractDeliverableId: "nope" }],
      });
      assert.ok(r2.isError);
      assert.equal(r2.structuredContent?.code, "unknown_deliverable_id");
      assert.ok(
        !("failures" in (r2.structuredContent ?? {})),
        "没有逐文件失败明细时不得把 undefined 写入 structuredContent",
      );
      assert.match(r2.content.map((item) => item.text).join(""), /不存在的 contractDeliverableId: nope/);

      // 3) 继续声明 payroll
      const r3 = await finalize({
        files: [{ name: "工资表.txt", contractDeliverableId: "payroll" }],
      });
      assert.ok(!r3.isError, r3.content.map((c) => c.text).join(""));

      // 4) 空 name → isError
      const r4 = await finalize({ files: [{ name: "   ", contractDeliverableId: "coa" }] });
      assert.ok(r4.isError, "无有效文件名应报错");

      // 5) 缺 DeliverySpec → isError
      const { sdk: sdk2, handlers: h2 } = capturingSdk();
      createFinalizeDeliverableTool(sdk2, outputDir, { runId: "x" });
      const r5 = await h2.get("finalize_deliverable")!({
        files: [{ name: "科目表.txt", contractDeliverableId: "coa" }],
      });
      assert.ok(r5.isError);
      assert.equal(r5.structuredContent?.code, "missing_delivery_spec");
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
