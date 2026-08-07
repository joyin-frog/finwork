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
