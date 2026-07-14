/**
 * tests/chat-message-edit-retract.test.ts
 *
 * 消息工具栏源码契约（复制 / 撤回到输入框 / 时间戳）+ 文件面板 Popover 修位。
 * 「撤回」是非破坏性动作：只把消息文字+附件放回输入框，不删除、不改动历史消息，
 * 故不涉及任何 DB 截断 / 会话作废逻辑（已随过度设计一并移除）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const chatMessageEditRetractTestPromise = (async () => {
  // ── user-bubble.tsx：复制 + 撤回(放回输入框) + 时间戳，无内联编辑 ──────────────
  {
    const bubbleSrc = readFileSync(path.join(projectRoot, "app/chat/components/user-bubble.tsx"), "utf-8");
    assert.ok(bubbleSrc.includes("onRetract"), "CEDR-1 FAIL: user-bubble.tsx 应含 onRetract prop");
    assert.ok(
      bubbleSrc.includes("CopyIcon") || bubbleSrc.includes("复制"),
      "CEDR-2 FAIL: user-bubble.tsx 应含复制按钮"
    );
    assert.ok(
      bubbleSrc.includes("Undo03Icon") || bubbleSrc.includes("撤回"),
      "CEDR-3 FAIL: user-bubble.tsx 应含撤回按钮"
    );
    assert.ok(bubbleSrc.includes("messageTimestamp"), "CEDR-4 FAIL: user-bubble.tsx 应含时间戳");
    // 非破坏性：不再有内联编辑，也不做「仅最后一条」门控
    assert.ok(!bubbleSrc.includes("onEditSubmit"), "CEDR-5 FAIL: 不应再含 onEditSubmit");
    assert.ok(!bubbleSrc.includes("<textarea"), "CEDR-6 FAIL: 不应再含内联编辑 textarea");
    assert.ok(!bubbleSrc.includes("canModify"), "CEDR-7 FAIL: 撤回作用于每条消息，不应再有 canModify 门控");
  }

  // ── chat-page.tsx：非破坏性撤回，无截断/编辑残留 ─────────────────────────────
  {
    const pageSrc = readFileSync(path.join(projectRoot, "app/chat/chat-page.tsx"), "utf-8");
    assert.ok(pageSrc.includes("retractMessage"), "CEDR-8 FAIL: chat-page.tsx 应含 retractMessage");
    assert.ok(pageSrc.includes("onRetract"), "CEDR-9 FAIL: chat-page.tsx 应给 UserBubble 传 onRetract");
    assert.ok(!pageSrc.includes("editLastMessage"), "CEDR-10 FAIL: 不应再含 editLastMessage");
    assert.ok(!pageSrc.includes("onEditSubmit"), "CEDR-11 FAIL: 不应再含 onEditSubmit");
    // 非破坏性：撤回不再截断会话
    assert.ok(!pageSrc.includes("truncateConversation"), "CEDR-12 FAIL: 撤回应为非破坏性，不应调用 truncateConversation");
  }

  // ── 截断相关代码应已彻底移除 ─────────────────────────────────────────────────
  {
    const requestSrc = readFileSync(path.join(projectRoot, "app/chat/chat-request.ts"), "utf-8");
    assert.ok(!requestSrc.includes("truncateConversation"), "CEDR-13 FAIL: chat-request.ts 不应再含 truncateConversation");
    const sqliteSrc = readFileSync(path.join(projectRoot, "lib/db/sqlite.ts"), "utf-8");
    assert.ok(!sqliteSrc.includes("deleteMessagesFrom"), "CEDR-14 FAIL: sqlite.ts 不应再含 deleteMessagesFrom");
    assert.ok(!sqliteSrc.includes("clearChatConversationClaudeSession"), "CEDR-15 FAIL: sqlite.ts 不应再含 clearChatConversationClaudeSession");
  }

  // ── chat-file-panel.tsx：Popover 修位（保留） ────────────────────────────────
  {
    const panelSrc = readFileSync(path.join(projectRoot, "app/chat/chat-file-panel.tsx"), "utf-8");
    assert.ok(panelSrc.includes("Popover"), "CEDR-16 FAIL: chat-file-panel.tsx 应引入 Popover");
    assert.ok(!panelSrc.includes("top-[46px]"), "CEDR-17 FAIL: 不应再含 top-[46px] 定位");
    assert.ok(!panelSrc.includes("panelRightOffset"), "CEDR-18 FAIL: 不应含 panelRightOffset");
  }

  console.log("[chat-message-edit-retract] 全部测试通过");
})();
