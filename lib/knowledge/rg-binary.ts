import { rgPath } from "@vscode/ripgrep";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProjectRoot } from "@/lib/runtime/paths";

/**
 * 解析 ripgrep 二进制路径(不再裸 spawn("rg") 依赖系统安装)。
 * 1) env 覆盖;2) 打包资源 bin/(prepare-tauri 拷入,生产态);3) @vscode/ripgrep 预编译(开发态)。
 */
export function getRgPath(): string {
  if (process.env.FINANCE_AGENT_RG_PATH) return process.env.FINANCE_AGENT_RG_PATH;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const bundled = path.join(getProjectRoot(), "bin", exe);
  if (existsSync(bundled)) return bundled;
  return rgPath;
}
