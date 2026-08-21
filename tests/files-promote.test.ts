/**
 * 真实 route 生命周期回归：附件 promote 后由知识库持有独立副本，删除知识条目
 * 不影响原附件；同名新内容会迁移 hash/storage 所有权并清理旧知识副本。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type PromoteResponse = {
  ok: boolean;
  alreadyExists?: boolean;
  documentId?: number;
  error?: string;
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export const filesPromoteTestPromise = (async () => {
  const appData = mkdtempSync(path.join(tmpdir(), "fa-promote-"));
  const savedEnv = {
    FINANCE_AGENT_DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
    FINANCE_AGENT_APP_DATA_DIR: process.env.FINANCE_AGENT_APP_DATA_DIR,
    FINANCE_AGENT_KNOWLEDGE_DIR: process.env.FINANCE_AGENT_KNOWLEDGE_DIR,
    FINANCE_AGENT_KNOWLEDGE_TEXT_DIR: process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR,
  };

  process.env.FINANCE_AGENT_DB_PATH = path.join(appData, "test.db");
  process.env.FINANCE_AGENT_APP_DATA_DIR = appData;
  process.env.FINANCE_AGENT_KNOWLEDGE_DIR = path.join(appData, "knowledge");
  process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR = path.join(appData, "knowledge-text");

  let restoreRetrievalService: (() => void) | undefined;
  try {
    const { countKnowledgeDocumentsByStoragePath, getDb } = await import("../lib/db/sqlite.ts");
    const {
      acquireKnowledgeIngestLease,
      computeFileHash,
      hasActiveKnowledgeHashLease,
      hasActiveKnowledgePathLease,
      readTextMirror,
      writeTextMirror,
      writeUploadedFile,
    } = await import("../lib/knowledge/storage.ts");
    const { POST: filesLibraryPost } = await import("../app/api/files-library/route.ts");
    const { POST: knowledgeUploadPost } = await import("../app/api/knowledge/documents/route.ts");
    const { DELETE: knowledgeDelete } = await import("../app/api/knowledge/documents/[id]/route.ts");
    const {
      createProductionRetrievalService,
      installProductionRetrievalService,
    } = await import("../lib/retrieval/production.ts");
    const db = getDb();
    restoreRetrievalService = installProductionRetrievalService(createProductionRetrievalService({
      db,
      casRoot: path.join(appData, "artifacts", "cas"),
    }));

    const conversationId = 201;
    const conversationDir = path.join(appData, "files", String(conversationId));
    db.prepare("INSERT INTO chat_conversations (id, title) VALUES (?, ?)").run(conversationId, "测试会话promote");

    function addAttachment(params: {
      id: string;
      messageId: number;
      relativePath: string;
      content: string;
      role?: "user" | "assistant";
    }): string {
      const absolutePath = path.join(conversationDir, params.relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, params.content);
      const role = params.role ?? "user";
      db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)")
        .run(params.messageId, conversationId, role, params.id);
      db.prepare(
        "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role, kept) VALUES (?,?,?,?,?,?,?,?)"
      ).run(
        params.id,
        params.messageId,
        path.basename(params.relativePath),
        "text/plain",
        Buffer.byteLength(params.content),
        params.relativePath,
        role,
        0
      );
      return absolutePath;
    }

    async function promote(fileId: string): Promise<{ response: Response; body: PromoteResponse }> {
      const response = await filesLibraryPost(new Request("http://local/api/files-library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "promote", fileId }),
      }));
      return { response, body: await response.json() as PromoteResponse };
    }

    async function deleteKnowledge(documentId: number): Promise<{ response: Response; body: { ok: boolean; error?: string } }> {
      const response = await knowledgeDelete(
        new Request(`http://local/api/knowledge/documents/${documentId}`, { method: "DELETE" }) as never,
        { params: Promise.resolve({ id: String(documentId) }) }
      );
      return { response, body: await response.json() as { ok: boolean; error?: string } };
    }

    // T1: promote → DELETE 后，原附件保留、知识库自有副本删除、逻辑行删除。
    const lifecycleOriginal = addAttachment({
      id: "promote-lifecycle",
      messageId: 2001,
      relativePath: "upload/生命周期.txt",
      content: "这是一份生命周期测试附件，内容足够用于解析并验证知识库副本所有权。",
    });
    const lifecyclePromote = await promote("attach:promote-lifecycle");
    assert.equal(
      lifecyclePromote.response.status,
      200,
      `T1: promote route 应成功；实际错误：${lifecyclePromote.body.error ?? "unknown"}`,
    );
    assert.equal(lifecyclePromote.body.ok, true);
    assert.equal(typeof lifecyclePromote.body.documentId, "number");
    const lifecycleId = lifecyclePromote.body.documentId!;
    const lifecycleDoc = db.prepare("SELECT storage_path FROM knowledge_documents WHERE id = ?").get(lifecycleId) as
      { storage_path: string } | undefined;
    assert.ok(lifecycleDoc, "T1: 应创建知识条目");
    assert.notEqual(lifecycleDoc!.storage_path, lifecycleOriginal, "T1: storage_path 不得指向原附件");
    assert.ok(lifecycleDoc!.storage_path.startsWith(`${process.env.FINANCE_AGENT_KNOWLEDGE_DIR}${path.sep}`), "T1: 副本应位于知识库根");
    assert.ok(existsSync(lifecycleDoc!.storage_path), "T1: 知识库副本应存在");

    const lifecycleDelete = await deleteKnowledge(lifecycleId);
    assert.equal(lifecycleDelete.response.status, 200);
    assert.equal(lifecycleDelete.body.ok, true);
    assert.ok(existsSync(lifecycleOriginal), "T1: 删除知识条目后原附件必须保留");
    assert.ok(!existsSync(lifecycleDoc!.storage_path), "T1: 删除知识条目后知识库副本应删除");
    assert.equal(db.prepare("SELECT id FROM knowledge_documents WHERE id = ?").get(lifecycleId), undefined, "T1: DB 行应删除");

    // T1b: two logical owners may share one physical file and one text mirror.
    const sharedBytes = Buffer.from("shared knowledge owners");
    const sharedHash = computeFileHash(sharedBytes);
    const sharedPath = writeUploadedFile(sharedHash, sharedBytes, ".txt");
    writeTextMirror(sharedHash, sharedBytes.toString("utf-8"));
    const insertShared = db.prepare(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES (?, ?, 'text/plain', 'other', ?, 0, ?, ?)
    `);
    const sharedFirstId = Number(insertShared.run("shared-one", "shared-one.txt", sharedBytes.length, sharedHash, sharedPath).lastInsertRowid);
    const sharedSecondId = Number(insertShared.run("shared-two", "shared-two.txt", sharedBytes.length, sharedHash, sharedPath).lastInsertRowid);
    assert.equal((await deleteKnowledge(sharedFirstId)).response.status, 200);
    assert.ok(existsSync(sharedPath), "T1b: deleting the first owner must preserve the shared file");
    assert.equal(readTextMirror(sharedHash), sharedBytes.toString("utf-8"), "T1b: deleting the first owner must preserve the shared mirror");
    assert.ok(db.prepare("SELECT id FROM knowledge_documents WHERE id = ?").get(sharedSecondId), "T1b: second owner must remain");
    assert.equal((await deleteKnowledge(sharedSecondId)).response.status, 200);
    assert.ok(!existsSync(sharedPath), "T1b: deleting the last owner should remove the shared file");
    assert.equal(readTextMirror(sharedHash), null, "T1b: deleting the last owner should remove the shared mirror");

    // T1c: an in-flight ingest lease wins over last-owner physical cleanup.
    const leasedBytes = Buffer.from("leased owner bytes");
    const leasedHash = computeFileHash(leasedBytes);
    const leasedPath = writeUploadedFile(leasedHash, leasedBytes, ".txt");
    writeTextMirror(leasedHash, leasedBytes.toString("utf-8"));
    const leasedId = Number(insertShared.run("leased", "leased.txt", leasedBytes.length, leasedHash, leasedPath).lastInsertRowid);
    const releaseLease = acquireKnowledgeIngestLease(leasedHash, leasedPath);
    assert.equal((await deleteKnowledge(leasedId)).response.status, 200);
    assert.ok(existsSync(leasedPath), "T1c: active path lease must preserve the last owner's file");
    assert.equal(readTextMirror(leasedHash), leasedBytes.toString("utf-8"), "T1c: active hash lease must preserve the last owner's mirror");
    releaseLease();
    assert.ok(existsSync(leasedPath), "T1c: releasing the lease does not perform unsafe immediate cleanup");
    assert.equal(readTextMirror(leasedHash), leasedBytes.toString("utf-8"), "T1c: released-lease orphan remains for age-based GC");

    // T1d: compatibility rows may reuse one path with a different hash; the path lease alone protects bytes.
    const compatibilityBytes = Buffer.from("compatibility path bytes");
    const compatibilityHash = computeFileHash(compatibilityBytes);
    const compatibilityPath = writeUploadedFile(compatibilityHash, compatibilityBytes, ".txt");
    writeTextMirror(compatibilityHash, compatibilityBytes.toString("utf-8"));
    const compatibilityId = Number(insertShared.run(
      "compatibility-old",
      "compatibility-old.txt",
      compatibilityBytes.length,
      compatibilityHash,
      compatibilityPath
    ).lastInsertRowid);
    const releaseCompatibilityLease = acquireKnowledgeIngestLease(computeFileHash(Buffer.from("new in-flight hash")), compatibilityPath);
    assert.equal((await deleteKnowledge(compatibilityId)).response.status, 200);
    assert.ok(existsSync(compatibilityPath), "T1d: same-path lease with a different hash must preserve the original bytes");
    assert.equal(readTextMirror(compatibilityHash), null, "T1d: unrelated hash lease does not retain the old hash mirror");
    releaseCompatibilityLease();

    if (process.platform === "darwin" || process.platform === "win32") {
      const caseBytes = Buffer.from("case insensitive owner");
      const caseHash = computeFileHash(caseBytes);
      const casePath = writeUploadedFile(caseHash, caseBytes, ".txt");
      const caseVariant = casePath.toUpperCase();
      const caseFirstId = Number(insertShared.run("case-one", "case-one.txt", caseBytes.length, caseHash, casePath).lastInsertRowid);
      const caseSecondId = Number(insertShared.run("case-two", "case-two.txt", caseBytes.length, `${caseHash}-other`, caseVariant).lastInsertRowid);
      assert.equal(countKnowledgeDocumentsByStoragePath(casePath, db), 2, "T1e: case variants must share one owner key on this platform");
      assert.equal((await deleteKnowledge(caseFirstId)).response.status, 200);
      assert.ok(existsSync(casePath), "T1e: case-variant owner must preserve physical bytes");
      await deleteKnowledge(caseSecondId);
    }

    // T2: 历史共享外部 storage_path 逻辑删除成功，但物理文件保留。
    const historicalOriginal = addAttachment({
      id: "historical-shared",
      messageId: 2002,
      relativePath: "upload/历史共享.txt",
      content: "历史版本曾把聊天附件路径直接保存为知识库 storage_path，此文件不得被删除。",
    });
    const historicalHash = computeFileHash(Buffer.from("historical-shared-row"));
    const historicalInsert = db.prepare(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run("历史共享.txt", "历史共享.txt", "text/plain", "other", 64, historicalHash, historicalOriginal);
    const historicalId = Number(historicalInsert.lastInsertRowid);
    const historicalDelete = await deleteKnowledge(historicalId);
    assert.equal(historicalDelete.response.status, 200, "T2: 历史条目 DELETE 仍应成功");
    assert.equal(historicalDelete.body.ok, true);
    assert.ok(existsSync(historicalOriginal), "T2: 历史共享外部文件必须保留");
    assert.equal(db.prepare("SELECT id FROM knowledge_documents WHERE id = ?").get(historicalId), undefined, "T2: 历史 DB 行应删除");

    // T3: 同名不同内容更新 hash/storage，新 DB 状态落盘后清理旧知识副本。
    const versionOneOriginal = addAttachment({
      id: "same-name-v1",
      messageId: 2003,
      relativePath: "upload/同名文档.txt",
      content: "同名文档第一版：旧知识副本应在第二版成功入库后被安全清理。",
    });
    const versionTwoOriginal = addAttachment({
      id: "same-name-v2",
      messageId: 2004,
      relativePath: "generate/同名文档.txt",
      content: "同名文档第二版：内容不同，必须同步更新 content_hash 与 storage_path。",
      role: "assistant",
    });
    const first = await promote("attach:same-name-v1");
    assert.equal(first.body.ok, true);
    const firstId = first.body.documentId!;
    const firstDoc = db.prepare("SELECT content_hash, storage_path FROM knowledge_documents WHERE id = ?").get(firstId) as
      { content_hash: string; storage_path: string };
    assert.ok(existsSync(firstDoc.storage_path), "T3: 第一版知识副本应存在");

    const second = await promote("attach:same-name-v2");
    assert.equal(second.response.status, 200, "T3: 第二版 promote 应成功");
    assert.equal(second.body.documentId, firstId, "T3: 同名文档应更新既有逻辑条目");
    const secondDoc = db.prepare("SELECT content_hash, storage_path FROM knowledge_documents WHERE id = ?").get(firstId) as
      { content_hash: string; storage_path: string };
    assert.equal(secondDoc.content_hash, computeFileHash(Buffer.from("同名文档第二版：内容不同，必须同步更新 content_hash 与 storage_path。")), "T3: hash 应切到新内容");
    assert.notEqual(secondDoc.storage_path, firstDoc.storage_path, "T3: storage_path 应切到新副本");
    assert.ok(existsSync(secondDoc.storage_path), "T3: 新知识副本应存在");
    assert.ok(!existsSync(firstDoc.storage_path), "T3: 旧知识副本应在 DB 更新后清理");
    assert.ok(existsSync(versionOneOriginal) && existsSync(versionTwoOriginal), "T3: 两个原附件都应保留");

    // T4: 重复内容优雅返回；非法类型和不存在文件仍维持既有合同。
    const duplicate = await promote("attach:same-name-v2");
    assert.equal(duplicate.body.ok, true);
    assert.equal(duplicate.body.alreadyExists, true);
    assert.equal(duplicate.body.documentId, firstId);
    const invalid = await promote(`know:${firstId}`);
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.body.error ?? "", /只能/);
    const missing = await promote("attach:not-exist-at-all");
    assert.equal(missing.response.status, 404);

    // T5: 解析/入库失败不即时删除无 DB owner 的内容寻址副本；lease 必须释放。
    const emptyOriginal = addAttachment({
      id: "empty-content",
      messageId: 2005,
      relativePath: "upload/空内容.txt",
      content: "",
    });
    const emptyHash = computeFileHash(Buffer.alloc(0));
    const emptyKnowledgePath = path.join(process.env.FINANCE_AGENT_KNOWLEDGE_DIR!, `${emptyHash}.txt`);
    const emptyPromote = await promote("attach:empty-content");
    assert.equal(emptyPromote.response.status, 500, "T5: 空内容解析失败应返回 500");
    assert.equal(emptyPromote.body.ok, false);
    assert.match(emptyPromote.body.error ?? "", /内容为空/);
    assert.ok(existsSync(emptyOriginal), "T5: promote 失败不得删除原附件");
    assert.ok(existsSync(emptyKnowledgePath), "T5: promote 失败副本应留给未来基于年龄的 GC");
    assert.equal(hasActiveKnowledgeHashLease(emptyHash), false, "T5: promote 失败必须释放 hash lease");
    assert.equal(hasActiveKnowledgePathLease(emptyKnowledgePath), false, "T5: promote 失败必须释放 path lease");
    assert.equal(
      db.prepare("SELECT id FROM knowledge_documents WHERE content_hash = ?").get(emptyHash),
      undefined,
      "T5: promote 失败不得留下 DB 行"
    );

    const blankUploadBytes = Buffer.from("   ");
    const blankUploadHash = computeFileHash(blankUploadBytes);
    const blankUploadPath = path.join(process.env.FINANCE_AGENT_KNOWLEDGE_DIR!, `${blankUploadHash}.txt`);
    const uploadForm = new FormData();
    uploadForm.set("file", new File([blankUploadBytes], "blank-upload.TXT", { type: "text/plain" }));
    const blankUploadResponse = await knowledgeUploadPost(new Request("http://local/api/knowledge/documents", {
      method: "POST",
      body: uploadForm,
    }) as never);
    assert.equal(blankUploadResponse.status, 500, "T5b: blank direct upload should fail ingest");
    assert.ok(existsSync(blankUploadPath), "T5b: failed direct upload remains for age-based GC");
    assert.equal(hasActiveKnowledgeHashLease(blankUploadHash), false, "T5b: direct upload failure releases hash lease");
    assert.equal(hasActiveKnowledgePathLease(blankUploadPath), false, "T5b: direct upload failure releases path lease");

    const promotedAuditCount = (db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE event_type = 'file_promoted'").get() as { count: number }).count;
    const skippedAuditCount = (db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE event_type = 'file_promote_skip'").get() as { count: number }).count;
    assert.ok(promotedAuditCount >= 3, "T4: 每次真实 promote 应落审计");
    assert.ok(skippedAuditCount >= 1, "T4: 重复 promote 应落 skip 审计");

    console.log("files-promote: route ownership lifecycle, historical safety, and same-name update ✓");
  } finally {
    restoreRetrievalService?.();
    restoreEnv("FINANCE_AGENT_DB_PATH", savedEnv.FINANCE_AGENT_DB_PATH);
    restoreEnv("FINANCE_AGENT_APP_DATA_DIR", savedEnv.FINANCE_AGENT_APP_DATA_DIR);
    restoreEnv("FINANCE_AGENT_KNOWLEDGE_DIR", savedEnv.FINANCE_AGENT_KNOWLEDGE_DIR);
    restoreEnv("FINANCE_AGENT_KNOWLEDGE_TEXT_DIR", savedEnv.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR);
  }
})();
