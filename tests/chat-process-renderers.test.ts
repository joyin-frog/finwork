import assert from "node:assert/strict";
import { getToolSummary } from "../lib/agent/tools/renderers.ts";

export const chatProcessRenderersTestPromise = (async () => {
  // ── spec 第 5 项：检索类动词化 ──

  // search_knowledge → 检索知识库：<query 截 24 字>
  assert.equal(
    getToolSummary("search_knowledge", { query: "差旅标准" }),
    "检索知识库：差旅标准",
    "R1 FAIL: search_knowledge 短 query 应原样显示"
  );
  {
    const long = "手续费财务费用6603应付职工薪酬工资2211超长查询内容";
    const result = getToolSummary("search_knowledge", { query: long });
    assert.ok(result.startsWith("检索知识库："), "R2 FAIL: search_knowledge 应以「检索知识库：」开头");
    assert.ok(result.length <= "检索知识库：".length + 24, "R2 FAIL: search_knowledge query 应截到 24 字");
  }
  assert.equal(
    getToolSummary("search_knowledge", {}),
    "检索知识库",
    "R3 FAIL: search_knowledge 无 query 时回落"
  );
  //  前缀剥离后仍生效
  assert.equal(
    getToolSummary("search_knowledge", { query: "差旅标准" }),
    "检索知识库：差旅标准",
    "R4 FAIL:  前缀下 search_knowledge 应正常"
  );

  // 精读也走 search_knowledge(fileName)
  assert.equal(
    getToolSummary("search_knowledge", { fileName: "科目余额表.xlsx" }),
    "精读知识库：科目余额表.xlsx",
    "R5 FAIL: search_knowledge(fileName) 应呈现精读动作"
  );

  console.log("chat-process-renderers: all checks passed ✓");
})();
