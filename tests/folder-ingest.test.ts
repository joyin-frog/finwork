import assert from "node:assert/strict";
import {
  formatFolderPathLine,
  folderNameFromPath,
  splitFolderPathLines,
  FOLDER_PATH_LINE_PREFIX,
} from "../app/chat/folder-path.ts";
import { stripAttachmentSummary } from "../app/chat/chat-types.ts";

// 选文件夹:路径格式化 + 气泡拆成卡片 + 正文剥离。
export const folderIngestTestPromise = (async () => {
  const p = "/Users/x/单据/2026-06";
  const msg = formatFolderPathLine(p);

  // 必须原样带上路径
  assert.ok(msg.includes(p), "F1 FAIL: 返回值应包含文件夹路径");
  assert.equal(msg, `${FOLDER_PATH_LINE_PREFIX}${p}`, "F1b FAIL: 前缀格式");
  // 不应再带业务意图词(意图已移除)
  assert.ok(!/凭证/.test(msg), "F-neg FAIL: 返回值不应含「凭证」等意图词");

  // 空路径 → 空串(不插入无意义内容)
  assert.equal(formatFolderPathLine(""), "", "F4 FAIL: 空路径应返回空串");
  assert.equal(formatFolderPathLine("   "), "", "F5 FAIL: 纯空白应返回空串");

  assert.equal(folderNameFromPath("/Users/x/单据/母子公司合并报表"), "母子公司合并报表", "F6 FAIL: 取末段名");
  assert.equal(folderNameFromPath("C:\\\\a\\\\b\\\\c"), "c", "F7 FAIL: Windows 路径末段");

  const mixed = `请处理\n${formatFolderPathLine(p)}\n补充说明`;
  const split = splitFolderPathLines(mixed);
  assert.equal(split.folders.length, 1, "F8 FAIL: 应拆出 1 个文件夹");
  assert.equal(split.folders[0]?.path, p, "F9 FAIL: 路径原样");
  assert.equal(split.folders[0]?.name, "2026-06", "F10 FAIL: 文件夹名");
  assert.equal(split.text, "请处理\n补充说明", "F11 FAIL: 剩余正文");

  assert.equal(
    stripAttachmentSummary(mixed),
    "请处理\n补充说明",
    "F12 FAIL: 展示正文应剥离文件夹路径行",
  );

  // 仅路径 → 无气泡正文
  assert.equal(stripAttachmentSummary(formatFolderPathLine(p)), "", "F13 FAIL: 纯路径消息展示为空");

  console.log("folder-ingest: 路径格式 / 拆卡片 / 正文剥离 ✓");
})();
