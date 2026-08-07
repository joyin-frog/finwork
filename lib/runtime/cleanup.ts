import { readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLEANUP_AFTER_MS = 3600_000; // 1h
const STALE_MAX_MS = 86400_000; // 24h

/**
 * Schedule a directory for deferred cleanup.
 * Currently a no-op — cleanup happens at startup via purgeStaleOutputDirs.
 */
export function scheduleCleanup(_outputDir: string, _delayMs: number = CLEANUP_AFTER_MS): void {
  // Deferred cleanup is best-effort. Stale dirs are cleaned on next startup.
}

/**
 * Remove os.tmpdir()/finance-agent-output-* fallback dirs older than maxAgeMs.
 * (旧版本在无会话 outputDir 时落 tmpdir；这些目录没人引用，可安全清理。)
 * Called at startup to prevent tmpdir accumulation.
 *
 * ⚠ 只清 tmpdir 回落目录。会话内 <files>/<conv>/generate 是持久产物——已登记进
 * chat_attachments、由 /api/files 与文件库长期供文件,绝不能按 mtime 清理。
 */
export function purgeStaleOutputDirs(maxAgeMs: number = STALE_MAX_MS, tmpRoot: string = os.tmpdir()): void {
  try {
    const now = Date.now();
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(tmpRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("finance-agent-output-")) continue;
      const fullPath = path.join(tmpRoot, entry.name);
      try {
        if (now - statSync(fullPath).mtimeMs > maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Directory disappeared or not accessible — skip
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
