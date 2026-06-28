import assert from "node:assert/strict";
import { findMatches } from "../app/chat/find-matches.ts";

export const findMatchesTestPromise = (async () => {
  // 空词 → []
  assert.deepEqual(findMatches("hello world", ""), [], "空 needle 应返回 []");
  assert.deepEqual(findMatches("hello world", "   "), [], "空白 needle 应返回 []");

  // 单次命中,区间正确
  const single = findMatches("hello world", "world");
  assert.deepEqual(single, [[6, 11]], "单次命中区间应为 [6,11]");

  // 多次命中且不重叠
  const multi = findMatches("ababab", "ab");
  assert.deepEqual(multi, [[0, 2], [2, 4], [4, 6]], "多次命中且不重叠");

  // 大小写不敏感
  const ci = findMatches("Hello World", "hello");
  assert.deepEqual(ci, [[0, 5]], "大小写不敏感匹配");

  // 中文命中
  const zh = findMatches("财务报表分析", "报表");
  assert.deepEqual(zh, [[2, 4]], "中文命中区间正确");

  console.log("✓ find-matches tests passed");
})();
