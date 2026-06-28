import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const generatedFilesTestPromise = (async () => {
  // 用独立临时 app data 目录,避免污染真实库;getConversationFilesDir = <appData>/files/<cid>
  const appData = mkdtempSync(path.join(tmpdir(), "fa-genfiles-"));
  process.env.FINANCE_AGENT_APP_DATA_DIR = appData;
  delete process.env.FINANCE_AGENT_FILES_DIR; // 否则会把所有会话指向同一目录

  const { snapshotGeneratedFiles, recordNewGeneratedFiles } = await import("../lib/chat/generated-files.ts");

  const cid = 9901;
  const convDir = path.join(appData, "files", String(cid));
  const uploadDir = path.join(convDir, "upload");
  const generateDir = path.join(convDir, "generate");
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(generateDir, { recursive: true });

  // 上传的输入文件(回合开始前就在)
  writeFileSync(path.join(uploadDir, "营业预测.xlsx"), "input");
  // 系统噪声文件,绝不能被当成产物
  writeFileSync(path.join(convDir, ".DS_Store"), "junk");

  const before = snapshotGeneratedFiles(cid);

  // 回合中模型产出:① 写到输入旁边(upload/) ② 规范地写到 generate/
  writeFileSync(path.join(uploadDir, "营业预测-更新.pptx"), "out1");
  writeFileSync(path.join(generateDir, "汇总.xlsx"), "out2");

  // messageId 传 undefined → 只走 fs 差集,不写库(核心是差集逻辑)
  const recorded = recordNewGeneratedFiles(cid, undefined, before);
  const names = recorded.map((f) => f.name).sort();

  assert.deepEqual(
    names,
    ["营业预测-更新.pptx", "汇总.xlsx"].sort(),
    `应追踪 upload/ 与 generate/ 里的新增产物,实际:${JSON.stringify(names)}`
  );
  assert.ok(!names.includes("营业预测.xlsx"), "上传的输入文件不应被误记为产物");
  assert.ok(!names.includes(".DS_Store"), "点文件/系统文件不应被当成产物");

  // ── syncGeneratedAttachments:用户上传不应被误登记成生成(bug 修复回归)──
  const { randomUUID } = await import("node:crypto");
  const { createChatConversation, insertChatMessage, insertChatAttachment, getDb } = await import("../lib/db/sqlite.ts");
  const { syncGeneratedAttachments } = await import("../lib/chat/generated-files.ts");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const cid2 = createChatConversation("sync-dedup-test");
  const umsg = insertChatMessage(cid2, "user", "带上传");
  insertChatMessage(cid2, "assistant", "回复");
  const conv2 = path.join(appData, "files", String(cid2));
  mkdirSync(path.join(conv2, "upload"), { recursive: true });
  mkdirSync(path.join(conv2, "generate"), { recursive: true });
  writeFileSync(path.join(conv2, "upload", "输入.xlsx"), "u");
  writeFileSync(path.join(conv2, "generate", "产出.xlsx"), "g");
  // 上传文件已登记为 user 附件(模拟 query route 行为)
  insertChatAttachment({ id: randomUUID(), messageId: umsg, fileName: "输入.xlsx", mimeType: XLSX_MIME, sizeBytes: 1, storagePath: "upload/输入.xlsx", role: "user" });

  syncGeneratedAttachments(cid2);

  const db2 = getDb();
  const arows = db2.prepare(`
    SELECT a.role, a.storage_path FROM chat_attachments a
    JOIN chat_messages m ON a.message_id = m.id WHERE m.conversation_id = ?
  `).all(cid2) as Array<{ role: string; storage_path: string }>;
  const assistantPaths = arows.filter((r) => r.role === "assistant").map((r) => r.storage_path);
  assert.ok(!assistantPaths.includes("upload/输入.xlsx"), "上传文件不应被 sync 误登记成生成(assistant)");
  assert.ok(assistantPaths.includes("generate/产出.xlsx"), "真实生成文件应被 sync 登记成 assistant");

  // ── migration v2:清理已有的"上传被误记成生成"分身,仅删行、不动 user 行 ──
  const { MIGRATIONS } = await import("../lib/db/migrations.ts");
  const cid3 = createChatConversation("phantom-cleanup-test");
  const um3 = insertChatMessage(cid3, "user", "上传");
  const am3 = insertChatMessage(cid3, "assistant", "回复");
  insertChatAttachment({ id: randomUUID(), messageId: um3, fileName: "x.xlsx", mimeType: XLSX_MIME, sizeBytes: 1, storagePath: "upload/x.xlsx", role: "user" });
  // 模拟旧 bug 留下的分身:assistant 附件指向同一 upload 路径
  insertChatAttachment({ id: randomUUID(), messageId: am3, fileName: "x.xlsx", mimeType: XLSX_MIME, sizeBytes: 1, storagePath: "upload/x.xlsx", role: "assistant" });
  const v2 = MIGRATIONS.find((m) => m.version === 2)!;
  v2.up(getDb());
  const after = db2.prepare(`
    SELECT a.role FROM chat_attachments a
    JOIN chat_messages m ON a.message_id = m.id WHERE m.conversation_id = ?
  `).all(cid3) as Array<{ role: string }>;
  assert.equal(after.filter((r) => r.role === "assistant").length, 0, "迁移应删除上传的 assistant 分身");
  assert.equal(after.filter((r) => r.role === "user").length, 1, "迁移不应动 user 上传行");

  console.log("generated-files: all 7 checks passed ✓");
})();
