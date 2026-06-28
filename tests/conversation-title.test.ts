import assert from "node:assert/strict";
import { sanitizeTitle } from "../lib/agent/conversation-title";

// 纯函数 sanitizeTitle 的单元测试;不调用网络/LLM。
export const conversationTitleTestPromise = (async () => {
  const { equal, strictEqual } = assert;

  // T1: 普通中文标题直接返回
  equal(sanitizeTitle("资产负债分析"), "资产负债分析", "T1 FAIL: 普通中文标题应原样保留");

  // T2: 超过 12 字截断
  const long = "这是一个超过十二个汉字的标题内容用来测试截断";
  const r2 = sanitizeTitle(long);
  assert.ok(r2 !== null && [...r2].length <= 12, "T2 FAIL: 超长标题应截断到 ≤12 码点");

  // T3: markdown 标题标记去除
  equal(sanitizeTitle("## 应收账款分析"), "应收账款分析", "T3 FAIL: ## 应被剥掉");

  // T4: 加粗/斜体符号去除
  equal(sanitizeTitle("**薪税计算报告**"), "薪税计算报告", "T4 FAIL: ** 应被剥掉");

  // T5: 行内代码反引号去除
  equal(sanitizeTitle("`毛利率` 分析"), "毛利率 分析", "T5 FAIL: 反引号应被剥掉");

  // T6: 中文引号去除
  equal(sanitizeTitle("「经营分析」"), "经营分析", "T6 FAIL: 「」应被剥掉");

  // T7: 英文引号去除
  equal(sanitizeTitle('"报销校验"'), "报销校验", 'T7 FAIL: "" 应被剥掉');

  // T8: 首尾标点去除
  equal(sanitizeTitle("。报表生成。"), "报表生成", "T8 FAIL: 首尾句号应被剥掉");

  // T9: 空串返回 null
  strictEqual(sanitizeTitle(""), null, "T9 FAIL: 空串应返回 null");

  // T10: 只有空白和标点 → null
  strictEqual(sanitizeTitle("   ** ## ` "), null, "T10 FAIL: 纯标点空白应返回 null");

  // T11: 多余空白折叠
  const r11 = sanitizeTitle("报销  校验   报告");
  assert.ok(r11 !== null && !r11.includes("  "), "T11 FAIL: 多空白应折叠");

  // T12: 精确 12 字不截断
  const exactly12 = "一二三四五六七八九十十一十二";
  // exactly12 = 7 汉字 + ... wait, let's just use 12 single chars
  const s12 = "一二三四五六七八九十甲乙";
  equal(sanitizeTitle(s12), s12, "T12 FAIL: 恰好 12 字应完整保留");

  // T13: 13 字应截断到 12
  const s13 = "一二三四五六七八九十甲乙丙";
  const r13 = sanitizeTitle(s13);
  assert.ok(r13 !== null && [...r13].length === 12, "T13 FAIL: 13 字应截断到 12");

  console.log("conversation-title tests passed");
})();
