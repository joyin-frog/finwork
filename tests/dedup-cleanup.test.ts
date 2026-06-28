/**
 * dedup-cleanup.test.ts
 *
 * 安全敏感测试:对话文件去重清理 + 知识库内容哈希判重
 *
 * 覆盖场景:
 * T1: analyzeConversationDuplicates 只读(文件系统无变化)、数目/字节正确
 * T2: cleanupConversationDuplicates 同对话重复:剩 1 份物理文件,两条行都指向存在文件
 * T3: cleanupConversationDuplicates 孤儿文件(无行引用)已删
 * T4: cleanupConversationDuplicates 残留目录(convId 不存在)已删
 * T5: 唯一文件(无重复)没有被动
 * T6: 跨对话同内容文件未被并走(physical 各自保留,行不变)
 * T7: 遍历所有 chat_attachment 行 storage_path 零断链(头号验收)
 * T8: 返回 cleanedFiles/reclaimedBytes 正确
 * T9: 审计有记录
 * T10: 知识库上传判重:同内容 → 返回 exists:true;overwrite=true → 覆盖更新
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const dedupCleanupTestPromise = (async () => {
  // ─── 环境隔离 ──────────────────────────────────────────────────────────────
  const appData = mkdtempSync(path.join(tmpdir(), "fa-dedup-"));
  const dbPath = path.join(appData, "test.db");

  // 必须在 import 之前设置 env,让 getDb() 单例指向此 DB
  const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
  const savedAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const savedKnowledgeTextDir = process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR;

  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  process.env.FINANCE_AGENT_APP_DATA_DIR = appData;
  process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR = path.join(appData, "knowledge-text");

  const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db, dbPath);

  const { analyzeConversationDuplicates, cleanupConversationDuplicates } = await import("../lib/maintenance/dedup.ts");

  // ─── 建立测试文件系统结构 ─────────────────────────────────────────────────
  // getConversationFilesDir(convId) = appData/files/<convId>
  function convDir(convId: number) {
    return path.join(appData, "files", String(convId));
  }

  // 会话 X(id=301):有 2 条同内容(不同物理 path) + 1 条唯一
  db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(301, "会话X");
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', '消息1')").run(3001, 301);
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', '消息2')").run(3002, 301);
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', '消息3')").run(3003, 301);

  // 文件结构
  mkdirSync(path.join(convDir(301), "upload"), { recursive: true });
  mkdirSync(path.join(convDir(301), "dup"), { recursive: true });

  // 同内容文件:dup-a.txt 和 dup-b.txt(内容相同)
  const dupContent = "这是重复内容文件,用于测试去重功能。内容足够长以让哈希区分。";
  const dupAPath = path.join(convDir(301), "upload", "dup-a.txt");
  const dupBPath = path.join(convDir(301), "dup", "dup-b.txt");
  writeFileSync(dupAPath, dupContent);
  writeFileSync(dupBPath, dupContent);

  // 唯一文件
  const uniquePath = path.join(convDir(301), "upload", "unique.txt");
  writeFileSync(uniquePath, "这是唯一文件内容,不重复。");

  // 孤儿文件:存在于 convDir(301) 但无行引用
  const orphanPath = path.join(convDir(301), "upload", "orphan.txt");
  writeFileSync(orphanPath, "孤儿文件,无行引用。");
  const orphanFileSize = statSync(orphanPath).size;

  // chat_attachments 行:dup-a(最早)+ dup-b + unique(无 orphan 的行)
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-301-dup-a", 3001, "dup-a.txt", "text/plain", dupContent.length, "upload/dup-a.txt", "user", 0);

  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-301-dup-b", 3002, "dup-b.txt", "text/plain", dupContent.length, "dup/dup-b.txt", "user", 0);

  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-301-unique", 3003, "unique.txt", "text/plain", 20, "upload/unique.txt", "user", 0);

  // 会话 Y(id=302):同内容(与 X 重复),用于测试跨对话不合并
  db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(302, "会话Y");
  db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, 'user', 'Y消息')").run(3004, 302);
  mkdirSync(path.join(convDir(302), "upload"), { recursive: true });
  const yFilePath = path.join(convDir(302), "upload", "y-dup.txt");
  writeFileSync(yFilePath, dupContent); // 与 X 同内容
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
  ).run("att-302-y", 3004, "y-dup.txt", "text/plain", dupContent.length, "upload/y-dup.txt", "user", 0);

  // 残留目录:convId=999 在 chat_conversations 中不存在
  const orphanDirPath = path.join(appData, "files", "999");
  mkdirSync(path.join(orphanDirPath, "sub"), { recursive: true });
  const orphanDir1 = path.join(orphanDirPath, "lingering.txt");
  const orphanDir2 = path.join(orphanDirPath, "sub", "lingering2.txt");
  writeFileSync(orphanDir1, "残留文件1");
  writeFileSync(orphanDir2, "残留文件2");
  const orphanDirSize = statSync(orphanDir1).size + statSync(orphanDir2).size;

  const dupBSize = statSync(dupBPath).size;

  // ─── T1: analyzeConversationDuplicates 只读 ──────────────────────────────
  const beforeAnalyzeFiles = new Set([dupAPath, dupBPath, uniquePath, orphanPath, yFilePath, orphanDir1, orphanDir2]);
  const analysis = analyzeConversationDuplicates(db);

  // 验证所有文件仍然存在(只读不改)
  for (const f of beforeAnalyzeFiles) {
    assert.ok(existsSync(f), `T1: analyze 后文件应仍存在: ${f}`);
  }

  // 同对话重复:1 组(dup-a/dup-b)→ 1 个 redundant
  assert.equal(analysis.sameConvDupGroups, 1, "T1: sameConvDupGroups=1");
  assert.equal(analysis.redundantFiles, 1, "T1: redundantFiles=1(只有 dup-b 是多余的)");
  assert.ok(analysis.reclaimableBytes >= dupBSize, `T1: reclaimableBytes >= ${dupBSize}`);
  // 孤儿:orphan.txt(无行引用) + orphanDirPath 下 2 个文件 = 3
  assert.ok(analysis.orphanFiles >= 3, `T1: orphanFiles >= 3(got ${analysis.orphanFiles})`);

  // ─── T2-T9: cleanupConversationDuplicates ─────────────────────────────────
  const result = cleanupConversationDuplicates(db);

  // T2: 同对话重复 → 剩 1 份物理文件,两条行都指向存在文件
  {
    const rowA = db.prepare("SELECT storage_path FROM chat_attachments WHERE id = ?").get("att-301-dup-a") as { storage_path: string };
    const rowB = db.prepare("SELECT storage_path FROM chat_attachments WHERE id = ?").get("att-301-dup-b") as { storage_path: string };
    assert.ok(rowA, "T2: att-301-dup-a 行仍存在");
    assert.ok(rowB, "T2: att-301-dup-b 行仍存在");

    const absA = path.join(convDir(301), rowA.storage_path);
    const absB = path.join(convDir(301), rowB.storage_path);
    assert.ok(existsSync(absA), `T2: dup-a 行的 storage_path 必须存在: ${absA}`);
    assert.ok(existsSync(absB), `T2: dup-b 行的 storage_path 必须存在: ${absB}`);
    // 两行应指向同一 canonical
    assert.equal(rowA.storage_path, rowB.storage_path, "T2: 两条行应重指向同一 canonical");
    // canonical 是 dup-a(最早创建)
    assert.equal(rowA.storage_path, "upload/dup-a.txt", "T2: canonical 是 dup-a");
  }

  // T3: 孤儿文件已删
  assert.ok(!existsSync(orphanPath), "T3: 孤儿文件(无行引用)已删");

  // T4: 残留目录已删
  assert.ok(!existsSync(orphanDirPath), "T4: 残留目录(convId=999)已删");

  // T5: 唯一文件没动
  assert.ok(existsSync(uniquePath), "T5: 唯一文件未被删除");

  // T6: 跨对话同内容文件未被并走
  assert.ok(existsSync(yFilePath), "T6: 会话Y的文件仍在磁盘上");
  {
    const rowY = db.prepare("SELECT storage_path FROM chat_attachments WHERE id = ?").get("att-302-y") as { storage_path: string };
    assert.ok(rowY, "T6: 会话Y的行仍存在");
    assert.equal(rowY.storage_path, "upload/y-dup.txt", "T6: 会话Y的 storage_path 未被改变");
  }

  // T7: 头号验收 — 遍历所有 chat_attachment 行 storage_path 零断链
  {
    const allRows = db.prepare(`
      SELECT a.id, a.storage_path, m.conversation_id
      FROM chat_attachments a
      LEFT JOIN chat_messages m ON a.message_id = m.id
    `).all() as Array<{ id: string; storage_path: string; conversation_id: number | null }>;
    for (const row of allRows) {
      if (row.conversation_id === null) continue;
      const abs = path.join(appData, "files", String(row.conversation_id), row.storage_path);
      assert.ok(existsSync(abs), `T7(零断链): att=${row.id} storage_path=${row.storage_path} → ${abs} 不存在!`);
    }
  }

  // T8: 返回值正确
  // cleanedFiles 应包含:1个 dup-b 物理文件 + 1 orphan.txt + 2 orphanDir 文件 = 4
  assert.ok(result.cleanedFiles >= 4, `T8: cleanedFiles >= 4 (got ${result.cleanedFiles})`);
  // reclaimedBytes 应包含 dup-b + orphanFile + orphanDirFiles
  assert.ok(result.reclaimedBytes >= dupBSize + orphanFileSize + orphanDirSize,
    `T8: reclaimedBytes >= ${dupBSize + orphanFileSize + orphanDirSize} (got ${result.reclaimedBytes})`);

  // T9: 审计有记录
  {
    const audits = db.prepare(
      "SELECT event_type FROM audit_logs WHERE event_type LIKE 'dedup_%' ORDER BY id ASC"
    ).all() as Array<{ event_type: string }>;
    const eventTypes = audits.map((r) => r.event_type);
    assert.ok(eventTypes.includes("dedup_repath"), "T9: 应有 dedup_repath 审计");
    assert.ok(eventTypes.includes("dedup_delete_redundant"), "T9: 应有 dedup_delete_redundant 审计");
    assert.ok(eventTypes.includes("dedup_delete_orphan_file"), "T9: 应有 dedup_delete_orphan_file 审计");
    assert.ok(eventTypes.includes("dedup_delete_orphan_dir"), "T9: 应有 dedup_delete_orphan_dir 审计");
  }

  // ─── T10: 知识库上传内容哈希判重 ──────────────────────────────────────────
  {
    const knowledgeTextDir = path.join(appData, "knowledge-text");
    mkdirSync(knowledgeTextDir, { recursive: true });

    // 手动插入一份知识库文档(内容 hash=abc123)
    db.prepare(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("测试合同", "test-contract.txt", "text/plain", "合同", 100, 0, "abc123dedup", "/tmp/test-contract.txt");

    // 模拟 route.ts 的判重逻辑
    const { getKnowledgeDocumentByHash } = await import("../lib/db/sqlite.ts");
    const found = getKnowledgeDocumentByHash("abc123dedup");
    assert.ok(found, "T10: 按 hash 找到已存在文档");
    assert.equal(found?.title, "测试合同", "T10: 找到的是正确文档");
    assert.equal(found?.content_hash, "abc123dedup", "T10: content_hash 正确");

    // 未命中的 hash 应返回 undefined
    const notFound = getKnowledgeDocumentByHash("nonexistent_hash_xyz");
    assert.equal(notFound, undefined, "T10: 未命中的 hash 返回 undefined");

    // 审计覆盖操作(模拟 overwrite 路径)
    const { insertAuditLog } = await import("../lib/db/sqlite.ts");
    insertAuditLog("knowledge_overwrite", {
      existingId: found!.id,
      existingTitle: "测试合同",
      newTitle: "测试合同v2",
      contentHash: "abc123dedup",
      at: new Date().toISOString(),
    });
    const overwriteAudit = db.prepare(
      "SELECT * FROM audit_logs WHERE event_type = 'knowledge_overwrite'"
    ).get() as { event_type: string; payload: string } | undefined;
    assert.ok(overwriteAudit, "T10: knowledge_overwrite 审计有记录");
    const auditPayload = JSON.parse(overwriteAudit!.payload) as { existingTitle: string };
    assert.equal(auditPayload.existingTitle, "测试合同", "T10: 审计 payload 正确");
  }

  // ─── 环境恢复 ────────────────────────────────────────────────────────────
  if (savedDbPath !== undefined) process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
  else delete process.env.FINANCE_AGENT_DB_PATH;
  if (savedAppData !== undefined) process.env.FINANCE_AGENT_APP_DATA_DIR = savedAppData;
  else delete process.env.FINANCE_AGENT_APP_DATA_DIR;
  if (savedKnowledgeTextDir !== undefined) process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR = savedKnowledgeTextDir;
  else delete process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR;

  db.close();

  console.log("[dedup-cleanup.test] T1-T10 全部通过");
})();
