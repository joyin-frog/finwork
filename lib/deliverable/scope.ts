import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type ScopeCheck =
  | { ok: true; absolutePath: string; realPath: string }
  | { ok: false; code: string; message: string };

/**
 * 规范化并校验候选路径落在 output scope 内：
 * - basename-only 或相对路径相对于 outputDir
 * - 拒绝 traversal / symlink escape
 */
export function resolveInOutputScope(outputDir: string, nameOrPath: string): ScopeCheck {
  const outputRoot = path.resolve(outputDir);
  const base = path.basename(String(nameOrPath).trim());
  if (!base || base === "." || base === "..") {
    return { ok: false, code: "invalid_name", message: "无效文件名" };
  }
  // 模型只允许 basename；若传入含分隔符的路径，一律裁成 basename（防穿越声明）
  const candidate = path.resolve(outputRoot, base);

  if (!isInsideDir(candidate, outputRoot)) {
    return { ok: false, code: "path_escape", message: "文件路径超出 Run 输出范围" };
  }

  if (!existsSync(candidate)) {
    return { ok: false, code: "file_not_found", message: `文件不存在: ${base}` };
  }

  let st;
  try {
    st = lstatSync(candidate);
  } catch {
    return { ok: false, code: "file_not_found", message: `无法访问文件: ${base}` };
  }

  if (st.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return { ok: false, code: "symlink_escape", message: "无法解析符号链接" };
    }
    if (!isInsideDir(real, outputRoot)) {
      return { ok: false, code: "symlink_escape", message: "符号链接指向输出目录外" };
    }
    const realSt = statSync(real);
    if (!realSt.isFile()) {
      return { ok: false, code: "not_a_file", message: "目标不是普通文件" };
    }
    if (realSt.size <= 0) {
      return { ok: false, code: "empty_file", message: "文件大小为零" };
    }
    return { ok: true, absolutePath: candidate, realPath: real };
  }

  if (st.isDirectory()) {
    return { ok: false, code: "is_directory", message: "不能交付目录" };
  }
  if (!st.isFile()) {
    return { ok: false, code: "not_a_file", message: "目标不是普通文件" };
  }
  if (st.size <= 0) {
    return { ok: false, code: "empty_file", message: "文件大小为零" };
  }

  return { ok: true, absolutePath: candidate, realPath: candidate };
}

export function isInsideDir(target: string, root: string): boolean {
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(root);
  return absTarget === absRoot || absTarget.startsWith(absRoot + path.sep);
}

/** Run 专属不可变交付目录：会话根下 delivered/<runId>/（与 generate/ 同级，模型写工具不可达）。 */
export function getDeliveredDir(conversationFilesDir: string, runId: string): string {
  const safeRun = runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "run";
  return path.join(path.resolve(conversationFilesDir), "delivered", safeRun);
}

/** 由 generate outputDir 推导会话文件根。 */
export function conversationDirFromOutputDir(outputDir: string): string {
  const resolved = path.resolve(outputDir);
  const base = path.basename(resolved);
  if (base === "generate") return path.dirname(resolved);
  return resolved;
}

export function isDeliveredStoragePath(storagePath: string): boolean {
  const norm = storagePath.split(path.sep).join("/");
  return norm === "delivered" || norm.startsWith("delivered/");
}
