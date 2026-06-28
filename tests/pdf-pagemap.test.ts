import assert from "node:assert/strict";
import { buildPdfPageMap } from "../lib/knowledge/parsers/index.ts";

// 黄金用例:证明 PDF 镜像"逐行→页码"映射与镜像文本严格对齐、页码准确。
// 镜像形如 worker extract_pdf 的输出:每页前 `--- Page N ---`,页间空行。
export const pdfPagemapTestPromise = (async () => {
  // 还原 extract_pdf 的输出形态:"\n\n".join(["--- Page 1 ---\n正文…", "--- Page 2 ---\n正文…"])
  const mirror = [
    "--- Page 1 ---",
    "第一页 合同总则",
    "甲方乙方约定",
    "",
    "--- Page 2 ---",
    "第二页 付款条款",
    "QZX命中关键词在此",
    "",
    "--- Page 3 ---",
    "第三页 违约责任",
  ].join("\n");

  const meta = buildPdfPageMap(mirror);
  const lines = mirror.split("\n");

  // AC1:对齐——行数 === meta 长度
  assert.equal(lines.length, meta.length, "AC1 FAIL: 行数应与 meta 长度一致");

  // AC2:`--- Page N ---` 标记行与空行为 null
  assert.equal(meta[lines.indexOf("--- Page 1 ---")], null, "AC2 FAIL: 页标记行应为 null");
  assert.equal(meta[lines.indexOf("")], null, "AC2 FAIL: 空行应为 null");

  // AC3:正文行映射到正确页码
  assert.deepEqual(meta[lines.indexOf("甲方乙方约定")], { page: 1 }, "AC3 FAIL: 应为第1页");
  assert.deepEqual(meta[lines.indexOf("QZX命中关键词在此")], { page: 2 }, "AC3 FAIL: 命中行应为第2页");
  assert.deepEqual(meta[lines.indexOf("第三页 违约责任")], { page: 3 }, "AC3 FAIL: 应为第3页");

  console.log("✓ pdf-pagemap: 镜像↔页码映射对齐且准确");
})();
