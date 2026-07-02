/**
 * chat-float.test.ts — D1 切片先行失败测试（契约 1 + 2）
 *
 * 覆盖：
 * - A1  app/shared/chat-float.tsx 存在
 * - A2  复用 useChatStream + startTurn（源码引用）
 * - A3  复用 MarkdownMessage（源码引用）
 * - A4  ask_user 检测：订阅 timeline，检测到未配对的 ask_user 时 router.push(/chat/recent?id=)
 * - A5  监听 CustomEvent "chat-float:open"（detail.text 预填并打开小窗）
 * - A6  放大按钮双分支：conversationId 有 → /chat/recent?id=；无 → /chat/new?prompt=
 * - A7  /chat 路径下圆钮隐藏（usePathname + 条件渲染）
 * - A8  app/shared/app-shell.tsx 挂载 ChatFloat
 * - A9  负面断言：不 import ToolStepList / AskUserPanel / ChatPreviewSidebar
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/chat-float.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

export const chatFloatTestPromise = (async () => {

  // ─── A1: app/shared/chat-float.tsx 应存在 ─────────────────────────────────
  {
    assert.ok(
      exists("app/shared/chat-float.tsx"),
      "A1 FAIL: app/shared/chat-float.tsx 应存在（D1 切片新组件）"
    );
  }

  const floatSrc = src("app/shared/chat-float.tsx");

  // ─── A2: 复用 useChatStream + startTurn ────────────────────────────────────
  {
    assert.ok(
      floatSrc.includes("useChatStream"),
      "A2 FAIL: chat-float.tsx 应 import/调用 useChatStream（复用流逻辑，不另起炉灶）"
    );

    assert.ok(
      floatSrc.includes("startTurn"),
      "A2 FAIL: chat-float.tsx 应调用 startTurn（通过 useChatStream 发起流式请求）"
    );
  }

  // ─── A3: 复用 MarkdownMessage ──────────────────────────────────────────────
  // 裁决补强(2026-07-02):必须真复用——抽取为共享模块 app/chat/markdown-message.tsx 并从
  // 该路径 import,禁止在 chat-float 内联重写(字符串同名冒充复用);chat-page 同步改为引用共享模块
  {
    assert.ok(
      floatSrc.includes('from "@/app/chat/markdown-message"'),
      "A3 FAIL: chat-float.tsx 应从共享模块 @/app/chat/markdown-message import MarkdownMessage"
    );
    assert.ok(
      exists("app/chat/markdown-message.tsx"),
      "A3 FAIL: MarkdownMessage 应抽取为 app/chat/markdown-message.tsx 共享模块"
    );
    const chatPageSrc = src("app/chat/chat-page.tsx");
    assert.ok(
      chatPageSrc.includes('from "@/app/chat/markdown-message"') || chatPageSrc.includes('from "./markdown-message"'),
      "A3 FAIL: chat-page.tsx 应改为引用共享的 markdown-message 模块（单一实现）"
    );
  }

  // ─── A4: ask_user 检测 + 自动升全屏 ──────────────────────────────────────
  {
    // 检测 timeline 中未配对的 ask_user 事件
    assert.ok(
      floatSrc.includes("ask_user"),
      "A4 FAIL: chat-float.tsx 应检测 ask_user 类型事件（安全红线：确认门不能在小窗渲染）"
    );

    // 升全屏：router.push 到 /chat/recent?id=
    assert.ok(
      floatSrc.includes("/chat/recent"),
      "A4 FAIL: chat-float.tsx 检测到 ask_user 时应 router.push 到 /chat/recent?id= 全屏继续"
    );

    // 用了 router（useRouter 或 router.push）
    assert.ok(
      floatSrc.includes("useRouter") || floatSrc.includes("router.push"),
      "A4 FAIL: chat-float.tsx 应使用 useRouter（用于升全屏跳转）"
    );

    // timeline 字段订阅（turn.timeline 或 timeline）
    assert.ok(
      floatSrc.includes("timeline"),
      "A4 FAIL: chat-float.tsx 应订阅 turn.timeline 检测 ask_user 事件"
    );
  }

  // ─── A5: 监听 CustomEvent "chat-float:open" ────────────────────────────────
  {
    assert.ok(
      floatSrc.includes("chat-float:open"),
      "A5 FAIL: chat-float.tsx 应监听 CustomEvent \"chat-float:open\"（detail.text 预填并打开小窗）"
    );

    assert.ok(
      floatSrc.includes("addEventListener") || floatSrc.includes("useEffect"),
      "A5 FAIL: chat-float.tsx 应在 useEffect 中 addEventListener 监听 chat-float:open 事件"
    );

    // detail.text 字段取预填文本
    assert.ok(
      floatSrc.includes("detail") && (floatSrc.includes(".text") || floatSrc.includes("detail.text")),
      "A5 FAIL: chat-float.tsx 应从事件 detail.text 取预填文本"
    );
  }

  // ─── A6: 放大按钮双分支 ────────────────────────────────────────────────────
  {
    // conversationId 有 → /chat/recent?id=
    assert.ok(
      floatSrc.includes("conversationId"),
      "A6 FAIL: chat-float.tsx 应读取 conversationId（放大按钮分支判断依赖）"
    );

    // 无 conversationId 分支 → /chat/new?prompt=
    assert.ok(
      floatSrc.includes("/chat/new"),
      "A6 FAIL: chat-float.tsx 放大按钮无 conversationId 时应跳 /chat/new?prompt=（携草稿）"
    );

    // 有 conversationId 分支 → /chat/recent?id=（A4 已断言，此处再次确认用于放大按钮上下文）
    assert.ok(
      floatSrc.includes("/chat/recent"),
      "A6 FAIL: chat-float.tsx 放大按钮有 conversationId 时应跳 /chat/recent?id=（继续同会话）"
    );
  }

  // ─── A7: /chat 路径下圆钮隐藏 ─────────────────────────────────────────────
  {
    // 用 usePathname 读路径
    assert.ok(
      floatSrc.includes("usePathname"),
      "A7 FAIL: chat-float.tsx 应使用 usePathname（检测当前路径）"
    );

    // 检测 /chat 前缀
    assert.ok(
      floatSrc.includes("/chat") &&
      (floatSrc.includes("startsWith") || floatSrc.includes("pathname") || floatSrc.includes("hidden")),
      "A7 FAIL: chat-float.tsx 应在 /chat 路径下隐藏圆钮（全屏对话页不需要浮窗）"
    );
  }

  // ─── A8: app/shared/app-shell.tsx 挂载 ChatFloat ──────────────────────────
  {
    assert.ok(
      exists("app/shared/app-shell.tsx"),
      "A8 FAIL: app/shared/app-shell.tsx 应存在"
    );

    const shellSrc = src("app/shared/app-shell.tsx");

    assert.ok(
      shellSrc.includes("ChatFloat"),
      "A8 FAIL: app/shared/app-shell.tsx 应挂载 ChatFloat 组件（全局挂载点，GlobalShortcuts 旁）"
    );

    assert.ok(
      shellSrc.includes("chat-float"),
      "A8 FAIL: app/shared/app-shell.tsx 应 import chat-float 模块"
    );
  }

  // ─── A9: 负面断言——小窗不引入复杂交互组件 ────────────────────────────────
  {
    // 小窗阶段一不渲染工具卡/确认门/文件预览
    assert.ok(
      !floatSrc.includes("ToolStepList"),
      "A9 FAIL: chat-float.tsx 不应 import ToolStepList（阶段一小窗不渲染工具卡，属阶段二范围）"
    );

    assert.ok(
      !floatSrc.includes("AskUserPanel"),
      "A9 FAIL: chat-float.tsx 不应 import AskUserPanel（安全红线：ask_user 应升全屏，绝不在小窗渲染确认门）"
    );

    assert.ok(
      !floatSrc.includes("ChatPreviewSidebar"),
      "A9 FAIL: chat-float.tsx 不应 import ChatPreviewSidebar（阶段一小窗不渲染文件预览，属阶段二范围）"
    );
  }

  console.log("chat-float: all A1–A9 checks passed ✓（红 = 实现还未落地；绿 = 实现完成）");
})();
