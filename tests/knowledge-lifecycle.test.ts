import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  initializeFinanceDatabase,
  insertKnowledgeDocument,
  listActiveKnowledgeDocuments,
  markKnowledgeHits,
  openFinanceDatabase,
  setKnowledgeArchived,
  getKnowledgeDocumentById
} from "../lib/db/sqlite.ts";
import { writeTextMirror, getKnowledgeTextDir } from "../lib/knowledge/storage.ts";

export const knowledgeLifecycleTestPromise = (async () => {
  const baseDir = `/tmp/finance-agent-kb-lifecycle-${process.pid}`;
  rmSync(baseDir, { recursive: true, force: true });
  process.env.FINANCE_AGENT_APP_DATA_DIR = baseDir;
  process.env.FINANCE_AGENT_DB_PATH = path.join(baseDir, "kb.db");
  process.env.FINANCE_AGENT_KNOWLEDGE_DIR = path.join(baseDir, "knowledge");
  delete process.env.FINANCE_AGENT_KNOWLEDGE_TEXT_DIR;

  const db = initializeFinanceDatabase(openFinanceDatabase(path.join(baseDir, "kb.db")));

  const addDoc = (title: string, hash: string, text: string) => {
    writeTextMirror(hash, text);
    return insertKnowledgeDocument(
      { title, file_name: `${title}.txt`, mime_type: "text/plain", category: "general", size_bytes: text.length, chunk_count: 0, content_hash: hash },
      db
    );
  };

  const idA = addDoc("报销管理制度", "hashA", "差旅住宿标准 500");
  const idB = addDoc("考勤制度", "hashB", "迟到扣款");
  const idC = addDoc("报销管理制度", "hashC", "另一版本"); // 同名,验证冲突加后缀

  // ── T1: 命中埋点 ────────────────────────────────────────────────────
  assert.equal(getKnowledgeDocumentById(idA)!.hit_count, 0);
  markKnowledgeHits([idA, idB], db);
  markKnowledgeHits([idA], db);
  assert.equal(getKnowledgeDocumentById(idA)!.hit_count, 2, "T1 FAIL: A 命中 2 次");
  assert.equal(getKnowledgeDocumentById(idB)!.hit_count, 1);
  assert.ok(getKnowledgeDocumentById(idA)!.last_hit_at, "T1 FAIL: last_hit_at 应有值");
  markKnowledgeHits([], db); // 空集合不报错

  // ── T2: 归档 → 从生产检索排除 ────────────────────────────────────────
  setKnowledgeArchived(idB, true, db);
  assert.equal(getKnowledgeDocumentById(idB)!.archived, 1);
  const active = listActiveKnowledgeDocuments(db);
  assert.ok(!active.some((d) => d.id === idB), "T3 FAIL: 归档文档不应出现在检索可见列表");

  // ── T3: 恢复归档 → 重新可见 ──────────────────────────────────────────
  setKnowledgeArchived(idB, false, db);
  assert.ok(listActiveKnowledgeDocuments(db).some((d) => d.id === idB), "T3 FAIL: 恢复后应重新可见");

  // ── T4: 删除文档后数据库事实消失 ─────────────────────────────────────
  db.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(idC);
  assert.equal(getKnowledgeDocumentById(idC), undefined, "T4 FAIL: 删除后文档应消失");

  // ── T5: markKnowledgeHits 批量 IN 更新，2 个不同 id 各 +1 ──────────────
  const db2 = initializeFinanceDatabase(openFinanceDatabase(path.join(baseDir, "kb2.db")));
  const addDoc2 = (title: string, hash: string) =>
    insertKnowledgeDocument(
      { title, file_name: `${title}.txt`, mime_type: "text/plain", category: "general", size_bytes: 1, chunk_count: 0, content_hash: hash },
      db2
    );
  const idX = addDoc2("文档X", "hashX");
  const idY = addDoc2("文档Y", "hashY");
  assert.equal((db2.prepare("SELECT hit_count FROM knowledge_documents WHERE id = ?").get(idX) as { hit_count: number }).hit_count, 0);
  markKnowledgeHits([idX, idY], db2);
  assert.equal((db2.prepare("SELECT hit_count FROM knowledge_documents WHERE id = ?").get(idX) as { hit_count: number }).hit_count, 1, "T6 FAIL: X 应 +1");
  assert.equal((db2.prepare("SELECT hit_count FROM knowledge_documents WHERE id = ?").get(idY) as { hit_count: number }).hit_count, 1, "T6 FAIL: Y 应 +1");
  db2.close();

  db.close();
  for (const k of ["FINANCE_AGENT_APP_DATA_DIR", "FINANCE_AGENT_DB_PATH", "FINANCE_AGENT_KNOWLEDGE_DIR"]) delete process.env[k];
  void getKnowledgeTextDir;
  console.log("knowledge-lifecycle: all 5 checks passed ✓");
})();
