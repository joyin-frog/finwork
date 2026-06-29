import assert from "node:assert/strict";
import { remarkFinanceFileLinks, type FileRef } from "../lib/remark/finance-file-links.ts";

// 手搓最小 mdast 节点;transformer 直接原地 mutate tree。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
const root = (...children: Node[]): Node => ({ type: "root", children });
const para = (...children: Node[]): Node => ({ type: "paragraph", children });
const text = (value: string): Node => ({ type: "text", value });

const run = (files: FileRef[], tree: Node) => {
  remarkFinanceFileLinks(files)(tree);
  return tree;
};

export const financeFileLinksTestPromise = (async () => {
  // ── 1. 无可链接文件 → no-op,树不变 ──────────────────────────────────
  {
    const tree = root(para(text("见 报表.xlsx")));
    run([], tree);
    assert.equal(tree.children[0].children[0].type, "text", "无文件时不应改写");
    assert.equal(tree.children[0].children[0].value, "见 报表.xlsx");
  }

  // ── 2. 缺 name / storagePath 的条目被过滤(等价无可链接) ──────────────
  {
    const tree = root(para(text("见 报表.xlsx")));
    run([{ name: "", storagePath: "/x" }, { name: "报表.xlsx", storagePath: "" }], tree);
    assert.equal(tree.children[0].children.length, 1, "无效条目应被过滤,不产生链接");
    assert.equal(tree.children[0].children[0].type, "text");
  }

  // ── 3. 文本中的文件名 → 拆成 text + link ─────────────────────────────
  {
    const tree = root(para(text("见 报表.xlsx 内容")));
    run([{ name: "报表.xlsx", storagePath: "/data/报表.xlsx" }], tree);
    const kids = tree.children[0].children;
    assert.equal(kids.length, 3, "应拆为 [前缀 text, link, 后缀 text]");
    assert.equal(kids[0].value, "见 ");
    assert.equal(kids[1].type, "link", "中间应为 link 节点");
    assert.equal(kids[1].url, `finance-file://${encodeURIComponent("/data/报表.xlsx")}`, "url 应用 encodeURIComponent 编码 storagePath");
    assert.equal(kids[1].children[0].value, "报表.xlsx", "链接锚文本应为文件名");
    assert.equal(kids[2].value, " 内容");
  }

  // ── 4. 已有 link 节点内部跳过,不二次包裹 ─────────────────────────────
  {
    const existing = { type: "link", url: "http://x", title: null, children: [text("报表.xlsx")] };
    const tree = root(para(existing));
    run([{ name: "报表.xlsx", storagePath: "/data/报表.xlsx" }], tree);
    const link = tree.children[0].children[0];
    assert.equal(link.url, "http://x", "已有 link 的 url 不应被改写");
    assert.equal(link.children.length, 1, "link 内文本不应被再次拆分");
    assert.equal(link.children[0].value, "报表.xlsx");
  }

  // ── 5. inlineCode 内的文件名不被链接(代码区保持原样) ────────────────
  {
    const tree = root(para({ type: "inlineCode", value: "报表.xlsx" }));
    run([{ name: "报表.xlsx", storagePath: "/data/报表.xlsx" }], tree);
    const node = tree.children[0].children[0];
    assert.equal(node.type, "inlineCode", "inlineCode 节点类型应保留");
    assert.equal(node.value, "报表.xlsx", "代码内文件名不应被改写为链接");
  }

  // ── 6. 重名前缀:最长匹配优先 ────────────────────────────────────────
  {
    const tree = root(para(text("看 报表.xlsx 吧")));
    run([
      { name: "报表", storagePath: "/short" },
      { name: "报表.xlsx", storagePath: "/long" },
    ], tree);
    const links = tree.children[0].children.filter((n: Node) => n.type === "link");
    assert.equal(links.length, 1, "重叠名应只产生一个链接(最长优先)");
    assert.equal(links[0].url, `finance-file://${encodeURIComponent("/long")}`, "应匹配更长的文件名");
    assert.equal(links[0].children[0].value, "报表.xlsx");
  }

  // ── 7. 同一文本多次出现 → 多个链接 ───────────────────────────────────
  {
    const tree = root(para(text("A.pdf and A.pdf")));
    run([{ name: "A.pdf", storagePath: "/a.pdf" }], tree);
    const links = tree.children[0].children.filter((n: Node) => n.type === "link");
    assert.equal(links.length, 2, "出现两次应生成两个链接");
  }

  console.log("finance-file-links: all 7 checks passed ✓");
})();
