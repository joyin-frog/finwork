/**
 * 统一文件库测试
 *
 * 覆盖:
 * - listAllFiles:三类聚合 + 筛选 + 排序
 * - setAttachmentKept: kept 标记 + 审计
 * - migrateKeptAttachmentsBeforeConversationDelete: 标保留→删会话→文件迁库目录、记录留存、源已无; 物理文件缺失处理
 * - deleteLibraryFile: 删盘+删记录+审计
 *
 * 隔离 DB 与 FS:使用独立 openFinanceDatabase,不依赖全局 getDb() 单例。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const unifiedFileLibraryTestPromise = (async () => {
  // ─── 环境隔离 ──────────────────────────────────────────────────────────────
  const appData = mkdtempSync(path.join(tmpdir(), "fa-filelib-"));
  const dbPath = path.join(appData, "test.db");

  const {
    openFinanceDatabase,
    initializeFinanceDatabase,
    listAllFiles,
    setAttachmentKept,
    migrateKeptAttachmentsBeforeConversationDelete,
    deleteLibraryFile,
    insertKnowledgeDocument,
    insertAuditLog,
  } = await import("../lib/db/sqlite.ts");

  // 打开独立 DB 实例(不走全局单例)
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);

  // 注入 insertAuditLog 使用此 db 实例的工厂(直接传 db)
  // 由于 insertAuditLog 内部调 getDb(),我们对 db 直接插避免全局单例问题
  function auditLog(eventType: string, payload: unknown) {
    db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
      eventType, JSON.stringify(payload)
    );
  }

  // ─── 准备测试数据 ──────────────────────────────────────────────────────────
  // 建对话 + 消息
  db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(101, "测试对话A");
  db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(102, "测试对话B");
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', '上传文件')").run(1001, 101);
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', '生成报表')").run(1002, 101);
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', '生成报告')").run(1003, 102);

  // 上传附件
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-upload-1", 1001, "原始数据.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 10240, "upload/原始数据.xlsx", "user", 0);

  // 生成附件
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-gen-1", 1002, "分析报表.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 20480, "generate/分析报表.xlsx", "assistant", 0);

  // 另一个会话的生成附件(kept=0)
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-gen-2", 1003, "汇总报告.pdf", "application/pdf", 5120, "generate/汇总报告.pdf", "assistant", 0);

  // 知识库文档
  insertKnowledgeDocument({
    title: "合同2024",
    file_name: "合同2024.pdf",
    mime_type: "application/pdf",
    category: "合同",
    size_bytes: 30720,
    chunk_count: 3,
    content_hash: "abc123",
    storage_path: path.join(appData, "knowledge", "合同2024.pdf"),
  }, db);

  // ─── T1: listAllFiles 三类聚合 ───────────────────────────────────────────
  {
    const files = listAllFiles({}, db);
    const kinds = new Set(files.map((f) => f.kind));
    assert.ok(kinds.has("upload"), "T1: 应包含 upload 类型");
    assert.ok(kinds.has("generated"), "T1: 应包含 generated 类型");
    assert.ok(kinds.has("knowledge"), "T1: 应包含 knowledge 类型");

    const uploadFile = files.find((f) => f.id === "attach:att-upload-1");
    assert.ok(uploadFile, "T1: 上传附件应在列表中");
    assert.equal(uploadFile?.kind, "upload", "T1: role=user → kind=upload");
    assert.equal(uploadFile?.source, "测试对话A", "T1: 来源应为对话标题");
    assert.equal(uploadFile?.sizeBytes, 10240, "T1: size 正确");
    assert.equal(uploadFile?.conversationId, 101, "T1: conversationId 正确");

    const genFile = files.find((f) => f.id === "attach:att-gen-1");
    assert.equal(genFile?.kind, "generated", "T1: role=assistant → kind=generated");

    const knowledgeFile = files.find((f) => f.kind === "knowledge");
    assert.ok(knowledgeFile, "T1: 知识库文件应在列表中");
    assert.equal(knowledgeFile?.source, "合同", "T1: 知识库来源为 category");
    assert.equal(knowledgeFile?.kept, true, "T1: 知识库文件 kept=true");

    console.log("file-library T1: listAllFiles 三类聚合 ✓");
  }

  // ─── T2: listAllFiles 筛选 ──────────────────────────────────────────────
  {
    const uploadOnly = listAllFiles({ kind: "upload" }, db);
    assert.ok(uploadOnly.length > 0, "T2: upload 类型应有文件");
    assert.ok(uploadOnly.every((f) => f.kind === "upload"), "T2: kind=upload 筛选应只返回上传类");

    const genOnly = listAllFiles({ kind: "generated" }, db);
    assert.ok(genOnly.every((f) => f.kind === "generated"), "T2: kind=generated 筛选");

    const searchResult = listAllFiles({ q: "分析报表" }, db);
    assert.ok(searchResult.some((f) => f.name === "分析报表.xlsx"), "T2: 搜索名称匹配");

    const noResult = listAllFiles({ q: "不存在的文件名xxxyyy" }, db);
    assert.equal(noResult.length, 0, "T2: 搜索无匹配应返回空");

    console.log("file-library T2: 筛选 ✓");
  }

  // ─── T3: listAllFiles 排序 ──────────────────────────────────────────────
  {
    const byName = listAllFiles({ sort: "name" }, db);
    for (let i = 0; i < byName.length - 1; i++) {
      const a = byName[i].name.localeCompare(byName[i + 1].name, "zh-CN");
      assert.ok(a <= 0, `T3: 名称排序应升序,位置 ${i}: "${byName[i].name}" vs "${byName[i + 1].name}"`);
    }

    const bySize = listAllFiles({ sort: "size" }, db);
    for (let i = 0; i < bySize.length - 1; i++) {
      assert.ok(bySize[i].sizeBytes >= bySize[i + 1].sizeBytes, `T3: 大小排序应降序,位置 ${i}`);
    }

    console.log("file-library T3: 排序 ✓");
  }

  // ─── T4: setAttachmentKept + 审计 ───────────────────────────────────────
  {
    setAttachmentKept("att-gen-1", true, db);
    const row = db.prepare("SELECT kept FROM chat_attachments WHERE id = ?").get("att-gen-1") as { kept: number };
    assert.equal(row.kept, 1, "T4: kept 应变为 1");

    const auditRow = db.prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'file_kept' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(auditRow, "T4: 应落 file_kept 审计");
    const payload = JSON.parse(auditRow!.payload) as { attachmentId: string; kept: boolean };
    assert.equal(payload.attachmentId, "att-gen-1", "T4: 审计 attachmentId 正确");
    assert.equal(payload.kept, true, "T4: 审计 kept=true");

    // 取消保留
    setAttachmentKept("att-gen-1", false, db);
    const rowAfter = db.prepare("SELECT kept FROM chat_attachments WHERE id = ?").get("att-gen-1") as { kept: number };
    assert.equal(rowAfter.kept, 0, "T4: 取消 kept 应变回 0");

    console.log("file-library T4: setAttachmentKept + 审计 ✓");
  }

  // ─── T5: migrateKeptAttachmentsBeforeConversationDelete ─────────────────
  {
    // 标记 att-gen-1 为保留
    db.prepare("UPDATE chat_attachments SET kept = 1 WHERE id = 'att-gen-1'").run();

    // 创建物理文件(模拟对话目录)
    const convFilesDir = path.join(appData, "files", "101");
    const generateDir = path.join(convFilesDir, "generate");
    mkdirSync(generateDir, { recursive: true });
    const srcFile = path.join(generateDir, "分析报表.xlsx");
    writeFileSync(srcFile, "excel-content");
    assert.ok(existsSync(srcFile), "T5: 源文件应存在");

    const libraryDir = path.join(appData, "files", "library");

    const migrated = migrateKeptAttachmentsBeforeConversationDelete(
      101,
      (id: number) => path.join(appData, "files", String(id)),
      libraryDir,
      db
    );

    assert.ok(migrated.includes("att-gen-1"), "T5: att-gen-1 应被迁移");

    // 源文件应该已经被移走(物理文件不再在原位)
    assert.ok(!existsSync(srcFile), "T5: 源文件应已移走");

    // library_files 应有记录
    const libRow = db.prepare("SELECT * FROM library_files WHERE id = 'att-gen-1'").get() as {
      file_name: string; storage_path: string; source_label: string;
    } | undefined;
    assert.ok(libRow, "T5: library_files 应有迁移记录");
    assert.equal(libRow?.file_name, "分析报表.xlsx", "T5: 文件名正确");
    assert.ok(libRow?.storage_path && existsSync(libRow.storage_path), "T5: 迁移目标文件应存在于库目录");
    assert.equal(libRow?.source_label, "测试对话A", "T5: 来源标签应为对话标题");

    // 迁移后 library 列表应出现该文件
    const afterFiles = listAllFiles({ kind: "library" }, db);
    assert.ok(afterFiles.some((f) => f.name === "分析报表.xlsx"), "T5: 文件库列表应包含迁移的文件");

    // 审计落点
    const migrateAudit = db.prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'file_library_migrate' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(migrateAudit, "T5: 应落 file_library_migrate 审计");
    const migratePayload = JSON.parse(migrateAudit!.payload) as { conversationId: number; count: number };
    assert.equal(migratePayload.conversationId, 101, "T5: 审计中 conversationId 正确");

    console.log("file-library T5: migrateKeptAttachmentsBeforeConversationDelete ✓");
  }

  // ─── T6: 非 kept 附件不被迁移 ──────────────────────────────────────────
  {
    // att-gen-2 kept=0,属于对话102
    const migrated2 = migrateKeptAttachmentsBeforeConversationDelete(
      102,
      (id: number) => path.join(appData, "files", String(id)),
      path.join(appData, "files", "library"),
      db
    );
    assert.equal(migrated2.length, 0, "T6: 未标保留的附件不应被迁移");
    console.log("file-library T6: 非 kept 附件不迁移 ✓");
  }

  // ─── T7: deleteLibraryFile (library) ───────────────────────────────────
  {
    // 找到迁移后的库文件记录
    const libRow = db.prepare("SELECT id, storage_path FROM library_files WHERE file_name = '分析报表.xlsx'").get() as {
      id: string; storage_path: string;
    } | undefined;
    assert.ok(libRow, "T7: library_files 应有记录");

    const libPath = libRow!.storage_path;
    assert.ok(existsSync(libPath), "T7: 库文件应存在");

    deleteLibraryFile(`lib:${libRow!.id}`, db);

    assert.ok(!existsSync(libPath), "T7: 删除后磁盘文件应消失");

    const afterRow = db.prepare("SELECT id FROM library_files WHERE id = ?").get(libRow!.id);
    assert.ok(!afterRow, "T7: 删除后 library_files 记录应消失");

    // 审计
    const deleteAudit = db.prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'file_deleted' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(deleteAudit, "T7: 应落 file_deleted 审计");

    console.log("file-library T7: deleteLibraryFile (library) ✓");
  }

  // ─── T8: deleteLibraryFile (attach) ────────────────────────────────────
  {
    // 上传附件 att-upload-1,物理文件在对话目录下
    const convFilesDir = path.join(appData, "files", "101");
    const uploadDir = path.join(convFilesDir, "upload");
    mkdirSync(uploadDir, { recursive: true });
    const uploadFile = path.join(uploadDir, "原始数据.xlsx");
    writeFileSync(uploadFile, "xlsx-content");

    // deleteLibraryFile for attach: 需要 getConversationFilesDir。
    // 在测试中我们设了 FINANCE_AGENT_APP_DATA_DIR,所以 require('@/lib/runtime/paths') 会用正确路径。
    // 但由于该函数内部用 require('@/lib/runtime/paths'),而 paths.ts 读 FINANCE_AGENT_APP_DATA_DIR,
    // 需要先设置这个 env,再调函数。
    const savedAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
    process.env.FINANCE_AGENT_APP_DATA_DIR = appData;

    deleteLibraryFile("attach:att-upload-1", db);

    process.env.FINANCE_AGENT_APP_DATA_DIR = savedAppData;

    assert.ok(!existsSync(uploadFile), "T8: 删除 attach 后磁盘文件应消失");

    const afterRow = db.prepare("SELECT id FROM chat_attachments WHERE id = 'att-upload-1'").get();
    assert.ok(!afterRow, "T8: 删除后 chat_attachments 记录应消失");

    console.log("file-library T8: deleteLibraryFile (attach) ✓");
  }

  // ─── T9: migrateKept 物理文件缺失时不抛出,记录空路径 ──────────────────
  {
    // 插入一个 kept=1 的附件,storage_path 指向不存在的文件
    db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(199, "测试对话C");
    db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', '生成')").run(1099, 199);
    db.prepare(
      "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
    ).run("att-missing-1", 1099, "消失的文件.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 100, "generate/消失的文件.xlsx", "assistant", 1);

    // 不创建实际文件,调用迁移(不应抛出)
    const migrated = migrateKeptAttachmentsBeforeConversationDelete(
      199,
      (id: number) => path.join(appData, "files", String(id)),
      path.join(appData, "files", "library"),
      db
    );
    assert.ok(migrated.includes("att-missing-1"), "T9: 即使物理文件不存在也应记录迁移");

    const libRow = db.prepare("SELECT storage_path FROM library_files WHERE id = 'att-missing-1'").get() as {
      storage_path: string;
    } | undefined;
    assert.ok(libRow, "T9: library_files 应有记录");
    assert.equal(libRow?.storage_path, "", "T9: 物理文件不存在时 storage_path 为空");

    console.log("file-library T9: 物理文件缺失时迁移正确处理 ✓");
  }

  db.close();
  console.log("unified-file-library: all 9 tests passed ✓");
})();
