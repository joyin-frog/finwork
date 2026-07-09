/**
 * chat-process-polish.test.ts
 *
 * 覆盖 spec-chat-process-polish.md 第 8/9/10/11/14 项的纯函数 + 源码契约断言。
 *
 * 纯函数从非 React 工具模块导入:
 *   - app/chat/message-timestamp.ts  → messageTimestamp
 *   - app/chat/answer-snippet.ts     → extractAnswerSnippet
 *   - app/chat/voucher-chips.ts      → extractVoucherChips
 *   - app/chat/file-type-label.ts    → getFileTypeLabel (被 chat-file-browser.tsx 消费)
 *
 * 运行:
 *   FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_MOCK_AGENT_DELAY=0 SKIP_LLM=true \
 *     node --import tsx tests/chat-process-polish.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

export const chatProcessPolishTestPromise = (async () => {

  // ─── 纯函数测试 ─────────────────────────────────────────────────────────────

  // ── 第 8 项 helper: messageTimestamp ──────────────────────────────────────
  {
    const { messageTimestamp } = await import("../app/chat/message-timestamp.ts");

    // T8a: 1 分钟以内 → "刚刚"
    const nowMs = Date.now();
    assert.strictEqual(
      messageTimestamp(new Date(nowMs - 30_000).toISOString()),
      "刚刚",
      "T8a FAIL: 30s 前应为「刚刚」"
    );

    // T8b: 3 分钟前 → "3 分钟前"
    assert.strictEqual(
      messageTimestamp(new Date(nowMs - 3 * 60_000).toISOString()),
      "3 分钟前",
      "T8b FAIL: 3 分钟前格式不对"
    );

    // T8c: 昨天 → "昨天 HH:mm" 格式
    // 用「今天中午 − 24h」构造昨天,避免「now − 25h」在午夜后跨到前天导致的时间敏感 flake。
    const noonToday = new Date(nowMs);
    noonToday.setHours(12, 0, 0, 0);
    const yesterday = new Date(noonToday.getTime() - 24 * 3_600_000);
    const result8c = messageTimestamp(yesterday.toISOString());
    assert.ok(
      result8c.startsWith("昨天"),
      `T8c FAIL: 昨天消息应以「昨天」开头,实际:${result8c}`
    );
    assert.ok(
      /昨天 \d{2}:\d{2}/.test(result8c),
      `T8c FAIL: 昨天消息格式应为「昨天 HH:mm」,实际:${result8c}`
    );

    // T8d: 3 天前 → "M月d日" 格式
    const threeDaysAgo = new Date(nowMs - 3 * 24 * 3_600_000);
    const result8d = messageTimestamp(threeDaysAgo.toISOString());
    assert.ok(
      /\d+月\d+日/.test(result8d),
      `T8d FAIL: 3 天前应显示「M月d日」格式,实际:${result8d}`
    );

    // T8e: null → 空串
    assert.strictEqual(
      messageTimestamp(null),
      "",
      "T8e FAIL: null 应返回空串"
    );

    console.log("chat-process-polish T8: messageTimestamp 纯函数 ✓");
  }

  // ── 第 9 项 helper: extractAnswerSnippet ──────────────────────────────────
  {
    const { extractAnswerSnippet } = await import("../app/chat/answer-snippet.ts");

    // T9a: 单值 JSON 对象 → 答案文本
    const singleJson = JSON.stringify({ "处理哪些项目": "只做明确项" });
    assert.ok(
      extractAnswerSnippet(singleJson)!.includes("只做明确项"),
      `T9a FAIL: 单项答案提取失败,实际:${extractAnswerSnippet(singleJson)}`
    );

    // T9b: 多值 JSON 对象 → 「·」连接,截断到 40 字
    const multiJson = JSON.stringify({
      "项目": "只做明确项",
      "日期": "我来补日期",
      "备注": "无"
    });
    const snippet9b = extractAnswerSnippet(multiJson);
    assert.ok(snippet9b !== null, "T9b FAIL: 多项答案应有摘要");
    assert.ok(snippet9b!.includes("·"), "T9b FAIL: 多项答案应用「·」连接");
    assert.ok(
      snippet9b!.length <= 43, // 40 字 + 可能的 "…" (3 bytes as one char)
      `T9b FAIL: 摘要超 40 字+省略号限制,实际长度:${snippet9b!.length}`
    );

    // T9c: 非 JSON 字符串 → 直接返回截断文本
    const plain = "只做明确项";
    const snippet9c = extractAnswerSnippet(plain);
    assert.ok(snippet9c !== null, "T9c FAIL: 普通文本应能提取");
    assert.ok(
      snippet9c!.includes("只做明确项"),
      `T9c FAIL: 普通文本答案提取失败,实际:${snippet9c}`
    );

    // T9d: 空串 → null
    assert.strictEqual(
      extractAnswerSnippet(""),
      null,
      "T9d FAIL: 空串答案应返回 null"
    );

    // T9e: 超长文本应截断到 ≤ 40 字符(+省略号)
    const longAnswer = "这是一个非常非常长的答案文本，目的是测试截断逻辑是否正确工作，超过四十个字符的部分应该被省略号替代";
    const snippet9e = extractAnswerSnippet(longAnswer);
    assert.ok(snippet9e !== null, "T9e FAIL: 应有输出");
    assert.ok(snippet9e!.length <= 43, `T9e FAIL: 超长文本应截断,实际长度:${snippet9e!.length}`);

    console.log("chat-process-polish T9: extractAnswerSnippet 纯函数 ✓");
  }

  // ── 第 10 项 helper: getFileTypeLabel ─────────────────────────────────────
  {
    const { getFileTypeLabel } = await import("../app/chat/file-type-label.ts");

    // T10a: xlsx → 电子表格 · XLSX · x KB
    const label10a = getFileTypeLabel("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "report.xlsx", 6553);
    assert.ok(label10a.includes("电子表格"), `T10a FAIL: xlsx 应显示「电子表格」,实际:${label10a}`);
    assert.ok(label10a.includes("XLSX"), `T10a FAIL: xlsx 应包含「XLSX」,实际:${label10a}`);
    assert.ok(label10a.includes("KB"), `T10a FAIL: 应包含 KB,实际:${label10a}`);

    // T10b: pdf
    const label10b = getFileTypeLabel("application/pdf", "doc.pdf", 1024 * 512);
    assert.ok(label10b.includes("PDF"), `T10b FAIL: pdf 应显示「PDF」,实际:${label10b}`);

    // T10c: docx
    const label10c = getFileTypeLabel("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "memo.docx", 2048);
    assert.ok(label10c.includes("文档"), `T10c FAIL: docx 应显示「文档」,实际:${label10c}`);

    // T10d: 图片
    const label10d = getFileTypeLabel("image/jpeg", "photo.jpg", 512000);
    assert.ok(label10d.includes("图片"), `T10d FAIL: 图片应显示「图片」,实际:${label10d}`);

    // T10e: 未知类型 → 扩展名大写
    const label10e = getFileTypeLabel("application/octet-stream", "data.csv", 1024);
    assert.ok(label10e.includes("CSV"), `T10e FAIL: 未知类型应显示扩展名大写,实际:${label10e}`);

    // T10f: 格式为 「类型 · EXT · 大小」，用 · 分隔
    assert.ok(
      label10a.includes(" · "),
      `T10f FAIL: 分隔符应为「 · 」,实际:${label10a}`
    );

    console.log("chat-process-polish T10: getFileTypeLabel 纯函数 ✓");
  }

  // ── 第 11 项 helper: extractVoucherChips ──────────────────────────────────
  {
    const { extractVoucherChips } = await import("../app/chat/voucher-chips.ts");

    // 构造模拟 timeline item
    type FakeToolResult = { id: string; createdAt: number; event: { type: "tool_result"; name: string; content: string } };
    const makeToolResult = (name: string, content: string): FakeToolResult => ({
      id: "1",
      createdAt: 0,
      event: { type: "tool_result" as const, name, content },
    });

    // T11a: 命中 export_voucher_list + fileName 匹配 → 返回 chips 数据
    const voucherJson = JSON.stringify({
      filePath: "/tmp/foo.xlsx",
      fileName: "金蝶对照手填清单.xlsx",
      sheets: ["对照清单", "汇总", "待确认与跳过"],
      voucherCount: 42,
      skippedCount: 2,
    });
    const timeline11a = [makeToolResult("export_voucher_list", voucherJson)];
    const chips11a = extractVoucherChips(timeline11a, "金蝶对照手填清单.xlsx");
    assert.ok(chips11a !== null, "T11a FAIL: 应提取到 chips");
    assert.strictEqual(chips11a!.sheets, 3, `T11a FAIL: sheets 应为 3,实际:${chips11a!.sheets}`);
    assert.strictEqual(chips11a!.voucherCount, 42, `T11a FAIL: voucherCount 应为 42,实际:${chips11a!.voucherCount}`);

    // T11b: mcp__ 前缀形式也能命中
    const timeline11b = [makeToolResult("mcp__kingdee_worker__export_voucher_list", voucherJson)];
    const chips11b = extractVoucherChips(timeline11b, "金蝶对照手填清单.xlsx");
    assert.ok(chips11b !== null, "T11b FAIL: mcp__ 前缀形式应命中");

    // T11c: 文件名不匹配 → null
    const chips11c = extractVoucherChips(timeline11a, "其他文件.xlsx");
    assert.strictEqual(chips11c, null, "T11c FAIL: 文件名不匹配应返回 null");

    // T11d: 无 export_voucher_list → null
    const timeline11d = [makeToolResult("other_tool", "{}")];
    const chips11d = extractVoucherChips(timeline11d, "金蝶对照手填清单.xlsx");
    assert.strictEqual(chips11d, null, "T11d FAIL: 无目标工具时应返回 null");

    // T11e: content 非合法 JSON → null(不崩溃)
    const timeline11e = [makeToolResult("export_voucher_list", "not json")];
    const chips11e = extractVoucherChips(timeline11e, "金蝶对照手填清单.xlsx");
    assert.strictEqual(chips11e, null, "T11e FAIL: 非法 JSON 应静默返回 null");

    // T11f: content JSON 缺少 fileName 字段 → null
    const noFileName = JSON.stringify({ sheets: ["A"], voucherCount: 1 });
    const timeline11f = [makeToolResult("export_voucher_list", noFileName)];
    const chips11f = extractVoucherChips(timeline11f, "金蝶对照手填清单.xlsx");
    assert.strictEqual(chips11f, null, "T11f FAIL: 缺 fileName 字段应返回 null");

    console.log("chat-process-polish T11: extractVoucherChips 纯函数 ✓");
  }

  // ─── 源码契约断言 ─────────────────────────────────────────────────────────

  // ── 第 8 项：工具条 focus-within + @media (hover: none) ──────────────────
  {
    const chatSrc = [
      "app/chat/chat-page.tsx",
      "app/chat/components/assistant-turn.tsx",
      "app/chat/components/user-bubble.tsx",
      "app/chat/components/file-tray.tsx",
      "app/chat/components/mention-popup.tsx",
    ].map(src).join("\n"); // WP9a 拆解后哨兵读取范围扩为文件集(断言语义不变)
    const globalsCss = src("app/globals.css");

    // 8-C1: 工具条应有 focus-within 相关处理
    assert.ok(
      chatSrc.includes("focus-within") || chatSrc.includes("focus-visible"),
      "C8-1 FAIL: chat-page.tsx 工具条应有 focus-within/focus-visible 可见性控制"
    );

    // 8-C2: 存在 transition-opacity(淡入动画)
    assert.ok(
      chatSrc.includes("transition-opacity"),
      "C8-2 FAIL: chat-page.tsx 工具条应有 transition-opacity"
    );

    // 8-C3: messageTimestamp 被使用
    assert.ok(
      chatSrc.includes("messageTimestamp"),
      "C8-3 FAIL: chat-page.tsx 应使用 messageTimestamp"
    );

    // 8-C4: globals.css 有 @media (hover: none) 规则
    assert.ok(
      globalsCss.includes("hover: none"),
      "C8-4 FAIL: globals.css 应有 @media (hover: none) 规则确保触屏可见"
    );

    console.log("chat-process-polish C8: 工具条 hover/focus 源码契约 ✓");
  }

  // ── 第 9 项：ask-user-card 答案摘要 ──────────────────────────────────────
  {
    const askCardSrc = src("app/components/ask-user-card.tsx");

    // 9-C1: 多问确认块折叠头与工具组同款——group-hover 显隐的 chevron(无前导图标)
    assert.ok(
      askCardSrc.includes("group-hover:opacity-100") && askCardSrc.includes("details-chevron"),
      "C9-1 FAIL: ask-user-card.tsx 多问确认块折叠头应与工具组同款(chevron 默认隐藏 hover 显现)"
    );

    // 9-C2: 标题为「用户已确认 N 个问题」,展开框内逐条 问:/答:
    assert.ok(
      askCardSrc.includes("用户已确认") && askCardSrc.includes("问：") && askCardSrc.includes("答："),
      "C9-2 FAIL: ask-user-card.tsx 多问确认块应为「用户已确认 N 个问题」+ 问:/答: 逐条"
    );

    console.log("chat-process-polish C9: ask-user-card 答案摘要源码契约 ✓");
  }

  // ── 第 10 项：文件卡层级（getFileTypeLabel 被使用）────────────────────────
  {
    const fileBrowserSrc = src("app/chat/chat-file-browser.tsx");

    // 10-C1: 导出或使用 getFileTypeLabel 函数
    assert.ok(
      fileBrowserSrc.includes("getFileTypeLabel"),
      "C10-1 FAIL: chat-file-browser.tsx 应使用 getFileTypeLabel 函数"
    );

    // 10-C2: 类型行在 OpenableFileRow 中渲染(text-caption 灰字层)
    assert.ok(
      fileBrowserSrc.includes("text-caption") && fileBrowserSrc.includes("getFileTypeLabel"),
      "C10-2 FAIL: chat-file-browser.tsx 应用 text-caption 灰字渲染 getFileTypeLabel"
    );

    console.log("chat-process-polish C10: 文件卡层级源码契约 ✓");
  }

  // ── 第 11 项：extractVoucherChips 被引用 ──────────────────────────────────
  {
    const chatSrc = [
      "app/chat/chat-page.tsx",
      "app/chat/components/assistant-turn.tsx",
      "app/chat/components/user-bubble.tsx",
      "app/chat/components/file-tray.tsx",
      "app/chat/components/mention-popup.tsx",
    ].map(src).join("\n"); // WP9a 拆解后哨兵读取范围扩为文件集(断言语义不变)

    // 11-C1: extractVoucherChips 被调用
    assert.ok(
      chatSrc.includes("extractVoucherChips"),
      "C11-1 FAIL: chat-page.tsx 应调用 extractVoucherChips"
    );

    // 11-C2: chips 渲染文案包含凭证关键字
    assert.ok(
      chatSrc.includes("voucherCount") || chatSrc.includes("笔凭证"),
      "C11-2 FAIL: chat-page.tsx 应渲染 voucherCount/笔凭证 chips"
    );

    console.log("chat-process-polish C11: export_voucher_list chips 源码契约 ✓");
  }

  // ── 第 14 项：.md-content 段间距与列表项间距一致化 ────────────────────────
  {
    const globalsCss = src("app/globals.css");

    // 14-C1: md-content p margin 存在
    assert.ok(
      /\.md-content\s+p\s*\{[^}]*margin/.test(globalsCss),
      "C14-1 FAIL: globals.css 应为 .md-content p 设置 margin"
    );

    // 14-C2: md-content li margin 存在
    assert.ok(
      /\.md-content\s+li\s*\{[^}]*margin/.test(globalsCss),
      "C14-2 FAIL: globals.css 应为 .md-content li 设置 margin"
    );

    // 14-C3: 段间距与列表项间距值一致化(垂直 margin 相同)
    const pMarginMatch = globalsCss.match(/\.md-content\s+p\s*\{\s*margin:\s*([^;]+)/);
    const liMarginMatch = globalsCss.match(/\.md-content\s+li\s*\{\s*margin:\s*([^;]+)/);
    if (pMarginMatch && liMarginMatch) {
      const pVert = pMarginMatch[1].trim().split(/\s+/)[0];
      const liVert = liMarginMatch[1].trim().split(/\s+/)[0];
      assert.strictEqual(
        pVert,
        liVert,
        `C14-3 FAIL: p margin(${pVert}) 应与 li margin(${liVert}) 垂直值一致`
      );
    }

    console.log("chat-process-polish C14: .md-content 段落间距源码契约 ✓");
  }

  console.log("chat-process-polish: 全部断言通过 ✓");
})();
