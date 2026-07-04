import assert from "node:assert/strict";
import { formatFolderPathLine } from "../app/chat/chat-request.ts";

// 选文件夹后把本地路径格式化成一行插入输入框,意图由用户自行表达。
export const folderIngestTestPromise = (async () => {
  const p = "/Users/x/单据/2026-06";
  const msg = formatFolderPathLine(p);

  // 必须原样带上路径
  assert.ok(msg.includes(p), "F1 FAIL: 返回值应包含文件夹路径");
  // 不应再带业务意图词(意图已移除)
  assert.ok(!/凭证/.test(msg), "F-neg FAIL: 返回值不应含「凭证」等意图词");

  // 空路径 → 空串(不插入无意义内容)
  assert.equal(formatFolderPathLine(""), "", "F4 FAIL: 空路径应返回空串");
  assert.equal(formatFolderPathLine("   "), "", "F5 FAIL: 纯空白应返回空串");

  console.log("folder-ingest: 路径插入 / 意图已移除 / 空路径兜底 ✓");
})();
