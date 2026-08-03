import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  buildBashSandboxProfile,
  isBashSandboxAvailable,
  wrapCommandWithSandbox,
} from "../../lib/agent/tools/bash-sandbox.ts";
import { createFinworkBuiltinTools } from "../../lib/agent/pi/builtin-tools.ts";

if (process.platform !== "darwin") {
  console.log("Pi bash sandbox — 跳过（非 darwin，此平台不注册 bash）");
  process.exit(0);
}

assert.ok(isBashSandboxAvailable(), "B-0 FAIL: darwin 上应能拿到 sandbox-exec");

const root = mkdtempSync(path.join(tmpdir(), "finwork-bash-sandbox-"));
const filesDir = path.join(root, "files", "7");
const outputDir = path.join(filesDir, "generate");
mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(filesDir, "uploaded.csv"), "上传件\n", "utf8");

// 会话之外的「真账本」：所有越界用例都拿它当靶子，断言必须是「文件仍在」。
const victimDir = path.join(root, "outside");
mkdirSync(victimDir, { recursive: true });
const victim = path.join(victimDir, "ledger.txt");
writeFileSync(victim, "真账本\n", "utf8");

const roots = { readRoot: filesDir, writeRoot: outputDir };

/**
 * 照 pi 的执行形态跑：spawn(shell, [...args, command])，即 /bin/sh -c "<wrapped>"，
 * 且 cwd 由 spawnHook 钉在输出目录。cwd 必须一致——从家目录下的仓库启动时沙箱会拒
 * `getcwd`，那是测试跑法不对，不是沙箱有问题。
 */
function runSandboxed(command: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("/bin/sh", ["-c", wrapCommandWithSandbox(command, roots)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: outputDir,
    });
    return { ok: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// ── B-1 profile 用真实路径：/tmp 是 /private/tmp 的软链，不解析会得到形同虚设的沙箱 ──
{
  const profile = buildBashSandboxProfile(roots);
  assert.ok(
    !/\(subpath "\/tmp\//.test(profile),
    `B-1 FAIL: profile 里出现未解析的 /tmp 路径\n${profile}`,
  );
  assert.match(profile, /\(deny file-read\* \(subpath /, "B-1 FAIL: 应含家目录读拒绝规则");

  // 顺序就是机制：SBPL 后匹配的规则覆盖先匹配的。生产上会话目录在 app-data，
  // 也就是**家目录内部**——靠「先拒家目录、再放行会话目录」这个次序才读得到。
  // 实测过嵌套放行确实生效；这里锁住次序，防止有人重排规则后静默失效。
  const denyHome = profile.indexOf("(deny file-read*");
  const allowSession = profile.indexOf("(allow file-read* (subpath");
  const allowWrite = profile.indexOf("(allow file-write* (subpath");
  assert.ok(denyHome > 0 && allowSession > denyHome, "B-1 FAIL: 会话读放行必须排在家目录拒绝之后");
  assert.ok(allowWrite > denyHome, "B-1 FAIL: 写放行必须排在家目录拒绝之后");
}

// ── B-2 正常用法不能被沙箱打断 ──
{
  const pipe = runSandboxed("ls /usr/bin > /dev/null && echo PIPE-OK");
  assert.match(pipe.output, /PIPE-OK/, `B-2 FAIL: 重定向到 /dev/null 应可用：${pipe.output}`);

  const write = runSandboxed("echo 报表 > report.md && cat report.md");
  assert.match(write.output, /报表/, `B-2 FAIL: 写会话输出目录应成功：${write.output}`);
  assert.ok(existsSync(path.join(outputDir, "report.md")), "B-2 FAIL: 文件应真的落在输出目录");

  const read = runSandboxed(`cat ${JSON.stringify(path.join(filesDir, "uploaded.csv"))}`);
  assert.match(read.output, /上传件/, `B-2 FAIL: 应能读本会话上传件：${read.output}`);
}

// ── B-3 越界写入被拦 ──
{
  const outside = path.join(victimDir, "planted.txt");
  runSandboxed(`echo evil > ${JSON.stringify(outside)}`);
  assert.ok(!existsSync(outside), "B-3 FAIL: 会话目录外不应被写入");
}

// ── B-4 家目录不可读（真账本、私钥所在处）──
// 判据用真实存在的条目名：沙箱若失效，`ls ~` 会把这个名字打出来。
{
  const homeEntry = readdirSync(homedir()).find((name) => !name.startsWith("."));
  assert.ok(homeEntry, "B-4 setup FAIL: 家目录应至少有一个非隐藏条目");
  const listed = runSandboxed(`ls ${JSON.stringify(homedir())} 2>&1`);
  assert.ok(
    !listed.output.includes(homeEntry),
    `B-4 FAIL: 家目录被列出了（出现 ${homeEntry}）：${listed.output}`,
  );
  assert.match(listed.output, /not permitted/, `B-4 FAIL: 应是权限拒绝：${listed.output}`);
}

// ── B-5 回归：正则闸漏过的 8 条，沙箱必须全拦 ──
// 判据一律是「靶文件仍在 / 未被写入」，不看退出码——`rm -f` 无法 stat 时同样返回 0，
// 用退出码判绿会得到假绿灯。
{
  const bypasses = [
    ["分开写的 -r -f", `rm -r -f ${JSON.stringify(victimDir)}`],
    ["基线 rm -rf", `rm -rf ${JSON.stringify(victimDir)}`],
    ["find -delete", `find ${JSON.stringify(victimDir)} -name '*.txt' -delete`],
    ["mv 搬走账本", `mv ${JSON.stringify(victim)} ${JSON.stringify(path.join(outputDir, "stolen.txt"))}`],
    ["truncate 清空", `: > ${JSON.stringify(victim)}`],
    ["追加篡改", `echo 篡改 >> ${JSON.stringify(victim)}`],
  ];
  for (const [note, command] of bypasses) {
    runSandboxed(command);
    assert.ok(existsSync(victim), `B-5 FAIL: 靶文件被删除 —— ${note}：${command}`);
    assert.equal(
      readFileSync(victim, "utf8"),
      "真账本\n",
      `B-5 FAIL: 靶文件内容被改 —— ${note}：${command}`,
    );
  }
  assert.ok(
    !existsSync(path.join(outputDir, "stolen.txt")),
    "B-5 FAIL: 账本被搬进了输出目录",
  );
}

// ── B-6 命令里的单引号不能破坏包装（转义正确性）──
{
  const quoted = runSandboxed(`echo 'it'"'"'s fine' && echo QUOTE-OK`);
  assert.match(quoted.output, /QUOTE-OK/, `B-6 FAIL: 含单引号的命令应正常执行：${quoted.output}`);
}

// ── B-7 沙箱可用时 bash 才在工具集里（fail-closed 的正向一侧）──
{
  const tools = await createFinworkBuiltinTools(roots);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["bash", "edit", "find", "grep", "ls", "read", "write"],
    "B-7 FAIL: darwin 上应注册含 bash 的完整内置集",
  );
}

console.log("Pi bash sandbox ✓ 真实 sandbox-exec 拦住了正则漏过的全部越界写/删/搬");
