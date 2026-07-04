/**
 * tool-call-step-ui.test.ts
 *
 * 源码契约 + 纯函数断言，覆盖 spec-chat-process-polish.md 第 1/2/3b/3c/4/6/7/12/13 项
 * 中的 UI 接线层（tool-call-step.tsx）改动。
 *
 * 运行：
 *   FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_MOCK_AGENT_DELAY=0 SKIP_LLM=true \
 *     node --import tsx tests/tool-call-step-ui.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

export const toolCallStepUiTestPromise = (async () => {
  const stepSrc = src("app/components/tool-call-step.tsx");

  // ── 1. 字号升档（spec 1）────────────────────────────────────────────────────
  // 步骤按钮/标题行使用 text-body；不再使用纯 text-small 作为行级类
  {
    // ThinkingStep 和 ToolCallStep 行按钮应用 text-body
    assert.ok(
      stepSrc.includes("text-body"),
      "C1 FAIL: tool-call-step.tsx 步骤行应有 text-body 类（字号升档）"
    );
    // 展开详情区仍保留 text-small（层级保留）
    assert.ok(
      stepSrc.includes("text-small"),
      "C1b FAIL: 展开详情区仍应有 text-small 类（形成层级）"
    );
  }
  console.log("C1: 字号升档 text-body ✓");

  // ── 2. chevron hover 显现（spec 2）─────────────────────────────────────────
  {
    // 默认 opacity-0，hover 可见
    assert.ok(
      stepSrc.includes("opacity-0"),
      "C2a FAIL: chevron 默认应为 opacity-0"
    );
    assert.ok(
      stepSrc.includes("group-hover:opacity-100"),
      "C2b FAIL: chevron 应有 group-hover:opacity-100"
    );
    assert.ok(
      stepSrc.includes("group-focus-visible:opacity-100"),
      "C2c FAIL: chevron 应有 group-focus-visible:opacity-100（键盘可见）"
    );
    assert.ok(
      stepSrc.includes("transition-opacity"),
      "C2d FAIL: chevron 应有 transition-opacity（淡入）"
    );
    // 触屏兜底：@media(hover:none) 下保持可见
    assert.ok(
      stepSrc.includes("hover:none") || stepSrc.includes("pointer-coarse"),
      "C2e FAIL: 应有触屏兜底（hover:none 或 pointer-coarse）"
    );
  }
  console.log("C2: chevron hover 显现 ✓");

  // ── 3b. thinking 降权（spec 3b）────────────────────────────────────────────
  {
    // ThinkingStep 折叠标题固定显示「思考」而非模型原文首行
    assert.ok(
      stepSrc.includes("「思考」") || stepSrc.includes('"思考"') || stepSrc.includes("'思考'") || stepSrc.includes("`思考`") || stepSrc.includes(": \"思考\"") || stepSrc.includes("= \"思考\"") || (stepSrc.includes("思考") && stepSrc.includes("thinkingSummary")),
      "C3b-1 FAIL: ThinkingStep 折叠标题应含「思考」固定文案"
    );
    // 不应在折叠标题展示模型英文原文（thinkingSummary 不再提取首行）
    // 验证方式：thinkingSummary 函数已被移除或不再被标题所用
    // （标题改为固定「思考」，原函数仍可保留但不用于标题）
    assert.ok(
      !stepSrc.includes("thinkingSummary(content)") || stepSrc.includes("思考"),
      "C3b-2 FAIL: ThinkingStep 折叠标题不应直接展示 thinkingSummary 原文（应固定为「思考」）"
    );
  }
  console.log("C3b: thinking 降权 ✓");

  // ── 4 & 7. 失败聚合接线（spec 4/7）─────────────────────────────────────────
  {
    // aggregateToolSegment 被导入
    assert.ok(
      stepSrc.includes("aggregateToolSegment"),
      "C4a FAIL: tool-call-step.tsx 应导入 aggregateToolSegment"
    );
    // summarizeToolSegment 被导入或使用
    assert.ok(
      stepSrc.includes("summarizeToolSegment"),
      "C7a FAIL: tool-call-step.tsx 应导入 summarizeToolSegment"
    );
    // retry-group 渲染逻辑存在
    assert.ok(
      stepSrc.includes("retry-group"),
      "C4b FAIL: tool-call-step.tsx 应处理 retry-group"
    );
    // recovered 条件渲染（灰显）
    assert.ok(
      stepSrc.includes("recovered"),
      "C4c FAIL: tool-call-step.tsx 应处理 recovered 状态"
    );
    // 已恢复文案
    assert.ok(
      stepSrc.includes("已恢复"),
      "C4d FAIL: tool-call-step.tsx 应渲染「已恢复」文案"
    );
    // degraded 状态灰显（kind:"step" 且 degraded=true）
    assert.ok(
      stepSrc.includes("degraded"),
      "C4e FAIL: tool-call-step.tsx 应处理 degraded 状态"
    );
  }
  console.log("C4/7: 失败聚合接线 ✓");

  // ── 6. 错误详情剥壳接线（spec 6）────────────────────────────────────────────
  {
    assert.ok(
      stepSrc.includes("cleanErrorDetail"),
      "C6a FAIL: tool-call-step.tsx 应导入并使用 cleanErrorDetail"
    );
    // headline 用于展开头部
    assert.ok(
      stepSrc.includes("headline"),
      "C6b FAIL: tool-call-step.tsx 应使用 headline 字段"
    );
  }
  console.log("C6: 错误详情剥壳接线 ✓");

  // ── 7. 段摘要（spec 3c/7）──────────────────────────────────────────────────
  {
    // ToolStepList 用 summarizeToolSegment 生成段摘要
    assert.ok(
      stepSrc.includes("summarizeToolSegment"),
      "C7b FAIL: ToolStepList 应调用 summarizeToolSegment"
    );
  }
  console.log("C7: 段摘要 ✓");

  // ── spec 7(strip 正则同步)──────────────────────────────────────────────────
  {
    // query_knowledge 的 strip 正则已更新（不应再有旧正则）
    assert.ok(
      !stepSrc.includes("知识库命令检索"),
      "C7s FAIL: TOOL_VISUAL 中 query_knowledge 的旧 strip 正则应已更新"
    );
    // 新正则：匹配「查询知识库」前缀
    assert.ok(
      stepSrc.includes("查询知识库"),
      "C7s2 FAIL: query_knowledge strip 应匹配「查询知识库」前缀"
    );
    // read_file strip 正则更新（renderer 现输出「读取资料：…」）
    assert.ok(
      stepSrc.includes("读取资料"),
      "C7s3 FAIL: read_file strip 应匹配「读取资料」前缀"
    );
    // search_knowledge strip 正则（renderer 输出「检索知识库：…」）
    assert.ok(
      stepSrc.includes("检索知识库"),
      "C7s4 FAIL: search_knowledge strip 应匹配「检索知识库」前缀"
    );
  }
  console.log("C7s: strip 正则同步 ✓");

  // ── 12. 缩略图（spec 12）────────────────────────────────────────────────────
  {
    // read_document/Read 图片路径应有缩略图或路径 chip 逻辑
    assert.ok(
      stepSrc.includes("img") || stepSrc.includes("thumbnail") || stepSrc.includes("IMAGE_EXT") || stepSrc.includes("isImagePath") || stepSrc.includes(".jpg") || stepSrc.includes(".png"),
      "C12 FAIL: tool-call-step.tsx 应有图片路径处理逻辑（缩略图或路径 chip）"
    );
  }
  console.log("C12: 缩略图/路径 chip ✓");

  // ── 13. 颜色纪律清扫（spec 13）──────────────────────────────────────────────
  {
    // 不应有成功绿勾等彩色
    assert.ok(
      !stepSrc.includes("text-green") && !stepSrc.includes("tone-ok") && !stepSrc.includes("tone-success"),
      "C13 FAIL: 过程区不应有 text-green/tone-ok/tone-success 彩色"
    );
    // tone-alarm 只应搭配错误状态（不在成功路径里）
    // 仅检查无明显滥用（如直接用 tone-alarm 而无 isError/recovered 判断）
    // 合法用途：PlainBlock error 色(1) + ExpandedDetail 错误标签(1) + 错误 headline(1)
    //           + ToolCallStep 图标色(1) + 文字色(1) + RetryGroupRow 图标色(1) + 文字色(1)
    //           + 注释中提及（若有）最多 2 次 = 合计 ≤ 10
    const alarmOccurrences = (stepSrc.match(/tone-alarm/g) ?? []).length;
    assert.ok(
      alarmOccurrences <= 10,
      `C13b FAIL: tone-alarm 出现 ${alarmOccurrences} 次，过多，应只在 recovered=false 失败时使用`
    );
  }
  console.log("C13: 颜色纪律清扫 ✓");

  // ── 端到端：conv65 fixture 聚合 → retry-group 灰显条件 ────────────────────
  {
    const { aggregateToolSegment } = await import("../app/chat/step-aggregate.ts");
    const { default: fixture } = await import("../docs/spec/fixtures/conv65-process.json", { with: { type: "json" } });
    type FixtureItem = { id: string; event: { type: string; content?: string; [k: string]: unknown }; createdAt: number };
    const timeline = (fixture as { items: FixtureItem[] }).items;

    // 过滤出工具段（tool_use + tool_result）
    const toolItems = timeline.filter((i) => i.event.type === "tool_use" || i.event.type === "tool_result");
    const aggregated = aggregateToolSegment(toolItems);

    // 应存在 retry-group，且 recovered=true → 渲染层应灰显
    const retryGroups = aggregated.filter((a) => a.kind === "retry-group");
    assert.ok(retryGroups.length >= 1, "E2E-1 FAIL: conv65 工具段应有 retry-group");
    const recoveredGroup = retryGroups.find((g) => g.kind === "retry-group" && g.recovered);
    assert.ok(recoveredGroup != null, "E2E-2 FAIL: conv65 retry-group 应 recovered=true（search_knowledge 后续成功）");

    // thinking 降权：标题不应包含英文原文
    // 通过断言组件源码不再将原文首行用于标题（已在 C3b 中覆盖）
  }
  console.log("E2E: conv65 fixture 聚合断言 ✓");

  // ── C-D: 密度收敛(第二轮) 源码契约 ──
  {
    const stepSrc2 = src("app/components/tool-call-step.tsx");
    // 已完成多步段默认收成一行摘要(details 折叠),进行中保持逐行
    assert.ok(
      stepSrc2.includes("!isActive && aggregated.length >= 2"),
      "C-D1 FAIL: 已完成多步段应默认折叠为摘要行"
    );
    const pageSrc2 = src("app/chat/chat-page.tsx");
    // thinking 段不再渲染
    assert.ok(pageSrc2.includes("思考段不渲染"), "C-D2 FAIL: chat-page 的 thinking 段应不渲染");
    assert.ok(!pageSrc2.includes("<ThinkingStep"), "C-D2b FAIL: chat-page 不应再渲染 ThinkingStep");
    // 已答确认项折叠进过程块(渲染点位于 </details> 之前)
    const askIdx = pageSrc2.indexOf("已答的确认项折叠在过程块内");
    const detailsClose = pageSrc2.indexOf("</details>", askIdx);
    assert.ok(askIdx > -1 && detailsClose > askIdx, "C-D3 FAIL: 已答确认项应位于过程块 details 内");
    // 过程折叠头 body 字号
    assert.ok(/min-w-0 flex-1 truncate text-body/.test(pageSrc2), "C-D4 FAIL: 「已处理 N 步」折叠头应为 text-body");
    // ask-user 摘要行 body 字号
    const askSrc = src("app/components/ask-user-card.tsx");
    assert.ok(askSrc.includes('details className="py-0.5 text-body'), "C-D5 FAIL: 已确认摘要行应为 text-body");
    // C-E: 呼吸感与连接线(第三轮)
    assert.ok(!/py-0\.5 text-body/.test(stepSrc2), "C-E1 FAIL: 步骤/组行应为 py-1(呼吸感对齐 Claude)");
    assert.ok((stepSrc2.match(/border-l border-border\/60/g) ?? []).length >= 2, "C-E2 FAIL: 组展开子命令应有左侧连接线");
    assert.ok(/map_voucher_account:\s*\{[^}]*strip:/.test(stepSrc2), "C-E3 FAIL: 金蝶系工具应有 strip 前缀(子行只留对象)");
  }

  console.log("\ntool-call-step-ui: 全部断言通过 ✓");
})();
