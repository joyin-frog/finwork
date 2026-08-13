import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const knowledgeUiTestPromise = (async () => {
  const page = await readFile("app/knowledge/page.tsx", "utf-8");

  // ── T1: 生产检索只走 Retrieval v2，不再落回 rg/regex ───────────────
  assert.ok(!page.includes("正则"), "T1 FAIL: 知识库页不应再有正则选项");
  assert.ok(!page.includes("regex"), "T1 FAIL: 页面不应再传 regex");
  assert.ok(!page.includes("Checkbox"), "T1 FAIL: 正则 checkbox 应移除");
  const searchApi = await readFile("app/api/knowledge/search/route.ts", "utf-8");
  assert.ok(!searchApi.includes("regex"), "T1 FAIL: 搜索 API 不应再接受 regex");
  assert.ok(
    searchApi.includes("getProductionRetrievalService") &&
      !searchApi.includes("rg-search") &&
      !searchApi.includes("query-sandbox"),
    "T1 FAIL: 搜索 API 必须直接使用 Retrieval v2，不能静默回落到旧检索",
  );

  // ── T2: 卡片网格 + 组件拆分 ─────────────────────────────────────────
  assert.ok(existsSync("app/knowledge/doc-card.tsx"), "T2 FAIL: 缺 doc-card 组件");
  assert.ok(existsSync("app/knowledge/search-results.tsx"), "T2 FAIL: 缺 search-results 组件");
  assert.ok(existsSync("app/knowledge/shared.ts"), "T2 FAIL: 缺 shared 模块");
  // DocCard 已被统一 ResourceCard 替代(spec-resource-parity),网格布局保留
  assert.ok((page.includes("DocCard") || page.includes("ResourceCard")) && page.includes("grid"), "T2 FAIL: 文档应以卡片网格展示");
  assert.ok(!page.includes("DocMimeIcon"), "T2 FAIL: 行式渲染辅助应已移除/下沉到组件");

  // ── T3: 标题说明下方的固定搜索栏 ───────────────────────────────────
  assert.ok(
    page.includes("PageSearchBar") &&
      page.includes("alwaysVisible") &&
      page.includes('placeholder="搜索知识库…"') &&
      page.includes("固定在滚动区上方"),
    "T3 FAIL: 知识库应在正文标题和说明下方展示固定搜索栏",
  );

  // ── T4: 归档操作存在 ────────────────────────────────────────────────
  assert.ok(page.includes("toggleArchive") && page.includes("已归档"), "T4 FAIL: 应有归档/已归档视图");
  const docCard = await readFile("app/knowledge/doc-card.tsx", "utf-8");
  assert.ok(docCard.includes("onToggleArchive") && docCard.includes("长期未使用"), "T4 FAIL: 卡片应有归档与长期未使用提示");

  // ── T5: Retrieval v2 的权限、引用与禁止旁路契约下沉工具定义 ─────────
  const prompt = await readFile("lib/agent/SYSTEM_PROMPT.md", "utf-8");
  assert.ok(!prompt.includes("grep_docs"), "T5 FAIL: system prompt 不应再提 grep_docs");
  assert.ok(!prompt.includes("检索阶梯"), "T5 FAIL: system prompt 不应重复工具选择细节");
  const knowledgeTools = await readFile("lib/agent/mcp-tools/knowledge.ts", "utf-8");
  assert.ok(
    knowledgeTools.includes("受 ACL 约束的混合检索") &&
      knowledgeTools.includes("不可变来源版本") &&
      knowledgeTools.includes("不执行 shell 命令") &&
      knowledgeTools.includes("不允许绕过检索权限直接扫描文本镜像"),
    "T5 FAIL: 检索工具必须声明 ACL、不可变引用与禁止 shell/文本镜像旁路",
  );

  console.log("knowledge-ui: all 5 checks passed ✓");
})();
