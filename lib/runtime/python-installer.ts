// 按需安装 Python 运行时到 app 数据目录(免管理员、不弹系统授权框)。
// 设计:把"下载/解压/pip"做成可注入步骤,编排逻辑可单测;真实下载 URL 与网络是残留项(需目标机器验证)。
//
// ⚠ 残留:resolvePythonAssetUrl 的 release tag/资产名需核实 python-build-standalone 最新发布;
//   defaultInstallSteps 的真实下载/解压未在无头环境验证。

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { getBundledPythonArchive, getInstalledPythonDir, getProjectRoot } from "./paths";

export type InstallPhase = "resolve" | "download" | "extract" | "pip" | "done" | "error";
export type InstallProgress = { phase: InstallPhase; message: string };
export type InstallResult = { ok: boolean; pythonPath?: string; detail: string };

export type InstallSteps = {
  download: (url: string, destFile: string) => Promise<void>;
  extract: (archive: string, destDir: string) => Promise<void>;
  pipInstall: (pythonPath: string, requirementsPath: string) => Promise<void>;
  exists?: (p: string) => boolean;
};

// python-build-standalone 布局:Windows 的 python.exe 在根目录(不在 Scripts/),unix 在 bin/python3。
// 早期误判为 Scripts/python.exe → 解压成功仍报"未找到 Python"导致 Windows 安装失败。
function pythonExeIn(dir: string): string {
  return process.platform === "win32"
    ? path.join(dir, "python.exe")
    : path.join(dir, "bin", "python3");
}

/**
 * python-build-standalone 资产 URL(按平台)。release tag / 资产命名需核实最新发布(残留)。
 * 仅在确实需要下载时调用。
 */
export function resolvePythonAssetUrl(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const TAG = "20240814"; // 需核实最新 python-build-standalone release
  const VER = "3.12.5";
  const tripleMap: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc-shared",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu"
  };
  const triple = tripleMap[`${platform}-${arch}`];
  if (!triple) throw new Error(`暂不支持的平台:${platform}-${arch}(高级分析组件需手动安装)`);
  const asset = `cpython-${VER}+${TAG}-${triple}-install_only.tar.gz`;
  return `https://github.com/indygreg/python-build-standalone/releases/download/${TAG}/${asset}`;
}

/**
 * CPython 下载候选源(按顺序尝试,首个成功即用)。GitHub release 国内不稳,优先走可配镜像/代理:
 * - FINANCE_AGENT_PYTHON_ASSET_URL:整条自托管 URL(如放阿里云 OSS/自家 CDN),最高优先;
 * - FINANCE_AGENT_GH_PROXY:GitHub 代理前缀(如 https://ghproxy.com/),拼在 GitHub 地址前;
 * 末尾总回退裸 GitHub 地址。
 */
export function resolvePythonAssetUrls(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const github = resolvePythonAssetUrl(platform, arch);
  const urls: string[] = [];
  const selfHost = process.env.FINANCE_AGENT_PYTHON_ASSET_URL?.trim();
  if (selfHost) urls.push(selfHost);
  const proxy = process.env.FINANCE_AGENT_GH_PROXY?.trim();
  if (proxy) urls.push(proxy.replace(/\/?$/, "/") + github);
  urls.push(github);
  return [...new Set(urls)];
}

/** 编排:解析 URL → 下载 → 解压 → 校验 → pip 装依赖。失败一律降级为人话 detail,不抛。 */
export async function installPythonRuntime(opts: {
  steps: InstallSteps;
  onProgress?: (p: InstallProgress) => void;
}): Promise<InstallResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const exists = opts.steps.exists ?? fs.existsSync;
  const dir = getInstalledPythonDir();
  try {
    const pythonPath = pythonExeIn(dir);
    let installed = false;
    let lastError: unknown;

    // C 方案:优先用随安装包内嵌的 Python 归档(解压即用,免联网下载——绕开 GitHub 抖动/版本漂移)。
    const bundled = getBundledPythonArchive();
    if (exists(bundled)) {
      try {
        onProgress({ phase: "extract", message: "正在解压内置组件…" });
        await opts.steps.extract(bundled, dir);
        installed = exists(pythonPath);
        if (!installed) lastError = new Error("内置归档解压后未找到 Python 可执行文件");
      } catch (error) {
        lastError = error;
      }
    }

    // 兜底:没内嵌归档(或归档损坏)→ 联网下载。镜像/代理优先,GitHub 末位;
    // download+extract+校验作为一次完整尝试(镜像常返回「200+错误页」,download 不抛但 extract 会失败,故 extract 也纳入重试)。
    if (!installed) {
      onProgress({ phase: "resolve", message: "确定高级分析组件版本…" });
      const urls = resolvePythonAssetUrls();
      const archive = path.join(os.tmpdir(), "fa-python-runtime.tar.gz");
      for (const url of urls) {
        try {
          onProgress({ phase: "download", message: "正在下载高级分析组件…" });
          await opts.steps.download(url, archive);
          onProgress({ phase: "extract", message: "正在解压…" });
          await opts.steps.extract(archive, dir);
          if (!exists(pythonPath)) {
            lastError = new Error("解压后未找到 Python 可执行文件");
            continue;
          }
          installed = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
    }

    if (!installed) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      if (msg.includes("未找到")) {
        return { ok: false, detail: "解压后未找到 Python 可执行文件,组件可能损坏,请重试。" };
      }
      throw lastError ?? new Error("下载失败:所有候选源均不可用");
    }

    onProgress({ phase: "pip", message: "正在安装依赖…" });
    await opts.steps.pipInstall(pythonPath, path.join(getProjectRoot(), "requirements.txt"));

    onProgress({ phase: "done", message: "高级分析组件已就绪。" });
    return { ok: true, pythonPath, detail: "高级 Excel/PDF 分析已启用。" };
  } catch (error) {
    const detail = `安装失败:${error instanceof Error ? error.message : String(error)}。可稍后在设置里重试,期间基础功能不受影响。`;
    onProgress({ phase: "error", message: detail });
    return { ok: false, detail };
  }
}

/** 真实步骤(默认):https 下载 + tar 解压 + pip。未在无头环境验证(残留)。 */
export const defaultInstallSteps: InstallSteps = {
  download: async (url, destFile) => {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(destFile));
  },
  extract: async (archive, destDir) => {
    // 先清掉上一次失败/中断留下的半截残留,再解压——否则会在脏目录上叠加(残留文件 + 新文件混合,
    // 或旧的损坏 python 被后续 exists() 误判为可用而跳过修复)。bundled 与 download 两条路每次解压都从干净目录开始。
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "-C", destDir, "--strip-components=1"]);
  },
  pipInstall: async (pythonPath, requirementsPath) => {
    // 默认走清华 PyPI 镜像(国内稳),非国内可用 FINANCE_AGENT_PIP_INDEX_URL 覆盖(如官方 https://pypi.org/simple)。
    const indexUrl = process.env.FINANCE_AGENT_PIP_INDEX_URL?.trim() || "https://pypi.tuna.tsinghua.edu.cn/simple";
    await execFileAsync(pythonPath, ["-m", "pip", "install", "-i", indexUrl, "-r", requirementsPath]);
  }
};

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // 显式给恒存在的 cwd:子进程默认继承父进程(next-server)的 cwd = 应用包内 next-server 目录;
    // 该目录一旦消失(从 DMG 直接运行后弹出/移动 .app、Gatekeeper translocation 回收、或被清理),
    // pip 启动时 os.getcwd() 抛 FileNotFoundError(ENOENT)致首启「Excel 组件」安装失败。
    // os.tmpdir() 恒存在;tar(-C/-f)与 pip(-r/pythonPath)入参均为绝对路径,不依赖 cwd。
    execFile(cmd, args, { cwd: os.tmpdir(), timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}
