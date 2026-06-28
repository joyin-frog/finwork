import assert from "node:assert/strict";
import { mergeTitleAndRank, type SearchFile } from "../lib/knowledge/rg-search.ts";

type DocMeta = { id: number; title: string; fileName: string; category: string };

// WP-D: 手动搜索与 agent 搜索对齐——补齐标题/文件名命中,分层排序。
export const knowledgeSearchTitleTestPromise = (async () => {
  const docMap = new Map<string, DocMeta>([
    ["h1", { id: 1, title: "差旅报销标准", fileName: "chailv.txt", category: "制度" }], // 标题命中
    ["h3", { id: 3, title: "采购流程", fileName: "caigou.txt", category: "制度" }], // 不命中标题,仅正文
    ["h4", { id: 4, title: "差旅与报销", fileName: "x.txt", category: "制度" }], // 标题 + 正文
    ["h5", { id: 5, title: "考勤制度", fileName: "kaoqin.txt", category: "制度" }], // 完全不命中
    ["h6", { id: 6, title: "出差明细", fileName: "差旅2026.txt", category: "台账" }] // 仅文件名命中
  ]);

  // 正文命中(来自 rg):h3 命中 5 次,h4 命中 2 次
  const fileMap = new Map<string, SearchFile>([
    ["h3", { docId: 3, title: "采购流程", fileName: "caigou.txt", category: "制度", hitCount: 5, matches: [] }],
    ["h4", { docId: 4, title: "差旅与报销", fileName: "x.txt", category: "制度", hitCount: 2, matches: [] }]
  ]);

  const { files, totalFiles } = mergeTitleAndRank(fileMap, docMap, "差旅", 10);
  const order = files.map((f) => f.docId);

  // 标题命中即使正文零命中也召回(h1),文件名命中也召回(h6);完全不命中(h5)不召回
  assert.ok(order.includes(1), "WP-D FAIL: 仅标题命中应被召回");
  assert.ok(order.includes(6), "WP-D FAIL: 仅文件名命中应被召回");
  assert.ok(!order.includes(5), "WP-D FAIL: 完全不命中不应召回");

  // 分层排序:标题命中优先(h4 标题+正文 → h1/h6 标题/文件名)→ 正文命中(h3)垫底
  assert.equal(order[order.length - 1], 3, "WP-D FAIL: 仅正文命中应排在所有标题命中之后");
  assert.equal(order[0], 4, "WP-D FAIL: 标题命中中正文命中数最多的应最前");
  for (const id of [4, 1, 6]) {
    assert.ok(order.indexOf(id) < order.indexOf(3), `WP-D FAIL: 标题命中 ${id} 应排在正文命中 3 之前`);
  }
  assert.equal(totalFiles, 4, "WP-D FAIL: 召回总数应为 4(h1/h3/h4/h6)");

  // titleHit 标记正确
  assert.equal(files.find((f) => f.docId === 1)!.titleHit, true);
  assert.notEqual(files.find((f) => f.docId === 3)!.titleHit, true, "WP-D FAIL: 仅正文命中不应标 titleHit");

  console.log("knowledge-search-title: all checks passed ✓");
})();
