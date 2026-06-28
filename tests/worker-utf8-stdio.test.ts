// 回归:Windows 非 UTF-8 locale(中文系统默认 cp936/GBK)下,finance_worker.py 必须把含中文/§ 的
// agent 代码正确执行 —— 此前 worker 用 sys.stdin.read() 按平台编码解码,Node 写入的 UTF-8 被误解码成
// 游离代理(\udcXX)→ exec 报 "surrogates not allowed",聊天里表现为 run_python 反复失败、浪费回合。
//
// 为什么需要这个测试(回答"mock 测不出来吗"):mock agent 绕过真实 worker;worker 自身的测试在
// mac/Linux CI 默认 UTF-8 下永远不复现 —— 必须**故意**造非 UTF-8 环境(PYTHONIOENCODING=gbk 且不开
// PYTHONUTF8)才照得到。这里只验证 worker 内 _force_utf8_stdio() 的兜底(不依赖 run-python.ts 的
// PYTHONUTF8=1),确保 worker 被任何方式拉起都正确。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const workerUtf8StdioTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-utf8-"));
  const worker = path.join(process.cwd(), "workers", "finance_worker.py");
  const code = [
    'print("经营分析：营收 §1 同比 +12%")',
    'with open("产物.txt", "w", encoding="utf-8") as f:',
    '    f.write("中文内容 §")',
  ].join("\n");

  let out = "";
  try {
    out = execFileSync(getPythonPath(), [worker, "run"], {
      input: code,
      cwd: dir, // 与 run-python.ts 一致:相对路径产物落进输出目录
      encoding: "utf-8",
      env: {
        ...process.env,
        FINANCE_AGENT_OUTPUT_DIR: dir,
        PYTHONIOENCODING: "gbk", // 模拟 Windows 中文 locale 的 stdio 编码
        PYTHONUTF8: "0", // 关掉 UTF-8 模式 → 只验证 worker 内 reconfigure 兜底
      },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    rmSync(dir, { recursive: true, force: true });
    assert.fail(
      `worker 在模拟 GBK locale 下执行中文代码失败(应被 _force_utf8_stdio 兜住):\n${err.stderr ?? ""}${err.message ?? ""}`
    );
  }

  const parsed = JSON.parse(out) as { stdout: string; files: Array<{ name: string }> };
  rmSync(dir, { recursive: true, force: true });
  assert.ok(parsed.stdout.includes("经营分析"), `worker stdout 应含中文,实际:\n${out}`);
  assert.ok(parsed.stdout.includes("§"), "worker stdout 应保留 § 符号");
  assert.ok(
    parsed.files.some((f) => f.name === "产物.txt"),
    `应识别到中文名产物文件,实际 files:\n${JSON.stringify(parsed.files)}`
  );
  console.log("worker-utf8-stdio: 模拟 GBK locale 下中文代码执行 ✓");
})();
