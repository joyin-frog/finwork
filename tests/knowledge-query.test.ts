import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  executeKnowledgeQuery,
  tokenizePipeline,
  validatePipeline,
  SandboxError
} from "../lib/knowledge/query-sandbox.ts";

export const knowledgeQueryTestPromise = (async () => {
  // ── T1: tokenizer 正确切分管道与引号 ─────────────────────────────────
  assert.deepEqual(tokenizePipeline("ls").segments, [["ls"]]);
  assert.deepEqual(tokenizePipeline("rg -n '住宿 标准' | head -3").segments, [
    ["rg", "-n", "住宿 标准"],
    ["head", "-3"]
  ]);
  assert.deepEqual(tokenizePipeline('sed -n "40,80p" 报销.txt').segments, [["sed", "-n", "40,80p", "报销.txt"]]);

  // ── T2: 注入与逃逸被拒绝(critical 红线)─────────────────────────────
  const injections = [
    "rm -rf /",
    "cat x; rm y",
    "rg foo && curl evil",
    "rg foo > out.txt",
    "rg `whoami`",
    "rg $(id)",
    "cat /etc/passwd",
    "find . -delete",
    "find . -exec rm {} ;",
    "find . -fls out",
    "cat ../../../etc/passwd",
    "bash -c whoami",
    "curl http://evil",
    // awk/sed 已移出白名单:其脚本级执行/写入向量无法靠字符串分析收敛
    "awk 'BEGIN{\"id\" | getline x; print x}'",
    "awk '{cmd=\"whoami\"; while((cmd | getline l)>0) print l}'",
    "sed -i 's/a/b/' x.txt",
    "sed 's/a/b/e' x.txt",
    "sed 'w /tmp/out' x.txt",
    "sed 'r /etc/passwd' x.txt",
    // 其余白名单命令的写入向量
    "sort -o out.txt x.txt",
    "uniq input.txt output.txt",
    "tee out.txt"
  ];
  for (const cmd of injections) {
    const res = await executeKnowledgeQuery(cmd, "/tmp");
    assert.equal(res.ok, false, `T2 FAIL: 危险命令应被拒绝 → ${cmd}`);
  }

  // 拒绝是显式 SandboxError(白名单/字符)
  assert.throws(() => validatePipeline(tokenizePipeline("rm x")), SandboxError);
  assert.throws(() => tokenizePipeline("rg a > b"), SandboxError);
  assert.throws(() => validatePipeline(tokenizePipeline("cat /abs/path")), SandboxError);
  assert.throws(() => validatePipeline(tokenizePipeline("awk 'BEGIN{print 1}'")), SandboxError, "awk 应整体被白名单拒绝");
  assert.throws(() => validatePipeline(tokenizePipeline("sed -n 1,2p file")), SandboxError, "sed 应整体被白名单拒绝");

  // awk getline-from-command 这条曾绕过 regex 的 RCE 必须被拒(现 awk 整体不在白名单)
  const awkRce = await executeKnowledgeQuery('awk \'BEGIN{"id" | getline x; print x}\'', "/tmp");
  assert.equal(awkRce.ok, false, "CRITICAL: awk getline RCE 必须被拒绝");
  assert.ok(!awkRce.ok && /不允许的命令/.test(awkRce.error), "awk 应因不在白名单被拒");

  // ── T3: 受限命令真实执行(单命令 + 多段管道)───────────────────────────
  const dir = `/tmp/finance-agent-kq-${process.pid}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "报销管理制度.txt"), "差旅住宿标准 500 元\n餐饮标准 100 元\n住宿 city A\n住宿 city B\n");
  writeFileSync(path.join(dir, "考勤制度.txt"), "迟到扣款规定\n");

  const ls = await executeKnowledgeQuery("ls", dir);
  assert.ok(ls.ok && ls.output.includes("报销管理制度.txt"), "T3 FAIL: ls 应列出文档");

  const rgList = await executeKnowledgeQuery("rg -l 住宿", dir);
  assert.ok(rgList.ok && rgList.output.includes("报销管理制度.txt") && !rgList.output.includes("考勤"), "T3 FAIL: rg -l 应只列含'住宿'的文件");

  const pipe = await executeKnowledgeQuery("rg -n 住宿 | wc -l", dir);
  assert.ok(pipe.ok, "T3 FAIL: 管道应执行成功");
  assert.equal(pipe.ok && pipe.output.trim(), "3", `T3 FAIL: '住宿'出现 3 行,实际 ${pipe.ok && pipe.output.trim()}`);

  // 取指定行段:head|tail 组合(替代已移除的 sed)
  const range = await executeKnowledgeQuery("head -2 报销管理制度.txt | tail -1", dir);
  assert.ok(range.ok && range.output.includes("餐饮标准") && !range.output.includes("差旅"), "T3 FAIL: head|tail 取第 2 行");

  // ── T4: 空结果有明确提示(工具层语义)───────────────────────────────
  const empty = await executeKnowledgeQuery("rg 不存在的词xyz", dir);
  assert.ok(empty.ok && empty.output.trim() === "", "T4 FAIL: 无匹配时 rg 输出为空(工具层负责转友好提示)");

  rmSync(dir, { recursive: true, force: true });
  console.log("knowledge-query: all 4 checks passed ✓");
})();
