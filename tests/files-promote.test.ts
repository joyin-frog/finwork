/**
 * files-promote.test.ts
 *
 * 覆盖 promote 动作的核心后端逻辑(DB 层 + ingestDocument 集成):
 * T1: promote 上传附件 → knowledge_documents 出现该文档
 * T2: 重复 content_hash → 优雅提示不重复入库
 * T3: 非法 fileId(know: 前缀,知识库类型) → 拒绝
 * T4: 不存在的文件路径 → 报错
 * T5: promote 生成类附件 → 入库成功
 * T6: 审计落点(file_promoted + file_promote_skip)
 *
 * 隔离策略:设置 FINANCE_AGENT_DB_PATH 指向独立 DB,在模块 import 之前生效,
 * 确保 getDb() 单例指向测试 DB。知识库文件也重定向到临时目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const filesPromoteTestPromise = (async () => {
  // ─── 环境隔离(在 import 之前设置 env,控制 getDb() 单例路径) ──────────────
  const appData = mkdtempSync(path.join(tmpdir(), "fa-promote-"));
  const dbPath = path.join(appData, "test.db");

  const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
  const savedAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const savedKnowledgeDir = process.env.FINANCE_AGENT_KNOWLEDGE_DIR;
  const savedKnowledgeTextDir = process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR;

  // 让 getDb() / getDatabasePath() 指向隔离 DB
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  process.env.FINANCE_AGENT_APP_DATA_DIR = appData;
  process.env.FINANCE_AGENT_KNOWLEDGE_DIR = path.join(appData, "knowledge");
  process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR = path.join(appData, "knowledge-text");

  const {
    openFinanceDatabase,
    initializeFinanceDatabase,
  } = await import("../lib/db/sqlite.ts");

  // 初始化测试 DB
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);

  // 创建测试数据目录和文件
  const convFilesDir = path.join(appData, "files", "201");
  const uploadDir = path.join(convFilesDir, "upload");
  const generateDir = path.join(convFilesDir, "generate");
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(generateDir, { recursive: true });

  const uploadFilePath = path.join(uploadDir, "合同范本.txt");
  const genFilePath = path.join(generateDir, "分析报告.txt");
  writeFileSync(uploadFilePath, "这是一份测试合同文件，用于测试加入知识库功能。内容需要足够多才能通过空内容检查。");
  writeFileSync(genFilePath, "这是一份AI生成的分析报告，用于测试加入知识库功能。内容需要足够多才能通过空内容检查。");

  // 插入对话 + 消息 + 附件
  db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(201, "测试会话promote");
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', 'upload')").run(2001, 201);
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', 'gen')").run(2002, 201);
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("promote-upload-1", 2001, "合同范本.txt", "text/plain", 100, "upload/合同范本.txt", "user", 0);
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("promote-gen-1", 2002, "分析报告.txt", "text/plain", 100, "generate/分析报告.txt", "assistant", 0);

  const { ingestDocument } = await import("../lib/knowledge/pipeline.ts");
  const { computeFileHash } = await import("../lib/knowledge/storage.ts");

  // ─── 核心 promote 逻辑(测试中直接调用,与 route.ts 同款逻辑) ───────────────

  type PromoteResult =
    | { ok: true; alreadyExists?: false; documentId: number }
    | { ok: true; alreadyExists: true; documentId: number }
    | { ok: false; error: string };

  async function runPromote(fileId: string): Promise<PromoteResult> {
    // 只允许 attach: 和 lib: 前缀
    if (!fileId.startsWith("attach:") && !fileId.startsWith("lib:")) {
      return { ok: false, error: "只能对上传/生成文件执行加入知识库操作" };
    }

    // 解析物理路径
    let absPath: string | null = null;
    if (fileId.startsWith("attach:")) {
      const id = fileId.slice(7);
      const row = db.prepare(`
        SELECT a.storage_path, m.conversation_id
        FROM chat_attachments a
        LEFT JOIN chat_messages m ON a.message_id = m.id
        WHERE a.id = ?
      `).get(id) as { storage_path: string; conversation_id: number | null } | undefined;
      if (row?.conversation_id) {
        absPath = path.join(path.join(appData, "files", String(row.conversation_id)), row.storage_path);
      }
    }
    if (!absPath) return { ok: false, error: "文件不存在" };

    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(absPath)) return { ok: false, error: "文件不存在" };

    const fileBuffer = readFileSync(absPath);
    const contentHash = computeFileHash(fileBuffer);

    const existing = db.prepare("SELECT id FROM knowledge_documents WHERE content_hash=?").get(contentHash) as
      { id: number } | undefined;

    if (existing) {
      db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
        "file_promote_skip",
        JSON.stringify({ fileId, contentHash, existingDocId: existing.id, at: new Date().toISOString() })
      );
      return { ok: true, alreadyExists: true, documentId: existing.id };
    }

    const fileName = path.basename(absPath);
    const sizeBytes = fileBuffer.byteLength;

    const { documentId } = await ingestDocument({
      filePath: absPath,
      title: fileName,
      fileName,
      mimeType: "text/plain",
      sizeBytes,
      storagePath: absPath,
    });

    db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
      "file_promoted",
      JSON.stringify({ fileId, documentId, at: new Date().toISOString() })
    );

    return { ok: true, documentId };
  }

  // ─── T1: promote 上传附件 → knowledge_documents 出现 ───────────────────
  {
    const result = await runPromote("attach:promote-upload-1");
    assert.equal(result.ok, true, "T1: promote 应成功");
    assert.ok(!("alreadyExists" in result && result.alreadyExists), "T1: 首次入库不应标 alreadyExists");
    assert.ok(result.ok && typeof result.documentId === "number", "T1: 应返回 documentId");

    if (result.ok) {
      const doc = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(result.documentId) as
        { id: number; file_name: string } | undefined;
      assert.ok(doc, "T1: knowledge_documents 应有该文档");
      assert.equal(doc?.file_name, "合同范本.txt", "T1: 文件名正确");
    }

    console.log("files-promote T1: promote 上传附件入知识库 ✓");
  }

  // ─── T2: 重复 content_hash → 不重复入库,优雅返回 ────────────────────────
  {
    const result2 = await runPromote("attach:promote-upload-1");
    assert.equal(result2.ok, true, "T2: 重复 promote 返回 ok:true");
    assert.ok(result2.ok && result2.alreadyExists === true, "T2: 应标记 alreadyExists=true");

    const rows = db.prepare("SELECT id FROM knowledge_documents WHERE file_name = '合同范本.txt'").all() as { id: number }[];
    assert.equal(rows.length, 1, "T2: 重复入库后 knowledge_documents 应只有 1 条");

    console.log("files-promote T2: 重复 content_hash 优雅处理 ✓");
  }

  // ─── T3: know: 前缀(知识库类型) → 拒绝 ──────────────────────────────────
  {
    const result = await runPromote("know:999");
    assert.equal(result.ok, false, "T3: know: 前缀应返回 ok:false");
    assert.ok(!result.ok && result.error?.includes("只能"), "T3: 错误信息应说明限制");

    console.log("files-promote T3: know: 前缀拒绝 ✓");
  }

  // ─── T4: 不存在的 attach → 报错 ──────────────────────────────────────────
  {
    const result = await runPromote("attach:not-exist-at-all");
    assert.equal(result.ok, false, "T4: 不存在的文件应返回 ok:false");

    console.log("files-promote T4: 不存在文件 → 报错 ✓");
  }

  // ─── T5: promote 生成类附件 → 入库成功 ────────────────────────────────────
  {
    const result = await runPromote("attach:promote-gen-1");
    assert.equal(result.ok, true, "T5: generated 文件 promote 应成功");
    assert.ok(result.ok && !result.alreadyExists, "T5: 首次入库不 alreadyExists");

    if (result.ok) {
      const doc = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(result.documentId) as
        { file_name: string } | undefined;
      assert.ok(doc, "T5: knowledge_documents 应有生成文件记录");
      assert.equal(doc?.file_name, "分析报告.txt", "T5: 文件名正确");
    }

    console.log("files-promote T5: promote 生成类文件 ✓");
  }

  // ─── T6: 审计落点检查 ──────────────────────────────────────────────────────
  {
    const promotedAudit = db.prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'file_promoted' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(promotedAudit, "T6: 应有 file_promoted 审计记录");
    const p = JSON.parse(promotedAudit!.payload) as { fileId: string; documentId: number };
    assert.ok(p.fileId.startsWith("attach:"), "T6: 审计 fileId 格式正确");
    assert.ok(typeof p.documentId === "number", "T6: 审计 documentId 为数字");

    const skipAudit = db.prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'file_promote_skip' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(skipAudit, "T6: 应有 file_promote_skip 审计记录");
    const sp = JSON.parse(skipAudit!.payload) as { existingDocId: number };
    assert.ok(typeof sp.existingDocId === "number", "T6: skip 审计 existingDocId 正确");

    console.log("files-promote T6: 审计落点 ✓");
  }

  // ─── 清理 ──────────────────────────────────────────────────────────────────
  process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
  process.env.FINANCE_AGENT_APP_DATA_DIR = savedAppData;
  process.env.FINANCE_AGENT_KNOWLEDGE_DIR = savedKnowledgeDir;
  process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR = savedKnowledgeTextDir;
  db.close();

  console.log("files-promote: all 6 tests passed ✓");
})();
