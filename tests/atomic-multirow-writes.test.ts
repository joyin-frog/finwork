import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const atomicMultirowWritesTestPromise = (async () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "atomic-multirow-"));
  const previous = {
    FINANCE_AGENT_APP_DATA_DIR: process.env.FINANCE_AGENT_APP_DATA_DIR,
    FINANCE_AGENT_DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
    FINANCE_AGENT_MOCK_AGENT: process.env.FINANCE_AGENT_MOCK_AGENT,
    FINANCE_AGENT_MOCK_AGENT_DELAY: process.env.FINANCE_AGENT_MOCK_AGENT_DELAY,
  };
  process.env.FINANCE_AGENT_APP_DATA_DIR = baseDir;
  process.env.FINANCE_AGENT_DB_PATH = path.join(baseDir, "atomic.db");
  process.env.FINANCE_AGENT_MOCK_AGENT = "1";
  process.env.FINANCE_AGENT_MOCK_AGENT_DELAY = "0";
  let restoreRetrievalService: (() => void) | undefined;

  try {
    const { createChatConversation, getDb } = await import("../lib/db/sqlite.ts");
    const { sessionStage } = await import("../lib/agent/query-stages.ts");
    const db = getDb();
    const {
      createProductionRetrievalService,
      installProductionRetrievalService,
    } = await import("../lib/retrieval/production.ts");
    const retrieval = createProductionRetrievalService({
      db,
      casRoot: path.join(baseDir, "artifacts", "cas"),
      embedder: async (texts: readonly string[]) => texts.map((text) => [
        text.length || 1,
        [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0) || 1,
        1,
      ]),
    });
    restoreRetrievalService = installProductionRetrievalService(retrieval);

    // Site B: a failed attachment insert must roll back the user message written with it.
    const conversationId = createChatConversation("site-b atomicity");
    const attachmentPath = path.join(baseDir, "files", String(conversationId), "upload", "site-b.txt");
    mkdirSync(path.dirname(attachmentPath), { recursive: true });
    writeFileSync(attachmentPath, "site b attachment");
    db.exec(`
      CREATE TRIGGER fail_site_b_attachment
      BEFORE INSERT ON chat_attachments
      BEGIN
        SELECT RAISE(ABORT, 'site-b-attachment-abort');
      END
    `);

    await assert.rejects(
      () => sessionStage({
        traceId: "site-b-trace",
        startedAt: Date.now(),
        settings: { roleMode: "tech", fastModel: "", reasoningModel: "" },
        roleMode: "tech",
        request: new Request("http://local/api/agent/query?stream=false"),
        requestSignal: undefined,
        messages: [{ role: "user", content: "site b message" }],
        attachments: [{
          name: "site-b.txt",
          mimeType: "text/plain",
          size: 17,
          storagePath: attachmentPath,
        }],
        conversationId,
        lastUserContent: "site b message",
        referencedSkills: [],
        modelTier: undefined,
        useStreaming: false,
      } as never),
      /site-b-attachment-abort/,
      "the injected attachment failure must propagate"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?").get(conversationId) as { count: number }).count,
      0,
      "Site B must not leave the user message after attachment failure"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM chat_attachments").get() as { count: number }).count,
      0,
      "Site B must not leave an attachment after failure"
    );

    console.log("atomic-multirow-writes: Site B rollback ✓");

    // Site C: archive flag and derived-obligation deletion are one atomic change.
    const { PATCH: patchKnowledge } = await import("../app/api/knowledge/documents/[id]/route.ts");
    const metadata = {
      status: "待付",
      counterparty: "Site C counterparty",
      amount: 100,
      keyDates: [{ kind: "付款", date: "2026-08-01" }],
    };
    const insertedDoc = db.prepare(`
      INSERT INTO knowledge_documents
        (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path, metadata, meta_status, archived)
      VALUES (?, ?, 'text/plain', 'other', 1, 0, ?, '', ?, 'confirmed', 0)
    `).run("site-c", "site-c.txt", "site-c-hash", JSON.stringify(metadata));
    const documentId = Number(insertedDoc.lastInsertRowid);
    await retrieval.indexKnowledgeDocument({
      knowledgeDocumentId: documentId,
      title: "site-c",
      fileName: "site-c.txt",
      sourceContentHash: "site-c-hash",
      parsedText: "Site C 归档与恢复原子性测试",
      category: "other",
    });
    const { deriveCashObligations, persistDerivedObligations } = await import("../lib/domain/cash-obligations.ts");
    persistDerivedObligations(documentId, deriveCashObligations([{
      id: documentId,
      fileName: "site-c.txt",
      metadata,
      metaStatus: "confirmed",
    }]), db);
    db.exec(`
      CREATE TRIGGER fail_site_c_obligation_delete
      BEFORE DELETE ON fact_obligations
      BEGIN
        SELECT RAISE(ABORT, 'site-c-obligation-abort');
      END
    `);
    const archiveResponse = await patchKnowledge(
      new Request(`http://local/api/knowledge/documents/${documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }) as never,
      { params: Promise.resolve({ id: String(documentId) }) }
    );
    assert.equal(archiveResponse.status, 500, "Site C injected delete failure must reach the route error response");
    assert.match(
      ((await archiveResponse.json()) as { error?: string }).error ?? "",
      /site-c-obligation-abort/,
      "Site C archive trigger must be the observed failure"
    );
    assert.equal(
      (db.prepare("SELECT archived FROM knowledge_documents WHERE id = ?").get(documentId) as { archived: number }).archived,
      0,
      "Site C must roll back the archive flag when obligation deletion fails"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM fact_obligations WHERE source_document_id = ?").get(documentId) as { count: number }).count,
      1,
      "Site C must preserve obligations when archive fails"
    );

    db.exec("DROP TRIGGER fail_site_c_obligation_delete");
    const successfulArchive = await patchKnowledge(
      new Request(`http://local/api/knowledge/documents/${documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }) as never,
      { params: Promise.resolve({ id: String(documentId) }) }
    );
    assert.equal(successfulArchive.status, 200, "Site C setup archive should succeed");
    db.exec(`
      CREATE TRIGGER fail_site_c_obligation_insert
      BEFORE INSERT ON fact_obligations
      BEGIN
        SELECT RAISE(ABORT, 'site-c-unarchive-abort');
      END
    `);
    const unarchiveResponse = await patchKnowledge(
      new Request(`http://local/api/knowledge/documents/${documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      }) as never,
      { params: Promise.resolve({ id: String(documentId) }) }
    );
    assert.equal(unarchiveResponse.status, 500, "Site C injected re-derive failure must fail unarchive");
    assert.match(
      ((await unarchiveResponse.json()) as { error?: string }).error ?? "",
      /site-c-unarchive-abort/,
      "Site C unarchive trigger must be the observed failure"
    );
    assert.equal(
      (db.prepare("SELECT archived FROM knowledge_documents WHERE id = ?").get(documentId) as { archived: number }).archived,
      1,
      "Site C must roll back the unarchive flag when obligation re-derive fails"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM fact_obligations WHERE source_document_id = ?").get(documentId) as { count: number }).count,
      0,
      "Site C failed unarchive must leave the archived obligation state unchanged"
    );

    console.log("atomic-multirow-writes: Site C rollback ✓");

    // Site A: a failed event insert must roll back the assistant message written with it.
    const siteAConversationId = createChatConversation("site-a atomicity");
    db.exec(`
      CREATE TRIGGER fail_site_a_event
      BEFORE INSERT ON chat_agent_events
      BEGIN
        SELECT RAISE(ABORT, 'site-a-event-abort');
      END
    `);
    const { POST: agentQueryPost } = await import("../app/api/agent/query/route.ts");
    const siteAResponse = await agentQueryPost(new Request("http://local/api/agent/query?stream=false", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: siteAConversationId,
        messages: [{ role: "user", content: "帮我核对这批报销" }],
      }),
    }));
    assert.equal(siteAResponse.status, 502, "Site A injected event failure must fail the real POST route");
    const siteABody = await siteAResponse.json() as { error?: string };
    assert.match(siteABody.error ?? "", /site-a-event-abort/, "Site A trigger must be the observed failure");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ? AND role = 'user'").get(siteAConversationId) as { count: number }).count,
      1,
      "Site A transaction starts after the already committed user message"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ? AND role = 'assistant'").get(siteAConversationId) as { count: number }).count,
      0,
      "Site A must not leave the assistant message after event failure"
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM chat_agent_events").get() as { count: number }).count,
      0,
      "Site A must not leave agent events after failure"
    );

    console.log("atomic-multirow-writes: Site A rollback ✓");
  } finally {
    restoreRetrievalService?.();
    if (previous.FINANCE_AGENT_APP_DATA_DIR === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = previous.FINANCE_AGENT_APP_DATA_DIR;
    if (previous.FINANCE_AGENT_DB_PATH === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = previous.FINANCE_AGENT_DB_PATH;
    if (previous.FINANCE_AGENT_MOCK_AGENT === undefined) delete process.env.FINANCE_AGENT_MOCK_AGENT;
    else process.env.FINANCE_AGENT_MOCK_AGENT = previous.FINANCE_AGENT_MOCK_AGENT;
    if (previous.FINANCE_AGENT_MOCK_AGENT_DELAY === undefined) delete process.env.FINANCE_AGENT_MOCK_AGENT_DELAY;
    else process.env.FINANCE_AGENT_MOCK_AGENT_DELAY = previous.FINANCE_AGENT_MOCK_AGENT_DELAY;
  }
})();

atomicMultirowWritesTestPromise.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
