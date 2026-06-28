/**
 * Tests for parseFileLinkHref — covers sandbox:, file:, finance-file://, and plain https://.
 * Run: node --import tsx tests/sandbox-file-link.test.ts
 */

import assert from "node:assert/strict";
import { parseFileLinkHref } from "../app/chat/chat-preview-selection";

export const sandboxFileLinkTestPromise = (async () => {
  // ① sandbox: absolute path with percent-encoded Chinese filename
  {
    const href =
      "sandbox:/Users/user/Library/Application%20Support/finance-agent/files/38/generate/%E4%B8%8A%E6%B5%B7%E9%83%BD%E6%A3%AE%E9%87%8D%E6%96%B0%E7%94%9F%E6%88%902.pptx";
    const result = parseFileLinkHref(href);
    assert.ok(result !== null, "sandbox: link should parse");
    assert.equal(
      result.name,
      "上海都森重新生成2.pptx",
      "name should be decoded Chinese filename"
    );
    assert.equal(
      result.storagePath,
      "generate/上海都森重新生成2.pptx",
      "storagePath should be generate/<name>"
    );
  }

  // ② finance-file:// still parses correctly
  {
    const storagePath = "38/generate/report.xlsx";
    const href = `finance-file://${encodeURIComponent(storagePath)}`;
    const result = parseFileLinkHref(href);
    assert.ok(result !== null, "finance-file:// link should parse");
    assert.equal(result.storagePath, storagePath, "storagePath should be decoded");
    assert.equal(result.name, "report.xlsx", "name should be basename");
  }

  // ③ file: link containing /generate/
  {
    const href =
      "file:///Users/user/Library/Application%20Support/finance-agent/files/42/generate/budget%20report.xlsx";
    const result = parseFileLinkHref(href);
    assert.ok(result !== null, "file: link should parse");
    assert.equal(result.name, "budget report.xlsx", "name should be decoded");
    assert.equal(result.storagePath, "generate/budget report.xlsx");
  }

  // ④ ordinary https:// link → null
  {
    const href = "https://example.com/some/page";
    const result = parseFileLinkHref(href);
    assert.equal(result, null, "https:// link should return null");
  }

  // ⑤ sandbox: with non-generate path still parses (sandbox always treated as file)
  {
    const href = "sandbox:/tmp/uploads/test.pdf";
    const result = parseFileLinkHref(href);
    assert.ok(result !== null, "sandbox: link without /generate/ should still parse");
    assert.equal(result.name, "test.pdf");
    assert.equal(result.storagePath, "generate/test.pdf");
  }

  // ⑥ bare absolute path with /generate/ and no scheme → parsed
  {
    const href = "/Users/user/Library/finance-agent/files/10/generate/payroll.csv";
    const result = parseFileLinkHref(href);
    assert.ok(result !== null, "bare path with /generate/ should parse");
    assert.equal(result.name, "payroll.csv");
    assert.equal(result.storagePath, "generate/payroll.csv");
  }

  console.log("sandbox-file-link: all 6 checks passed ✓");
})();
