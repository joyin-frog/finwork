import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { executeKnowledgeQuery } from "../lib/knowledge/query-sandbox.ts";

// WP-A: 知识库沙箱去系统 coreutils,改 Node 实现 + 打包 rg;真实文件行为测试(跨平台)。
export const sandboxCommandsTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-sandbox-"));
  try {
    writeFileSync(path.join(dir, "a.txt"), "差旅标准\n住宿标准\n餐饮标准\n住宿标准\n", "utf-8");
    writeFileSync(path.join(dir, "b.txt"), "考勤制度\n", "utf-8");

    const run = async (cmd: string) => {
      const r = await executeKnowledgeQuery(cmd, dir);
      assert.ok(r.ok, `命令失败:${cmd} → ${r.ok ? "" : r.error}`);
      return r.ok ? r.output : "";
    };

    // ls(Node 实现)
    const ls = await run("ls");
    assert.ok(ls.includes("a.txt") && ls.includes("b.txt"), "WP-A FAIL: ls 应列出两个文件");

    // rg -l(打包二进制):仅 a.txt 含"标准"
    const rgl = await run("rg -l 标准");
    assert.ok(rgl.includes("a.txt") && !rgl.includes("b.txt"), "WP-A FAIL: rg -l 应只返回含关键词的文件");

    // rg -n | head(rg 二进制 + Node head)
    const rgHead = await run("rg -n 标准 a.txt | head -2");
    assert.equal(rgHead.trim().split("\n").length, 2, "WP-A FAIL: head -2 应限为 2 行");
    assert.ok(rgHead.includes("标准"));

    // cat | wc -l(Node)
    const wc = await run("cat a.txt | wc -l");
    assert.equal(wc.trim(), "4", "WP-A FAIL: wc -l 应为 4 行");

    // cat | sort | uniq(Node):住宿标准重复折叠 → 3 唯一行
    const uniq = await run("cat a.txt | sort | uniq");
    assert.equal(uniq.trim().split("\n").length, 3, "WP-A FAIL: sort|uniq 应得 3 唯一行");

    // head / tail(Node)
    assert.equal((await run("head -1 a.txt")).trim(), "差旅标准", "WP-A FAIL: head -1");
    assert.equal((await run("tail -1 a.txt")).trim(), "住宿标准", "WP-A FAIL: tail -1");

    // tr(Node)
    assert.ok((await run("cat b.txt | tr 考 X")).includes("X勤制度"), "WP-A FAIL: tr 替换");

    // find -name(Node)
    const find = await run("find -name '*.txt'");
    assert.ok(find.includes("a.txt") && find.includes("b.txt"), "WP-A FAIL: find -name 应列出 .txt");

    // 安全:仍拒绝越界与 shell 元字符(security 边界不变)
    const bad = await executeKnowledgeQuery("cat /etc/passwd", dir);
    assert.ok(!bad.ok, "WP-A FAIL: 绝对路径应被拒");
    const bad2 = await executeKnowledgeQuery("rg foo > out.txt", dir);
    assert.ok(!bad2.ok, "WP-A FAIL: 重定向应被拒");

    console.log("sandbox-commands: all checks passed ✓");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
