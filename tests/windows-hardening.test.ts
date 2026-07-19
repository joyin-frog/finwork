import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installPythonRuntime, type InstallSteps } from "../lib/runtime/python-installer.ts";

// WP7a: Windows 运行时防线收口测试
// ① pythonSpawnEnv helper 输出/优先级
// ② 调用点枚举断言（正向包含 pythonSpawnEnv）
// ③ tar 不可用时经 InstallSteps 注入抛含引导中文错误
export const windowsHardeningTestPromise = (async () => {

  // ──────────────────────────────────────────────────────────
  // ① helper: 输出含两个编码键 + extra 覆盖优先级
  // ──────────────────────────────────────────────────────────
  {
    const { pythonSpawnEnv } = await import("../lib/runtime/python-env.ts");

    // 基础：必须含两个编码键
    const env = pythonSpawnEnv();
    assert.equal(env.PYTHONUTF8, "1", "helper FAIL: PYTHONUTF8 应为 '1'");
    assert.equal(env.PYTHONIOENCODING, "utf-8", "helper FAIL: PYTHONIOENCODING 应为 'utf-8'");

    // extra 最后展开可覆盖编码键
    const overridden = pythonSpawnEnv({ PYTHONUTF8: "0", MY_KEY: "hello" });
    assert.equal(overridden.PYTHONUTF8, "0", "helper FAIL: extra 应能覆盖 PYTHONUTF8");
    assert.equal(overridden.PYTHONIOENCODING, "utf-8", "helper FAIL: 未覆盖的 PYTHONIOENCODING 应保留");
    assert.equal(overridden.MY_KEY, "hello", "helper FAIL: extra 自定义键应透传");

    // 继承 process.env
    assert.equal(env.PATH, process.env.PATH, "helper FAIL: 应继承 process.env.PATH");
  }

  // ──────────────────────────────────────────────────────────
  // ② 调用点枚举断言：每个文件源码正向包含 pythonSpawnEnv
  // ──────────────────────────────────────────────────────────
  // 开工 rg 现场枚举出的调用点清单（无注入 6 处 + 已注入 4 处 + installer pip）
  const callsites: Array<{ file: string; label: string }> = [
    // 无注入 6 处（本 spec 主因）
    { file: "lib/knowledge/parsers/index.ts",           label: "parsers/index extractViaWorker" },
    { file: "lib/knowledge/parsers/index.ts",           label: "parsers/index parseImageDocument" },
    { file: "lib/domain/reconciliation.ts",             label: "reconciliation" },
    { file: "lib/domain/reimbursement.ts",              label: "reimbursement" },
    { file: "lib/domain/tax-cumulative.ts",             label: "tax-cumulative" },
    { file: "lib/agent/mcp-tools/finance-tools.ts",     label: "finance-tools" },
    // python-doctor defaultRunner 函数体
    { file: "lib/runtime/python-doctor.ts",             label: "python-doctor defaultRunner" },
    // 已注入 4 处，改用 helper 消除手拼
    { file: "lib/agent/mcp-tools/run-python.ts",        label: "run-python" },
    { file: "lib/agent/mcp-tools/read-document.ts",     label: "read-document" },
    { file: "lib/agent/mcp-tools/kingdee-tools.ts",     label: "kingdee-tools" },
    { file: "lib/agent/tools/finance/payroll.ts",       label: "payroll" },
    // pip 调用点（installer）
    { file: "lib/runtime/python-installer.ts",          label: "python-installer pip" },
  ];

  for (const { file, label } of callsites) {
    const src = readFileSync(file, "utf-8");
    assert.ok(
      src.includes("pythonSpawnEnv"),
      `callsite FAIL [${label}]: ${file} 未使用 pythonSpawnEnv`
    );
  }

  // ──────────────────────────────────────────────────────────
  // ③ tar 不可用：经 InstallSteps 注入替换 extract 模拟 tar 缺失
  //    期望返回含"手动安装/升级系统"引导的中文错误 detail
  //
  //    实现：defaultInstallSteps.extract 在调用 tar 前用 spawnSync("tar","--version")
  //    探测可用性，不可用时抛出含引导文字的错误；这里通过注入替换 extract
  //    来模拟该路径（不做 PATH 劫持）。
  // ──────────────────────────────────────────────────────────
  {
    const savedArchive = process.env.FINANCE_AGENT_PYTHON_ARCHIVE;
    try {
      // 模拟无随包归档 → 走 download+extract 路径
      delete process.env.FINANCE_AGENT_PYTHON_ARCHIVE;

      // 注入模拟 tar 不可用的 extract：抛出与 defaultInstallSteps.extract 相同的引导错误格式
      const steps: InstallSteps = {
        download: async () => { /* no-op */ },
        extract: async () => {
          throw new Error("Windows 10 1803 以下需手动安装 Python 运行时或升级系统（tar 不可用）");
        },
        pipInstall: async () => { /* should not reach */ },
        exists: () => false,
      };

      const result = await installPythonRuntime({ steps });
      assert.equal(result.ok, false, "tar-missing FAIL: tar 不可用应返回 ok:false");
      assert.ok(
        result.detail.includes("手动安装") || result.detail.includes("升级系统"),
        `tar-missing FAIL: detail 应含引导文字，实际: "${result.detail}"`
      );
    } finally {
      if (savedArchive === undefined) delete process.env.FINANCE_AGENT_PYTHON_ARCHIVE;
      else process.env.FINANCE_AGENT_PYTHON_ARCHIVE = savedArchive;
    }
  }

  // ──────────────────────────────────────────────────────────
  // ④ defaultInstallSteps.extract 包含 tar 探测逻辑的静态验证
  //    （确保 spawnSync 或 tar --version 探测存在于源码中）
  // ──────────────────────────────────────────────────────────
  {
    const installerSrc = readFileSync("lib/runtime/python-installer.ts", "utf-8");
    assert.ok(
      installerSrc.includes("手动安装") || installerSrc.includes("升级系统"),
      "tar-detect FAIL: python-installer.ts 应包含 tar 不可用的引导文字"
    );
    assert.ok(
      installerSrc.includes("spawnSync") || installerSrc.includes("tar --version"),
      "tar-detect FAIL: python-installer.ts 应包含 tar 可用性探测"
    );
  }

  console.log("windows-hardening: all checks passed ✓");
})();
