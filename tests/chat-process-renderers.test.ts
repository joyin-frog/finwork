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

  // query_knowledge → 查询知识库：<command 截 32 字>（有 rg 模式优先显示模式）
  {
    const result = getToolSummary("query_knowledge", { command: "SELECT * FROM accounts" });
    assert.ok(result.startsWith("查询知识库："), "R5 FAIL: query_knowledge 应以「查询知识库：」开头");
    assert.ok(result.includes("SELECT * FROM accounts"), "R5 FAIL: query_knowledge 应含命令内容");
  }
  {
    const result = getToolSummary("query_knowledge", { command: "rg '科目代码' knowledge/" });
    assert.ok(result.startsWith("查询知识库："), "R6 FAIL: query_knowledge rg 模式应以「查询知识库：」开头");
    assert.ok(result.includes("(rg)"), "R6 FAIL: query_knowledge 有 rg 时应显示模式标记");
    assert.ok(result.includes("科目代码"), "R6 FAIL: query_knowledge rg 模式应含正则内容");
  }
  {
    const longCmd = "rg '手续费|财务费用|6603|应付职工薪酬|工资薪酬|2211超长模式内容更多' files/";
    const result = getToolSummary("query_knowledge", { command: longCmd });
    assert.ok(result.startsWith("查询知识库："), "R7 FAIL: query_knowledge 长 rg 应以「查询知识库：」开头");
    // rg 模式截到 32 字
    const body = result.slice("查询知识库：(rg) ".length);
    assert.ok(body.length <= 32, `R7 FAIL: rg 模式应截到 32 字,实际: ${body.length} 字`);
  }
  assert.equal(
    getToolSummary("query_knowledge", {}),
    "查询知识库",
    "R8 FAIL: query_knowledge 无 command 时回落"
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
