/**
 * Tests for normalizeModelFileLinks — regression for the macOS "Application Support" bug:
 * a model-written `[name(2)...](sandbox:/.../Application Support/.../generate/name(2)...)` link
 * has a SPACE in its destination, so CommonMark refuses it and renders `[text](url)` as literal
 * text (link gone, path + parens leaked). Normalizing to an encoded finance-file:// link fixes it.
 *
 * Run: node --import tsx tests/normalize-file-links.test.ts
 */

import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { normalizeModelFileLinks, parseFileLinkHref } from "../app/chat/chat-preview-selection";

// Parse markdown the way the chat page does (remark-gfm) and return the first paragraph's children.
function paraChildren(md: string) {
  const proc = unified().use(remarkParse).use(remarkGfm);
  const tree = proc.parse(md) as { children: { type: string; children?: { type: string; url?: string; value?: string }[] }[] };
  const para = tree.children.find((c) => c.type === "paragraph") ?? tree.children[0];
  return para.children ?? [];
}

export const normalizeFileLinksTestPromise = (async () => {
  const fn = "上海都森电子科技有限公司(2)_营业预测更新_重新生成2.pptx";

  // ① The actual bug: sandbox path with a SPACE ("Application Support") + parens in filename.
  {
    const raw = `已重新生成,文件在这里：[${fn}](sandbox:/Users/user/Library/Application Support/finance-agent/files/38/generate/${fn})`;

    // Before the fix this string parses as plain text (no link). Prove that first.
    const before = paraChildren(raw);
    assert.ok(
      !before.some((n) => n.type === "link"),
      "precondition: a space-in-path link does NOT parse as a link in CommonMark"
    );

    const normalized = normalizeModelFileLinks(raw);
    const after = paraChildren(normalized);
    const links = after.filter((n) => n.type === "link");
    assert.equal(links.length, 1, "after normalize: exactly one link node");
    assert.ok(links[0].url?.startsWith("finance-file://"), "link rewritten to finance-file:// scheme");

    // No leaked literal "[" / "(" left in any text node.
    const leaked = after.filter((n) => n.type === "text").map((n) => n.value ?? "").join("");
    assert.ok(!leaked.includes("["), "no leaked '[' in text");
    assert.ok(!leaked.includes("sandbox:"), "no leaked 'sandbox:' in text");

    // And the rewritten link round-trips back to the right storagePath/name.
    const parsed = parseFileLinkHref(links[0].url!);
    assert.ok(parsed, "rewritten url is recognised by parseFileLinkHref");
    assert.equal(parsed!.storagePath, `generate/${fn}`, "storagePath = generate/<name>");
    assert.equal(parsed!.name, fn, "name = full filename incl. (2)");
  }

  // ② Clean sandbox link (no space) is also normalized to finance-file:// for consistency.
  {
    const raw = `[report.xlsx](sandbox:/Users/x/generate/report.xlsx)`;
    const normalized = normalizeModelFileLinks(raw);
    assert.ok(normalized.includes("finance-file://"), "clean link normalized too");
    const parsed = parseFileLinkHref(paraChildren(normalized).find((n) => n.type === "link")!.url!);
    assert.equal(parsed!.storagePath, "generate/report.xlsx");
  }

  // ③ Ordinary http(s) links are left untouched.
  {
    const raw = `see [docs](https://example.com/a (b))`;
    assert.equal(normalizeModelFileLinks(raw), raw, "non-file link untouched");
  }

  // ④ Bare filename (no markdown link) is left untouched — the remark plugin links those.
  {
    const raw = `文件在这里：${fn}`;
    assert.equal(normalizeModelFileLinks(raw), raw, "bare filename untouched");
  }

  console.log("normalize-file-links: all 4 checks passed ✓");
})();
