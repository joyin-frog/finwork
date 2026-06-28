import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getPythonPath } from "../lib/runtime/paths.ts";
import { interpretSelfcheck, checkPythonEnvironment } from "../lib/runtime/python-doctor.ts";

// WP7 / P1+P2: Python 运行时解析(打包内嵌优先,开发态回落 venv)+ 首启自检 doctor 逻辑。
export const pythonEnvTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-py-test-"));
  const origPath = process.env.FINANCE_AGENT_PYTHON_PATH;
  const origRt = process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR;
  // 隔离 app data 目录,否则 getInstalledPythonDir() 会命中本机真实安装的运行时,AC7.1 假失败。
  const origAppData = process.env.FINANCE_AGENT_APP_DATA_DIR;
  process.env.FINANCE_AGENT_APP_DATA_DIR = path.join(dir, "appdata");
  const isWin = process.platform === "win32";
  // python-build-standalone 布局:Windows 的 python.exe 在根目录(不在 Scripts/),unix 在 bin/python3。
  const standaloneExe = (root: string) => isWin ? path.join(root, "python.exe") : path.join(root, "bin", "python3");

  try {
    // ── AC7.1: 无内嵌运行时 → 回落开发态 venv ───────────────────────────
    delete process.env.FINANCE_AGENT_PYTHON_PATH;
    const rt = path.join(dir, "rt");
    process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR = rt;
    assert.ok(getPythonPath().includes(".venv"), "AC7.1 FAIL: 无内嵌运行时应回落 .venv");

    // 内嵌运行时存在 → 优先用打包 Python(按 standalone 布局放置解释器)─────
    const rtExe = standaloneExe(rt);
    mkdirSync(path.dirname(rtExe), { recursive: true });
    writeFileSync(rtExe, "");
    const resolved = getPythonPath();
    assert.equal(resolved, rtExe, "AC7.1 FAIL: 存在内嵌运行时时应优先解析到 standalone 布局路径");
    assert.ok(!resolved.includes(".venv"), "AC7.1 FAIL: 有内嵌运行时不应再用 venv");

    // 显式 env 覆盖优先级最高 ────────────────────────────────────────────
    process.env.FINANCE_AGENT_PYTHON_PATH = "/custom/python3";
    assert.equal(getPythonPath(), "/custom/python3", "AC7.1 FAIL: FINANCE_AGENT_PYTHON_PATH 应优先");

    // ── AC7.2: doctor 解析逻辑(成功 / 缺依赖)────────────────────────────
    const okResult = interpretSelfcheck(
      JSON.stringify({ python: "3.12.1", deps: { openpyxl: "3.1.5", pandas: "2.2.3" }, missing: [], ok: true }),
      "/p/python3"
    );
    assert.equal(okResult.ok, true, "AC7.2 FAIL: 依赖齐全应 ok");
    assert.equal(okResult.pythonVersion, "3.12.1");

    const missingResult = interpretSelfcheck(
      JSON.stringify({ python: "3.12.1", deps: {}, missing: ["pandas", "fitz"], ok: false }),
      "/p/python3"
    );
    assert.equal(missingResult.ok, false, "AC7.2 FAIL: 缺依赖应不 ok");
    assert.ok(missingResult.detail.includes("pandas") && missingResult.detail.includes("fitz"), "AC7.2 FAIL: 应列出缺失项");

    const garbage = interpretSelfcheck("not json", "/p/python3");
    assert.equal(garbage.ok, false, "AC7.2 FAIL: 非 JSON 应降级为不 ok");

    // checkPythonEnvironment:Python 不存在 → 人话提示 ───────────────────
    const noPy = await checkPythonEnvironment({ exists: () => false });
    assert.equal(noPy.ok, false);
    assert.ok(noPy.detail.includes("未找到 Python"), "AC7.2 FAIL: 缺运行时应给人话提示");

    // checkPythonEnvironment:注入 runner 模拟成功 ──────────────────────
    const okEnv = await checkPythonEnvironment({
      exists: () => true,
      runner: async () => JSON.stringify({ python: "3.12.1", deps: { openpyxl: "3.1.5" }, missing: [], ok: true })
    });
    assert.equal(okEnv.ok, true, "AC7.2 FAIL: runner 成功应 ok");

    // runner 抛错 → 降级 ────────────────────────────────────────────────
    const failEnv = await checkPythonEnvironment({ exists: () => true, runner: async () => { throw new Error("boom"); } });
    assert.equal(failEnv.ok, false, "AC7.2 FAIL: runner 抛错应降级不 ok");

    // ── AC7.4: doctor 路由 handler 直接调用,返回环境自检结果(不抛、不 5xx)──
    const { GET } = await import("../app/api/settings/doctor/route.ts");
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; data: { python: { ok: boolean; detail: string } } };
    assert.equal(body.ok, true, "AC7.4 FAIL: doctor 路由应返回 ok 信封");
    assert.equal(typeof body.data.python.ok, "boolean", "AC7.4 FAIL: 应含 python.ok");
    assert.ok(body.data.python.detail.length > 0, "AC7.4 FAIL: 应含人话状态");

    console.log("python-env: all checks passed ✓");
  } finally {
    if (origPath === undefined) delete process.env.FINANCE_AGENT_PYTHON_PATH;
    else process.env.FINANCE_AGENT_PYTHON_PATH = origPath;
    if (origRt === undefined) delete process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR;
    else process.env.FINANCE_AGENT_PYTHON_RUNTIME_DIR = origRt;
    if (origAppData === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    else process.env.FINANCE_AGENT_APP_DATA_DIR = origAppData;
    rmSync(dir, { recursive: true, force: true });
  }
})();
