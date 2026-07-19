import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installPythonRuntime,
  PYTHON_RUNTIME_STAMP,
  resolvePythonAssetUrl,
  resolvePythonAssetUrls,
  type InstallSteps,
} from "../lib/runtime/python-installer.ts";

// 按需 Python 安装编排(可注入步骤,纯逻辑可单测;真实下载/解压为残留)。
// C 方案:优先用随包内嵌归档(免联网),无归档时兜底联网下载。
export const pythonInstallerTestPromise = (async () => {
  const savedArchive = process.env.FINANCE_AGENT_PYTHON_ARCHIVE;
  const noopIo = { readText: () => null as string | null, writeText: () => {} };

  // 已有运行时且版本戳匹配时只补依赖；Windows 会禁止删除被存活 Python 进程加载的 DLL（EPERM）。
  process.env.FINANCE_AGENT_PYTHON_ARCHIVE = "/fake/bundled/python-runtime.tar.gz";
  {
    let downloadCalled = false, extractCalled = false, pipCalled = false;
    let writtenStamp: string | null = null;
    const steps: InstallSteps = {
      download: async () => { downloadCalled = true; },
      extract: async () => { extractCalled = true; },
      pipInstall: async () => { pipCalled = true; },
      exists: () => true,
      readText: () => PYTHON_RUNTIME_STAMP,
      writeText: (_p, data) => { writtenStamp = data; },
    };
    const r = await installPythonRuntime({ steps });
    assert.equal(r.ok, true, "existing-runtime FAIL: 已有运行时应直接成功");
    assert.equal(downloadCalled, false, "existing-runtime FAIL: 不应重新下载");
    assert.equal(extractCalled, false, "existing-runtime FAIL: 不应删除并重新解压正在使用的运行时");
    assert.equal(pipCalled, true, "existing-runtime FAIL: 应继续补装依赖");
    assert.equal(writtenStamp, PYTHON_RUNTIME_STAMP, "existing-runtime FAIL: 成功后应刷新版本戳");
  }

  // 戳不匹配（升级换了 CPython）→ 即使 python.exe 在也要重解压。
  {
    let extractCalled = false;
    let extracted = false;
    const steps: InstallSteps = {
      download: async () => {},
      extract: async () => { extractCalled = true; extracted = true; },
      pipInstall: async () => {},
      exists: (p) => p.includes("python-runtime.tar.gz") || p.endsWith("python.exe") || p.endsWith("python3") || extracted,
      readText: () => "3.11.0+old",
      writeText: () => {},
    };
    // exists 对 pythonPath 在 extract 前也 true（模拟旧运行时残留），但戳旧 → 仍应 extract
    const r = await installPythonRuntime({ steps });
    assert.equal(r.ok, true, "stale-stamp FAIL: 应成功");
    assert.equal(extractCalled, true, "stale-stamp FAIL: 戳不一致应强制重解压");
  }

  // 复用路径下 pip 失败 → 强制重装一次后再 pip。
  {
    let extractCount = 0;
    let pipCount = 0;
    let extracted = false;
    const steps: InstallSteps = {
      download: async () => {},
      extract: async () => { extractCount += 1; extracted = true; },
      pipInstall: async () => {
        pipCount += 1;
        if (pipCount === 1) throw new Error("pip broken on stale runtime");
      },
      exists: (p) => {
        if (p.includes("python-runtime.tar.gz")) return true;
        // 首次复用：python 已在；重装后仍在
        return p.endsWith("python.exe") || p.endsWith("python3") || extracted;
      },
      readText: () => PYTHON_RUNTIME_STAMP,
      writeText: () => {},
    };
    const r = await installPythonRuntime({ steps });
    assert.equal(r.ok, true, "pip-retry FAIL: 重装后应成功");
    assert.equal(extractCount, 1, "pip-retry FAIL: pip 失败后应强制重解压一次");
    assert.equal(pipCount, 2, "pip-retry FAIL: 应再跑一次 pip");
  }

  try {
    // ── C:有随包归档 → 解压即用,不联网下载 ──────────────────────────────
    process.env.FINANCE_AGENT_PYTHON_ARCHIVE = "/fake/bundled/python-runtime.tar.gz";
    {
      let downloadCalled = false, pipCalled = false;
      let extracted = false;
      const extractArgs: string[] = [];
      const phases: string[] = [];
      const steps: InstallSteps = {
        download: async () => { downloadCalled = true; },
        extract: async (a) => { extractArgs.push(a); extracted = true; },
        pipInstall: async () => { pipCalled = true; },
        exists: (p) => p === "/fake/bundled/python-runtime.tar.gz" || extracted,
        ...noopIo,
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
      let extracted = false;
      const phases: string[] = [];
      const steps: InstallSteps = {
        download: async () => { downloadCalled = true; },
        extract: async () => { extracted = true; },
        pipInstall: async () => { pipCalled = true; },
        exists: (p) => p !== ABSENT && extracted,
        ...noopIo,
      };
      const r = await installPythonRuntime({ steps, onProgress: (p) => phases.push(p.phase) });
      assert.equal(r.ok, true, "fallback FAIL: 下载路径应成功");
      assert.ok(downloadCalled, "fallback FAIL: 无随包归档应联网下载");
      assert.ok(pipCalled && phases.includes("download"), "fallback FAIL: 应有 download + pip");
    }

    // ── 下载失败:降级人话 detail,不抛 ────────────────────────────────
    {
      const r = await installPythonRuntime({
        steps: {
          download: async () => { throw new Error("network down"); },
          extract: async () => {},
          pipInstall: async () => {},
          exists: () => false,
          ...noopIo,
        },
      });
      assert.equal(r.ok, false, "dl-fail FAIL: 应不 ok");
      assert.ok(r.detail.includes("安装失败") && r.detail.includes("network down") && r.detail.includes("基础功能不受影响"), "dl-fail FAIL: detail 应降级说明");
    }

    // ── 下载归档用后即删:成功与失败路径都不残留 tmpdir 大文件 ─────────
    {
      const archive = path.join(tmpdir(), "fa-python-runtime.tar.gz");
      // 成功路径:download 落盘 → extract 后归档应被删除
      writeFileSync(archive, "fake-tarball");
      let extracted = false;
      const rOk = await installPythonRuntime({
        steps: {
          download: async () => {},
          extract: async () => { extracted = true; },
          pipInstall: async () => {},
          exists: (p) => p !== ABSENT && extracted,
          ...noopIo,
        },
      });
      assert.equal(rOk.ok, true, "archive-rm FAIL: 前提是安装成功");
      assert.equal(existsSync(archive), false, "archive-rm FAIL: 解压成功后应删除下载归档");

      // 失败路径:所有候选源下载都失败 → 归档(半截文件)也应被删除
      writeFileSync(archive, "half-downloaded");
      const rFail = await installPythonRuntime({
        steps: {
          download: async () => { throw new Error("network down"); },
          extract: async () => {},
          pipInstall: async () => {},
          exists: () => false,
          ...noopIo,
        },
      });
      assert.equal(rFail.ok, false, "archive-rm FAIL: 前提是下载失败");
      assert.equal(existsSync(archive), false, "archive-rm FAIL: 下载失败后也应删除残留归档");
    }

    // ── 解压后缺可执行文件:不 pip,明确报错 ───────────────────────────
    {
      let pipCalled = false;
      const r = await installPythonRuntime({
        steps: {
          download: async () => {},
          extract: async () => {},
          pipInstall: async () => { pipCalled = true; },
          exists: () => false,
          ...noopIo,
        },
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
  {
    const url = resolvePythonAssetUrl("darwin", "arm64");
    const [ver, tag] = PYTHON_RUNTIME_STAMP.split("+");
    assert.ok(url.includes(ver!) && url.includes(tag!), "URL FAIL: 资产 URL 应含 PYTHON_RUNTIME_STAMP 同源版本");
  }

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
