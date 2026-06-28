import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf-8");

function main() {
  const appShell = read("app/shared/app-shell.tsx");
  const globalShortcuts = read("app/shared/global-shortcuts.tsx");
  const chatPage = read("app/chat/chat-page.tsx");
  const appNav = read("app/shared/app-nav.tsx");
  const sidebarToggle = read("app/shared/sidebar-toggle.tsx");
  const filePanel = read("app/chat/chat-file-panel.tsx");

  // ── AC7: 装配 ──
  assert.ok(appShell.includes("<TooltipProvider"), "AC7 FAIL: AppShell 应挂 TooltipProvider");
  assert.ok(appShell.includes("<GlobalShortcuts"), "AC7 FAIL: AppShell 应挂 GlobalShortcuts");
  assert.equal(
    (globalShortcuts.match(/addEventListener\("keydown"/g) ?? []).length,
    1,
    "AC7 FAIL: 全局 keydown 监听必须唯一"
  );
  assert.ok(globalShortcuts.includes("resolveShortcut("), "AC7 FAIL: 监听器必须走纯内核决策");
  assert.ok(globalShortcuts.includes("event.isComposing"), "AC7 FAIL: 必须跳过输入法组合态");
  assert.ok(globalShortcuts.includes("CustomEvent"), "AC7 FAIL: chat 作用域应经 CustomEvent 分发");
  assert.ok(chatPage.includes('useShortcutEvent("toggle-file-panel"'), "AC7 FAIL: ChatPage 应订阅 toggle-file-panel");

  // ── AC8: hover 提示覆盖 6 个目标按钮 ──
  assert.ok(chatPage.includes('combo="enter"'), "AC8 FAIL: 发送按钮缺提示");
  assert.ok(chatPage.includes('combo="/"'), "AC8 FAIL: 添加文件按钮缺提示");
  assert.ok(filePanel.includes('combo="mod+j"'), "AC8 FAIL: 文件面板按钮缺提示");
  assert.ok(sidebarToggle.includes('combo="mod+b"'), "AC8 FAIL: 导航折叠按钮缺提示");
  assert.ok(appNav.includes('combo="mod+n"'), "AC8 FAIL: 新对话缺提示");
  assert.ok(appNav.includes('combo="mod+,"'), "AC8 FAIL: 设置缺提示");

  // ── AC9: 一览表 ──
  assert.ok(globalShortcuts.includes("ShortcutsHelpDialog"), "AC9 FAIL: 应有快捷键一览 Dialog");
  assert.ok(globalShortcuts.includes("webLimited"), "AC9 FAIL: 浏览器受限项应有标注");
  assert.ok(globalShortcuts.includes('case "show-shortcuts"'), "AC9 FAIL: mod+/ 应切换一览表");

  // ── AC10: 既有键盘行为零回归(原实现原样保留) ──
  assert.ok(chatPage.includes('event.key === "Enter" && !event.shiftKey'), "AC10 FAIL: Enter 发送逻辑被改动");
  assert.ok(chatPage.includes('event.key === "/" && !draft.trim()'), "AC10 FAIL: / 添加文件逻辑被改动");
  assert.ok(chatPage.includes("(?:^|\\s)@([^\\s@]*)$"), "AC10 FAIL: @ 引用逻辑被改动");
  assert.ok(appNav.includes('if (e.key === "Escape") cancelRename()'), "AC10 FAIL: 重命名 Esc 被改动");

  console.log("shortcuts-wiring: all 4 checks passed ✓");
}

main();
