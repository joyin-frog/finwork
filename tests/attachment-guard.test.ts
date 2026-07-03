import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

export const attachmentGuardTestPromise = (async () => {
  // 用临时 app data 目录锚定合法根。paths 惰性读 env,故设在 import 后、调用前即可;
  // 用完恢复,避免污染 all.test 里后续依赖 APP_DATA_DIR 的测试(见 memory 里的坑)。
  const prevAppDataDir = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const tmpRoot = path.join(os.tmpdir(), `fa-attach-guard-${process.pid}`);
  process.env.FINANCE_AGENT_APP_DATA_DIR = tmpRoot;

  const { isAllowedAttachmentPath, sanitizeAttachments } = await import("../lib/agent/attachment-guard.ts");
  const { getConversationFilesDir } = await import("../lib/runtime/paths.ts");

  const cid = 42;
  const convDir = getConversationFilesDir(cid);

  // ── A1: 会话目录相对路径(引用附件的常见形态)放行 ──
  assert.equal(isAllowedAttachmentPath("upload/发票.jpg", cid), true, "A1 FAIL: upload/ 相对路径应放行");
  assert.equal(isAllowedAttachmentPath("generate/报表.xlsx", cid), true, "A1 FAIL: generate/ 相对路径应放行");

  // ── A2: 会话目录下的绝对路径(新上传形态)放行 ──
  assert.equal(isAllowedAttachmentPath(path.join(convDir, "upload", "x.pdf"), cid), true, "A2 FAIL: 会话目录内绝对路径应放行");

  // ── A4: 任意绝对越权路径拒绝(核心攻击面)──
  assert.equal(isAllowedAttachmentPath("/Users/victim/.ssh/id_rsa", cid), false, "A4 FAIL: 任意绝对路径应拒绝");
  assert.equal(isAllowedAttachmentPath("/etc/passwd", cid), false, "A4 FAIL: /etc/passwd 应拒绝");

  // ── A5: ../ 逃逸拒绝 ──
  assert.equal(isAllowedAttachmentPath("../43/upload/别人的.pdf", cid), false, "A5 FAIL: 跨会话 ../ 逃逸应拒绝");
  assert.equal(isAllowedAttachmentPath("upload/../../../etc/passwd", cid), false, "A5 FAIL: 深层 ../ 逃逸应拒绝");

  // ── A6: 前缀伪装拒绝(sibling 目录以会话目录名为前缀)──
  assert.equal(isAllowedAttachmentPath(convDir + "-evil/x", cid), false, "A6 FAIL: 前缀伪装目录应拒绝");

  // ── A7: 无 conversationId(新会话首条)时,一律拒绝带路径的附件(无法锚定会话目录)──
  assert.equal(isAllowedAttachmentPath("upload/x.pdf", undefined), false, "A7 FAIL: 无 cid 时会话相对路径应拒绝");
  assert.equal(isAllowedAttachmentPath(path.join(convDir, "upload", "x.pdf"), undefined), false, "A7 FAIL: 无 cid 时绝对路径也拒绝");

  // ── A8: 空 / 非法输入拒绝 ──
  assert.equal(isAllowedAttachmentPath("", cid), false, "A8 FAIL: 空串应拒绝");

  // ── A9: sanitizeAttachments 丢逃逸、留合法与无 storagePath 的 ──
  const { kept, dropped } = sanitizeAttachments(
    [
      { name: "a", storagePath: "upload/a.pdf" },        // 合法
      { name: "b", storagePath: "/etc/passwd" },          // 逃逸
      { name: "c" },                                       // 无 storagePath(内联/远程)
    ],
    cid
  );
  assert.deepEqual(kept.map((a) => a.name), ["a", "c"], "A9 FAIL: 应保留合法与无路径附件");
  assert.deepEqual(dropped.map((a) => a.name), ["b"], "A9 FAIL: 应丢弃逃逸附件");

  // ── A10: sanitize 把保留附件的相对路径规范化成会话目录内的绝对路径 ──
  //   (agent cwd 是项目根,prompt 里若留裸相对串会被 agent 从项目根解析 → 读错文件)
  {
    const keptA = kept.find((a) => a.name === "a")!;
    assert.equal(keptA.storagePath, path.join(convDir, "upload", "a.pdf"), "A10 FAIL: 相对路径应规范化为会话目录内绝对路径");
    assert.ok(path.isAbsolute(keptA.storagePath!), "A10 FAIL: 应为绝对路径");
    // 无 storagePath 的附件不受影响
    const keptC = kept.find((a) => a.name === "c")!;
    assert.equal(keptC.storagePath, undefined, "A10 FAIL: 无 storagePath 的附件应原样保留");
  }

  // ── A11: 裸相对路径(.env / package.json)虽解析进会话目录仍被规范化,
  //   下游 prompt 不再拿到裸相对串,agent 无从用项目根解析读到机密文件 ──
  {
    const { kept: k2 } = sanitizeAttachments([{ name: "env", storagePath: ".env" }], cid);
    assert.equal(k2.length, 1, "A11 FAIL: .env 解析进会话目录内,保留");
    assert.equal(k2[0].storagePath, path.join(convDir, ".env"), "A11 FAIL: 裸相对应重写为会话目录内绝对路径");
    assert.notEqual(k2[0].storagePath, ".env", "A11 FAIL: 下游不应再拿到裸相对串");
  }

  // 恢复 env,避免污染后续测试。
  if (prevAppDataDir === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
  else process.env.FINANCE_AGENT_APP_DATA_DIR = prevAppDataDir;

  console.log("attachment-guard: all 11 checks passed ✓");
})();
