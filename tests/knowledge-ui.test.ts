import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const knowledgeUiTestPromise = (async () => {
  const page = await readFile("app/knowledge/page.tsx", "utf-8");

  // ── T1: 正则全链路移除 ──────────────────────────────────────────────
  assert.ok(!page.includes("正则"), "T1 FAIL: 知识库页不应再有正则选项");
  assert.ok(!page.includes("regex"), "T1 FAIL: 页面不应再传 regex");
  assert.ok(!page.includes("Checkbox"), "T1 FAIL: 正则 checkbox 应移除");
  const searchApi = await readFile("app/api/knowledge/search/route.ts", "utf-8");
  assert.ok(!searchApi.includes("regex"), "T1 FAIL: 搜索 API 不应再接受 regex");
  const rgSearch = await readFile("lib/knowledge/rg-search.ts", "utf-8");
  assert.ok(!/regex/.test(rgSearch), "T1 FAIL: rg-search 不应再有 regex 参数");
  assert.ok(rgSearch.includes('"--fixed-strings"'), "T1 FAIL: 搜索应恒定按字面量匹配");

  // ── T2: 卡片网格 + 组件拆分 ─────────────────────────────────────────
  assert.ok(existsSync("app/knowledge/doc-card.tsx"), "T2 FAIL: 缺 doc-card 组件");
  assert.ok(existsSync("app/knowledge/search-results.tsx"), "T2 FAIL: 缺 search-results 组件");
  assert.ok(existsSync("app/knowledge/shared.ts"), "T2 FAIL: 缺 shared 模块");
  // DocCard 已被统一 ResourceCard 替代(spec-resource-parity),网格布局保留
  assert.ok((page.includes("DocCard") || page.includes("ResourceCard")) && page.includes("grid"), "T2 FAIL: 文档应以卡片网格展示");
  assert.ok(!page.includes("DocMimeIcon"), "T2 FAIL: 行式渲染辅助应已移除/下沉到组件");

  // ── T3: 搜索框在左面板内部(不在独立全宽行)─────────────────────────
  assert.ok(page.includes("回车检索") || page.includes("max-w-sm"), "T3 FAIL: 搜索框应收窄并入面板内部");

  // ── T4: 归档操作存在 ────────────────────────────────────────────────
  assert.ok(page.includes("toggleArchive") && page.includes("已归档"), "T4 FAIL: 应有归档/已归档视图");
  const docCard = await readFile("app/knowledge/doc-card.tsx", "utf-8");
  assert.ok(docCard.includes("onToggleArchive") && docCard.includes("长期未使用"), "T4 FAIL: 卡片应有归档与长期未使用提示");

  // ── T5: 检索阶梯写入 system prompt,grep_docs 退场 ─────────────────────
  // 提示词正文现为单一来源 SYSTEM_PROMPT.md(系统提示常量已去除,见 spec-* / loadStaticTemplate)。
  const prompt = await readFile("lib/agent/SYSTEM_PROMPT.md", "utf-8");
  assert.ok(!prompt.includes("grep_docs"), "T5 FAIL: system prompt 不应再提 grep_docs");
  assert.ok(prompt.includes("query_knowledge") && prompt.includes("检索阶梯"), "T5 FAIL: system prompt 应说明检索阶梯");

  console.log("knowledge-ui: all 5 checks passed ✓");
})();
