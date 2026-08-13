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

  // query_knowledge → 查询知识库：<query 截 32 字>
  {
    const result = getToolSummary("query_knowledge", { query: "差旅报销制度的住宿上限" });
    assert.ok(result.startsWith("查询知识库："), "R5 FAIL: query_knowledge 应以「查询知识库：」开头");
    assert.ok(result.includes("差旅报销制度"), "R5 FAIL: query_knowledge 应含查询内容");
  }
  {
    const result = getToolSummary("query_knowledge", { query: "科目代码" });
    assert.equal(result, "查询知识库：科目代码", "R6 FAIL: query_knowledge 应展示自然语言查询");
  }
  {
    const longQuery = "手续费财务费用6603应付职工薪酬工资薪酬2211超长查询内容更多";
    const result = getToolSummary("query_knowledge", { query: longQuery });
    assert.ok(result.startsWith("查询知识库："), "R7 FAIL: query_knowledge 长查询应保留前缀");
    const body = result.slice("查询知识库：".length);
    assert.ok(body.length <= 32, `R7 FAIL: 查询应截到 32 字,实际: ${body.length} 字`);
  }
  assert.equal(
    getToolSummary("query_knowledge", {}),
    "查询知识库",
    "R8 FAIL: query_knowledge 无 query 时回落"
  );

  // read_file → 读取资料：<fileName>
  assert.equal(
    getToolSummary("read_file", { fileName: "科目余额表.xlsx" }),
    "读取资料：科目余额表.xlsx",
    "R9 FAIL: read_file 应输出「读取资料：<fileName>」"
  );
  assert.equal(
    getToolSummary("read_file", {}),
    "读取资料",
    "R10 FAIL: read_file 无 fileName 时回落"
  );
  assert.equal(
    getToolSummary("read_file", { fileName: "报销制度.pdf" }),
    "读取资料：报销制度.pdf",
    "R11 FAIL:  前缀下 read_file 应正常"
  );

  console.log("chat-process-renderers: all checks passed ✓");
})();
