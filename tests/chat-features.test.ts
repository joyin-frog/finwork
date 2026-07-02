import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uniqueFilePath } from "../lib/files/unique-name";

function main() {
  // ---- Test 1: rehype-highlight is installed ----
  try {
    require.resolve("rehype-highlight");
    console.log("✓ PASS: rehype-highlight is installed");
  } catch {
    assert.fail("rehype-highlight should be installed");
  }

  // ---- Test 2: CSS has highlight.js theme imported ----
  const layoutContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/layout.tsx"), "utf-8"
  );
  assert.ok(
    layoutContent.includes("highlight.js/styles"),
    "layout.tsx should include highlight.js theme CSS"
  );
  console.log("✓ PASS: layout injects highlight.js theme");

  // ---- Test 3: layout imports current style entries (Tailwind v4 架构) ----
  assert.ok(
    layoutContent.includes("globals.css"),
    "layout.tsx should import globals.css"
  );
  assert.ok(
    layoutContent.includes("styles/preview.css"),
    "layout.tsx should import styles/preview.css"
  );
  console.log("✓ PASS: layout imports current style entries");

  // ---- Test 4: CSS has streaming-cursor animation ----
  const cssContent = [
    fs.readFileSync(path.join(import.meta.dirname, "../app/globals.css"), "utf-8"),
    fs.readFileSync(path.join(import.meta.dirname, "../app/styles/preview.css"), "utf-8")
  ].join("\n");
  assert.ok(
    cssContent.includes("cursorBlink"),
    "style bundle should contain cursorBlink keyframes"
  );
  console.log("✓ PASS: streaming cursor animation exists");

  // ---- Test 5: sanitize schema allows finance-file protocol and class attrs ----
  // 裁决修订(2026-07-02):MarkdownMessage 抽取为共享模块后,「对话渲染层」跨三个文件——
  // 本测试的 chatContent 语义是渲染层整体,拼接读取;断言原样不动,禁止在 chat-page 留哨兵死代码喂断言
  const chatContent = [
    "../app/chat/chat-page.tsx",
    "../app/chat/markdown-message.tsx",
    "../app/chat/markdown-rehype-config.ts",
  ]
    .map((p) => fs.readFileSync(path.join(import.meta.dirname, p), "utf-8"))
    .join("\n");
  const panelContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/chat/chat-file-panel.tsx"), "utf-8"
  );
  const previewSidebarContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/chat/chat-preview-sidebar.tsx"), "utf-8"
  );
  const workspaceStateContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/chat/file-workspace-state.ts"), "utf-8"
  );
  const previewSelectionContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/chat/chat-preview-selection.ts"), "utf-8"
  );
  const specContent = fs.readFileSync(
    path.join(import.meta.dirname, "../docs/spec/chat-panel-preview-v3-spec.md"), "utf-8"
  );
  const v4SpecContent = fs.readFileSync(
    path.join(import.meta.dirname, "../docs/spec/chat-panel-preview-v4-spec.md"), "utf-8"
  );
  const excelSpecContent = fs.readFileSync(
    path.join(import.meta.dirname, "../docs/spec/excel-preview-spec.md"), "utf-8"
  );
  const navContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/shared/app-nav.tsx"), "utf-8"
  );
  assert.ok(
    chatContent.includes('"finance-file"'),
    "chat-page.tsx should allow finance-file in sanitize protocols"
  );
  assert.ok(
    chatContent.includes('"className"'),
    "chat-page.tsx should allow className in sanitize attributes"
  );
  console.log("✓ PASS: sanitize schema allows finance-file + className");

  // ---- Test 7: input disabled during loading ----
  assert.ok(
    chatContent.includes("disabled={loading}"),
    "textarea should be disabled when loading"
  );
  console.log("✓ PASS: textarea disabled during loading");

  // ---- Test 8: app-shell wrapper exists ----
  const appShellContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/shared/app-shell.tsx"), "utf-8"
  );
  assert.ok(
    appShellContent.includes("export function AppShell"),
    "app-shell.tsx should export AppShell"
  );
  console.log("✓ PASS: AppShell component exists");

  // ---- Test 9: chat topbar includes panel tab and shared preview page ----
  assert.ok(
    chatContent.includes("ChatFilePanel"),
    "chat-page.tsx should delegate the file panel to a separate component"
  );
  assert.ok(
    chatContent.includes("ChatPreviewSidebar"),
    "chat-page.tsx should delegate the preview sidebar to a separate component"
  );
  assert.ok(
    panelContent.includes("面板"),
    "chat-file-panel.tsx should render the panel tab"
  );
  assert.ok(
    previewSidebarContent.includes("FilePreviewPage"),
    "chat-preview-sidebar.tsx should wrap the shared preview page"
  );
  assert.ok(
    workspaceStateContent.includes("shouldAutoOpenOutputPanel"),
    "file-workspace-state.ts should expose panel auto-open rules"
  );
  assert.ok(
    workspaceStateContent.includes("getDefaultSidebarWidth"),
    "file-workspace-state.ts should expose the default 1:1 sidebar width rule"
  );
  assert.ok(
    chatContent.includes("panelRightOffset"),
    "chat-page.tsx should pass the panel alignment offset into ChatFilePanel"
  );
  assert.ok(
    previewSelectionContent.includes("previewSelectionFromDraftAttachment"),
    "chat-preview-selection.ts should expose the draft preview mapping helper"
  );
  assert.ok(
    navContent.includes("activeConversationId === c.id"),
    "app-nav.tsx should mark the active recent conversation row"
  );
  assert.ok(
    specContent.includes("输入区中尚未发送的上传附件"),
    "the v3 spec should capture unsent attachment preview requirements"
  );
  assert.ok(
    chatContent.includes("添加照片和文件"),
    "chat-page.tsx should offer an add-photo-and-file menu action"
  );
  assert.ok(
    chatContent.includes("添加文件"),
    "chat-page.tsx should offer an add-file menu action"
  );
  assert.ok(
    v4SpecContent.includes("添加照片"),
    "the v4 spec should capture the add-photo menu requirement"
  );
  assert.ok(
    v4SpecContent.includes("置顶") && v4SpecContent.includes("最近"),
    "the v4 spec should capture the left-nav group-button styling rule"
  );
  assert.ok(
    excelSpecContent.includes("横向滚动"),
    "the excel preview spec should capture the horizontal scrolling requirement"
  );
  console.log("✓ PASS: chat page delegates panel + preview sidebar");

  // ---- Test 10: chat artifacts persist and render correctly ----
  const agentRouteContent = fs.readFileSync(
    path.join(import.meta.dirname, "../app/api/agent/query/route.ts"), "utf-8"
  );
  assert.ok(
    agentRouteContent.includes("insertChatAgentEvent(messageId, event.type, event, traceId)"),
    "agent route should persist agent events"
  );
  assert.ok(
    agentRouteContent.includes('type: "thinking"') && agentRouteContent.includes("redact(filterIdentity"),
    "agent route should surface thinking events, scrubbed via identity + PII filtering"
  );
  assert.ok(
    chatContent.includes("fileNameFromStoragePath") && chatContent.includes("previewFile"),
    "chat-page.tsx should render finance-file links even when files are not pre-matched"
  );
  assert.ok(
    chatContent.includes("openExternalUrl") && chatContent.includes("InternetIcon"),
    "chat-page.tsx should render external http(s) links as clickable anchors with a 🌐 network marker, opened via openExternalUrl (system browser)"
  );
  assert.ok(
    chatContent.includes("return <span>{children}</span>;"),
    "chat-page.tsx should still render non-http, non-file links as plain text (no dead anchors)"
  );
  assert.ok(
    chatContent.includes("stripLegacyThinking"),
    "chat-page.tsx should strip legacy inline thinking details from rendered content (thinking now flows through the unified timeline / agentEvents)"
  );
  assert.ok(
    chatContent.includes("ToolStepList") && !chatContent.includes("function ToolCards"),
    "chat-page.tsx should use compact ToolStepList instead of legacy ToolCards"
  );
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-agent-unique-name-"));
  fs.writeFileSync(path.join(tmpDir, "报告.xlsx"), "one");
  fs.writeFileSync(path.join(tmpDir, "报告 2.xlsx"), "two");
  assert.equal(path.basename(uniqueFilePath(tmpDir, "报告.xlsx")), "报告 3.xlsx");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("✓ PASS: chat artifacts persist, link and de-duplicate files");

  // ---- Test 11: styles include preview page chrome ----
  assert.ok(
    cssContent.includes(".preview-head-card"),
    "style bundle should contain the inline preview header card styles"
  );
  assert.ok(
    cssContent.includes(".preview-text-page"),
    "style bundle should contain the plain text document page styles"
  );
  assert.ok(
    cssContent.includes(".preview-excel-page"),
    "style bundle should contain the worksheet-like excel page styles"
  );
  assert.ok(
    cssContent.includes(".preview-excel-grid-scroll"),
    "style bundle should contain the excel grid scroll container styles"
  );
  assert.ok(
    cssContent.includes(".preview-excel-grid"),
    "style bundle should contain the excel grid styles"
  );
  assert.ok(
    cssContent.includes("width: max-content"),
    "style bundle should allow the excel table to expand wider than the viewport"
  );
  assert.ok(
    cssContent.includes(".preview-excel-sheet-tabs"),
    "style bundle should contain the excel sheet tabs styles"
  );
  assert.ok(
    cssContent.includes(".preview-excel-formula-bar"),
    "style bundle should contain the excel formula bar styles"
  );
  assert.ok(
    cssContent.includes(".preview-excel-column-header"),
    "style bundle should contain the excel column header styles"
  );
  assert.ok(
    cssContent.includes(".preview-excel-row-header"),
    "style bundle should contain the excel row header styles"
  );
  assert.ok(
    cssContent.includes(".scroll-to-bottom-button"),
    "style bundle should contain the scroll-to-bottom button styles"
  );
  assert.ok(
    cssContent.includes(".attachment-chip-main"),
    "style bundle should contain clickable attachment-chip-main styles"
  );
  assert.ok(
    cssContent.includes(".attachment-chip .file-type-icon"),
    "style bundle should keep document file icons out of the image crop rule"
  );
  assert.ok(
    cssContent.includes(".attachment-chip-close"),
    "style bundle should contain the attachment close-button positioning styles"
  );
  assert.ok(
    cssContent.includes(".attachment-chip-main"),
    "style bundle should explicitly style the attachment main button"
  );
  assert.ok(
    panelContent.includes("showOpenWith={false}"),
    "panel file rows should hide the open-with control"
  );
  console.log("✓ PASS: styles include panel + preview selectors");

  console.log("\n✅ All chat feature tests passed!");
}

main();
