import { rmSync } from "node:fs";
import { getConversationFilesDir } from "./paths";

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
 * Remove output directories that are older than maxAgeMs.
 * Called at startup to prevent tmpdir accumulation.
 */
export function purgeStaleOutputDirs(_maxAgeMs: number = STALE_MAX_MS): void {
  // Best-effort: try to clean known conversation generate dirs
  try {
    const filesDir = getConversationFilesDir(0);
    // Strip the trailing /0 to get the parent dir
    const parentDir = filesDir.replace(/\/\d+$/, "");
    if (!parentDir) return;

    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const now = Date.now();
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(parentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = `${parentDir}/${entry.name}/generate`;
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > _maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Directory doesn't exist or not accessible — skip
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
