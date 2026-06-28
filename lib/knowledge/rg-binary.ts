import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getProjectRoot } from "@/lib/runtime/paths";

// @vscode/ripgrep 按平台用 optionalDependencies 分发二进制,其 index 在被 require 时就解析平台包
// (找不到即抛 "Could not find @vscode/ripgrep-win32-x64")。standalone 打包不含该平台包,故顶层
// 静态 import 会在 Windows 上一加载就抛、连带 import 它的整条路由 500(表现为"网络错误")。
// 改为惰性解析:生产态命中打包 bin/ 先返回,永不触达该包。
const lazyRequire = createRequire(import.meta.url);

/**
 * 解析 ripgrep 二进制路径(不再裸 spawn("rg") 依赖系统安装)。
 * 1) env 覆盖;2) 打包资源 bin/(prepare-tauri 拷入,生产态);3) @vscode/ripgrep 预编译(开发态)。
 */
export function getRgPath(): string {
  if (process.env.FINANCE_AGENT_RG_PATH) return process.env.FINANCE_AGENT_RG_PATH;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const bundled = path.join(getProjectRoot(), "bin", exe);
  if (existsSync(bundled)) return bundled;
  // 开发态回退:打包资源不存在时才用 npm 预编译二进制。require 失败(如平台包缺失)给出可读错误,
  // 而不是把底层 "Could not find @vscode/ripgrep-…" 直接抛给上层。
  try {
    return (lazyRequire("@vscode/ripgrep") as { rgPath: string }).rgPath;
  } catch (e) {
    throw new Error(
      `找不到 ripgrep 二进制:打包资源 ${bundled} 不存在,且 @vscode/ripgrep 不可用(${e instanceof Error ? e.message : String(e)})。`
    );
  }
}
