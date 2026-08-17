/**
 * pythonSpawnEnv — 统一 Python 子进程编码防线（WP7a）。
 *
 * 所有 execFileSync/spawn/execFile 调用 python 时必须经此 helper 构造 env，
 * 确保 PYTHONUTF8=1 与 PYTHONIOENCODING=utf-8 在 Windows 中文系统（GBK stdio）下始终注入。
 *
 * extra 最后展开，可覆盖编码键（如需 per-call 覆盖），也可追加调用点自有键
 * （如固定 spreadsheet worker 的环境变量等）。
 */
export function pythonSpawnEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
}

/**
 * Environment for source-controlled, fixed-command workers.
 *
 * Unlike pythonSpawnEnv this deliberately does not inherit provider/API
 * credentials. It is not a filesystem sandbox; use it only for repository
 * workers whose command and code are not authored by the model.
 */
export function trustedPythonWorkerEnv(
  extra?: Record<string, string | undefined>,
  inheritedKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  const runtimeKeys = [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  ];
  for (const key of [...runtimeKeys, ...inheritedKeys]) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value != null) env[key] = value;
  }
  return env;
}
