import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type SandboxProcessEnvironmentOptions = {
  writeRoot: string;
  executableDirs: string[];
  extra?: Record<string, string | undefined>;
};

/**
 * Build a deliberately small environment for model-controlled processes.
 * Never spread process.env here: desktop/provider credentials commonly live
 * there and filesystem isolation does not stop a script from printing them.
 */
export function createSandboxProcessEnvironment(
  options: SandboxProcessEnvironmentOptions,
): NodeJS.ProcessEnv {
  const root = path.resolve(options.writeRoot);
  const home = path.join(root, ".sandbox-home");
  const temp = path.join(root, ".sandbox-tmp");
  const cache = path.join(root, ".sandbox-cache");
  for (const dir of [home, temp, cache]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const systemDirs = process.platform === "win32"
    ? windowsExecutableDirs()
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: [...new Set([...options.executableDirs, ...systemDirs].map((dir) => path.resolve(dir)))].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: cache,
    LOCALAPPDATA: cache,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CACHE_HOME: cache,
    MPLCONFIGDIR: path.join(cache, "matplotlib"),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
    FINWORK_SESSION_OUTPUT_DIR: root,
  };

  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value != null) env[key] = value;
  }
  return env;
}

function windowsExecutableDirs(): string[] {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return [path.join(root, "System32"), root];
}

export function sandboxTempDirectory(writeRoot: string): string {
  return path.join(path.resolve(writeRoot), ".sandbox-tmp");
}

export function sandboxPlatform(): "macos-seatbelt" | "windows-mxc-base-container" | "guarded-process" {
  if (process.platform === "darwin") return "macos-seatbelt";
  if (process.platform === "win32") return "windows-mxc-base-container";
  return "guarded-process";
}

/**
 * Resolve the Microsoft MXC executor. Production packages copy only the
 * current-architecture Windows binary into next-server/bin/mxc; development
 * reads the pinned npm package. No PATH lookup is allowed.
 */
export function windowsMxcExecutablePath(projectRoot: string): string | null {
  if (process.platform !== "win32") return null;
  const bundled = path.join(projectRoot, "bin", "mxc", "wxc-exec.exe");
  if (fs.existsSync(bundled)) return fs.realpathSync.native(bundled);
  const configured = process.env.FINWORK_MXC_EXECUTABLE;
  if (process.env.NODE_ENV !== "production" && configured && fs.existsSync(configured)) {
    return fs.realpathSync.native(configured);
  }
  if (process.arch !== "x64" && process.arch !== "arm64") return null;
  const development = path.join(
    projectRoot,
    "node_modules",
    "@microsoft",
    "mxc-sdk",
    "bin",
    process.arch,
    "wxc-exec.exe",
  );
  return fs.existsSync(development) ? fs.realpathSync.native(development) : null;
}

export type WindowsMxcProbe = {
  tier?: "base-container" | "appcontainer-bfs" | "appcontainer-dacl";
  warnings?: string[];
};

const mxcProbeCache = new Map<string, WindowsMxcProbe>();

/** Require Microsoft's native Windows 11 BaseContainer contract. */
export function requireWindowsMxcBaseContainer(executable: string): WindowsMxcProbe {
  const cached = mxcProbeCache.get(executable);
  if (cached) return cached;
  let raw: string;
  try {
    raw = execFileSync(executable, ["--probe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
      env: mxcBrokerEnvironment(),
    });
  } catch (error) {
    throw new Error(`Windows MXC 能力探测失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const probe = parseWindowsMxcProbe(raw);
  if (probe.tier !== "base-container") {
    throw new Error([
      "当前 Windows 11 尚未提供 Finwork 所需的 MXC BaseContainer contract。",
      `检测到的隔离层：${probe.tier ?? "unknown"}；已拒绝 DACL/AppContainer 降级。`,
      "请升级到支持 BaseContainer 的 Windows 11 25H2+ 构建后重试。",
    ].join(" "));
  }
  mxcProbeCache.set(executable, probe);
  return probe;
}

export function parseWindowsMxcProbe(raw: string): WindowsMxcProbe {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Windows MXC 返回了无效的能力探测结果"); }
  if (!value || typeof value !== "object") throw new Error("Windows MXC 能力探测结果为空");
  const record = value as Record<string, unknown>;
  const tier = ["base-container", "appcontainer-bfs", "appcontainer-dacl"].includes(String(record.tier))
    ? record.tier as WindowsMxcProbe["tier"]
    : undefined;
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((item): item is string => typeof item === "string")
    : undefined;
  return { tier, warnings };
}

export function mxcBrokerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
