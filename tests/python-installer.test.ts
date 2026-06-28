import assert from "node:assert/strict";
import { installPythonRuntime, resolvePythonAssetUrl, resolvePythonAssetUrls, type InstallSteps } from "../lib/runtime/python-installer.ts";

// 按需 Python 安装编排(可注入步骤,纯逻辑可单测;真实下载/解压为残留)。
// C 方案:优先用随包内嵌归档(免联网),无归档时兜底联网下载。
export const pythonInstallerTestPromise = (async () => {
  const savedArchive = process.env.FINANCE_AGENT_PYTHON_ARCHIVE;
  try {
    // ── C:有随包归档 → 解压即用,不联网下载 ──────────────────────────────
    process.env.FINANCE_AGENT_PYTHON_ARCHIVE = "/fake/bundled/python-runtime.tar.gz";
    {
      let downloadCalled = false, pipCalled = false;
      const extractArgs: string[] = [];
      const phases: string[] = [];
      const steps: InstallSteps = {
        download: async () => { downloadCalled = true; },
        extract: async (a) => { extractArgs.push(a); },
        pipInstall: async () => { pipCalled = true; },
        exists: () => true,
      };
      const r = await installPythonRuntime({ steps, onProgress: (p) => phases.push(p.phase) });
      assert.equal(r.ok, true, "C FAIL: 有随包归档应成功");
      assert.equal(downloadCalled, false, "C FAIL: 有随包归档不应联网下载");
      assert.equal(extractArgs[0], "/fake/bundled/python-runtime.tar.gz", "C FAIL: 应解压随包归档");
      assert.ok(pipCalled, "C FAIL: 仍应 pip 装依赖");
      assert.ok(phases.includes("extract") && phases.includes("pip") && phases.includes("done"), "C FAIL: 应含 extract/pip/done");
      assert.ok(!phases.includes("download"), "C FAIL: 不应有 download 阶段");
    }

    // ── 兜底:无随包归档 → 联网下载(原路径)─────────────────────────────
    const ABSENT = "/fake/absent/python-runtime.tar.gz";
    process.env.FINANCE_AGENT_PYTHON_ARCHIVE = ABSENT;
    {
      let downloadCalled = false, pipCalled = false;
      const phases: string[] = [];
      const steps: InstallSteps = {
        download: async () => { downloadCalled = true; },
        extract: async () => {},
        pipInstall: async () => { pipCalled = true; },
        exists: (p) => p !== ABSENT, // 随包归档不存在 → 走下载;其它(pythonPath)视为存在
      };
      const r = await installPythonRuntime({ steps, onProgress: (p) => phases.push(p.phase) });
      assert.equal(r.ok, true, "fallback FAIL: 下载路径应成功");
      assert.ok(downloadCalled, "fallback FAIL: 无随包归档应联网下载");
      assert.ok(pipCalled && phases.includes("download"), "fallback FAIL: 应有 download + pip");
    }

    // ── 下载失败:降级人话 detail,不抛 ────────────────────────────────
    {
      const r = await installPythonRuntime({
        steps: { download: async () => { throw new Error("network down"); }, extract: async () => {}, pipInstall: async () => {}, exists: (p) => p !== ABSENT },
      });
      assert.equal(r.ok, false, "dl-fail FAIL: 应不 ok");
      assert.ok(r.detail.includes("安装失败") && r.detail.includes("network down") && r.detail.includes("基础功能不受影响"), "dl-fail FAIL: detail 应降级说明");
    }

    // ── 解压后缺可执行文件:不 pip,明确报错 ───────────────────────────
    {
      let pipCalled = false;
      const r = await installPythonRuntime({
        steps: { download: async () => {}, extract: async () => {}, pipInstall: async () => { pipCalled = true; }, exists: () => false },
      });
      assert.equal(r.ok, false, "missing FAIL: 应不 ok");
      assert.ok(r.detail.includes("未找到"), "missing FAIL: 应提示未找到");
      assert.equal(pipCalled, false, "missing FAIL: 不应继续 pip");
    }
  } finally {
    if (savedArchive === undefined) delete process.env.FINANCE_AGENT_PYTHON_ARCHIVE; else process.env.FINANCE_AGENT_PYTHON_ARCHIVE = savedArchive;
  }

  // ── 资产 URL 平台映射 + 候选源(与归档无关)──────────────────────────
  assert.ok(resolvePythonAssetUrl("darwin", "arm64").includes("aarch64-apple-darwin"), "URL FAIL: mac arm64 映射");
  assert.ok(resolvePythonAssetUrl("win32", "x64").includes("windows"), "URL FAIL: win x64 映射");
  assert.throws(() => resolvePythonAssetUrl("sunos" as NodeJS.Platform, "sparc"), /暂不支持的平台/, "URL FAIL: 未知平台应报错");

  const origAsset = process.env.FINANCE_AGENT_PYTHON_ASSET_URL;
  const origProxy = process.env.FINANCE_AGENT_GH_PROXY;
  try {
    delete process.env.FINANCE_AGENT_PYTHON_ASSET_URL;
    delete process.env.FINANCE_AGENT_GH_PROXY;
    const plain = resolvePythonAssetUrls("darwin", "arm64");
    assert.equal(plain.length, 1, "src FAIL: 无配置时只有 GitHub 一个源");
    assert.ok(plain[0].includes("github.com"), "src FAIL: 兜底应是 GitHub");

    process.env.FINANCE_AGENT_GH_PROXY = "https://ghproxy.test";
    const proxied = resolvePythonAssetUrls("darwin", "arm64");
    assert.equal(proxied.length, 2, "src FAIL: 配代理后应有 代理+GitHub 两个源");
    assert.ok(proxied[0].startsWith("https://ghproxy.test/https://github.com"), "src FAIL: 代理前缀应拼在 GitHub 地址前");

    process.env.FINANCE_AGENT_PYTHON_ASSET_URL = "https://my-cdn.example/py.tar.gz";
    assert.equal(resolvePythonAssetUrls("darwin", "arm64")[0], "https://my-cdn.example/py.tar.gz", "src FAIL: 自托管 URL 应最高优先");
  } finally {
    if (origAsset === undefined) delete process.env.FINANCE_AGENT_PYTHON_ASSET_URL; else process.env.FINANCE_AGENT_PYTHON_ASSET_URL = origAsset;
    if (origProxy === undefined) delete process.env.FINANCE_AGENT_GH_PROXY; else process.env.FINANCE_AGENT_GH_PROXY = origProxy;
  }

  console.log("python-installer: all checks passed ✓");
})();
