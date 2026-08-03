// 回归:Windows 非 UTF-8 locale(中文系统默认 cp936/GBK)下,固定 worker 必须正确处理含中文/§ 的数据。
//
// 这里直接拉起真实 worker，避免只测 mock。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPythonPath } from "../lib/runtime/paths.ts";

export const workerUtf8StdioTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-utf8-"));
  const worker = path.join(process.cwd(), "workers", "finance_worker.py");
  const csv = path.join(dir, "中文数据.csv");
  writeFileSync(csv, "category,amount,invoice_no\n经营分析§,12,INV-1\n", "utf8");

  let out = "";
  try {
    out = execFileSync(getPythonPath(), [worker, "analyze-csv", csv], {
      cwd: dir, // 与 run-python.ts 一致:相对路径产物落进输出目录
      encoding: "utf-8",
      env: {
        ...process.env,
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

  const parsed = JSON.parse(out) as { by_category: Record<string, number> };
  rmSync(dir, { recursive: true, force: true });
  assert.equal(parsed.by_category["经营分析§"], 12, `worker 应保留中文/§,实际:\n${out}`);
  console.log("worker-utf8-stdio: 模拟 GBK locale 下固定命令处理中文 ✓");
})();
