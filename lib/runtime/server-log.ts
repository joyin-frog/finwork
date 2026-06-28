// 服务端错误/事件落地到磁盘日志,解决"Application error: server-side exception + Digest"无处可查的问题。
// 打包态 Tauri 把 node 子进程的 stdout/stderr 丢弃了(见 src-tauri/src/lib.rs),控制台报错的
// "see the server logs" 根本没落地;这里把错误连同 digest 写进 <appData>/logs/server-<date>.log,
// 用户把该文件发来即可定位。所有写入都是 best-effort,绝不抛(日志失败不能拖垮请求)。

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getAppDataDir } from "@/lib/runtime/paths";

export type ServerErrorContext = {
  path?: string;
  method?: string;
  digest?: string;
  /** routerKind / routePath / renderSource 等附加上下文 */
  extra?: string;
};

/** 纯函数:把错误 + 上下文格式化成一条日志文本(便于单测,不触磁盘)。 */
export function formatServerError(error: unknown, context: ServerErrorContext = {}): string {
  const err = error as { message?: string; stack?: string; digest?: string } | undefined;
  const digest = context.digest ?? err?.digest;
  const head = [
    "[server-error]",
    context.method && context.path ? `${context.method} ${context.path}` : context.path,
    digest ? `digest=${digest}` : undefined,
    context.extra && context.extra.trim() ? `(${context.extra.trim()})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const body = err?.stack || err?.message || String(error);
  return `${head}\n${body}`;
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getAppDataDir(), "logs", `server-${date}.log`);
}

/** 追加一行(可多行)到当日服务端日志。绝不抛。 */
export async function appendServerLog(line: string): Promise<void> {
  try {
    const file = logFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch {
    // best-effort:日志写入失败也不能影响主流程
  }
}

/** 记录一次服务端错误(含 Next 的 digest),写入当日日志文件。 */
export async function logServerError(error: unknown, context: ServerErrorContext = {}): Promise<void> {
  await appendServerLog(formatServerError(error, context));
}
