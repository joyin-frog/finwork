import assert from "node:assert/strict";
import { buildFolderIngestPrompt } from "../app/chat/chat-request.ts";

// 选单据文件夹 → 生成触发 kingdee-draft skill 的消息(路径注入 + 触发词)。
export const folderIngestTestPromise = (async () => {
  const p = "/Users/x/单据/2026-06";
  const msg = buildFolderIngestPrompt(p);

  // 必须原样带上路径(agent 靠它 run_python 列目录)
  assert.ok(msg.includes(p), "F1 FAIL: 消息应包含文件夹路径");
  // 必须带触发词(命中 kingdee-draft skill 的「单据/凭证/文件夹」)
  assert.ok(/凭证/.test(msg) && /单据/.test(msg), "F2 FAIL: 应含「单据」「凭证」触发词");
  // 汇总确认模式提示(先出大表、有疑点问)
  assert.ok(/汇总|大表|逐张|疑点|确认/.test(msg), "F3 FAIL: 应提示汇总确认");

  // 空路径 → 空串(不发无意义消息)
  assert.equal(buildFolderIngestPrompt(""), "", "F4 FAIL: 空路径应返回空串");
  assert.equal(buildFolderIngestPrompt("   "), "", "F5 FAIL: 纯空白应返回空串");

  console.log("folder-ingest: 路径注入 / 触发词 / 汇总提示 / 空路径兜底 ✓");
})();
