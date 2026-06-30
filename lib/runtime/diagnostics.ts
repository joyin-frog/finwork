import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { exportDatabase, insertAuditLog } from "@/lib/db/sqlite";
import { getAppDataDir, getLogsDir } from "@/lib/runtime/paths";

const SAFE_LOG_NAME = /^(?:next-server\.log(?:\.1)?|server-\d{4}-\d{2}-\d{2}\.log|tauri-host[^/]*\.log)$/;

export type DiagnosticsExportResult = {
  path: string;
  files: string[];
  containsSensitiveData: true;
};

function nextBundlePath(destinationDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const base = path.join(destinationDir, `finance-agent-diagnostics-${stamp}`);
  let candidate = base;
  let suffix = 0;
  while (existsSync(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/**
 * Creates a local diagnostics directory containing a consistent database snapshot and allowlisted logs.
 *
 * Sensitive-data boundary: the database snapshot is intentionally complete and may contain raw chat
 * messages, tool events, names, addresses, and financial data. Logs may contain user-entered content.
 * The bundle is local-only, is never uploaded, and must be reviewed before it is shared.
 */
export function exportDiagnostics(
  destinationDir: string,
  now = new Date()
): DiagnosticsExportResult {
  if (!path.isAbsolute(destinationDir)) {
    throw new Error("exportDiagnostics: destinationDir 必须是绝对路径");
  }
  const appDataDir = path.resolve(getAppDataDir());
  const resolvedDestination = path.resolve(destinationDir);
  const relativeDestination = path.relative(appDataDir, resolvedDestination);
  if (relativeDestination === ".." || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination)) {
    throw new Error("exportDiagnostics: destinationDir 必须位于应用数据目录内");
  }

  destinationDir = resolvedDestination;
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const bundlePath = nextBundlePath(destinationDir, now);
  mkdirSync(bundlePath, { mode: 0o700 });
  const files: string[] = [];

  try {
    const databaseName = "finance-agent.db";
    exportDatabase(path.join(bundlePath, databaseName));
    files.push(databaseName);

    const logsDir = getLogsDir();
    if (existsSync(logsDir)) {
      const targetLogsDir = path.join(bundlePath, "logs");
      for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !SAFE_LOG_NAME.test(entry.name)) continue;
        if (!existsSync(targetLogsDir)) mkdirSync(targetLogsDir, { recursive: true });
        copyFileSync(path.join(logsDir, entry.name), path.join(targetLogsDir, entry.name));
        files.push(path.posix.join("logs", entry.name));
      }
    }

    const warningName = "SENSITIVE-DATA-README.txt";
    writeFileSync(
      path.join(bundlePath, warningName),
      [
        "Finance Agent diagnostics export",
        "",
        "SENSITIVE DATA WARNING",
        "- finance-agent.db is a complete local database snapshot.",
        "- It may include raw chat messages, tool events, names, addresses, and financial data.",
        "- Log files may also include user-entered content.",
        "- This export is created locally and is not uploaded by the application.",
        "- Review and securely redact the bundle before sharing it with anyone.",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 }
    );
    files.push(warningName);

    const manifestName = "manifest.json";
    writeFileSync(
      path.join(bundlePath, manifestName),
      JSON.stringify(
        {
          formatVersion: 1,
          createdAt: now.toISOString(),
          containsSensitiveData: true,
          localOnly: true,
          files,
        },
        null,
        2
      ),
      { encoding: "utf8", mode: 0o600 }
    );
    files.push(manifestName);

    const totalBytes = files.reduce((sum, relativePath) => {
      return sum + statSync(path.join(bundlePath, relativePath)).size;
    }, 0);
    insertAuditLog("diagnostics_export", {
      bundlePath,
      fileCount: files.length,
      totalBytes,
      containsSensitiveData: true,
      exportedAt: now.toISOString(),
    });

    return { path: bundlePath, files, containsSensitiveData: true };
  } catch (error) {
    rmSync(bundlePath, { recursive: true, force: true });
    throw error;
  }
}
