import path from "node:path";

/** conversationId 必为正整数(数据库行 id);任何 ../ 或非数字一律拒绝。 */
export function isValidConversationId(id: string): boolean {
  return /^[1-9][0-9]*$/.test(id);
}

export function isAllowedAppPath(app: string): boolean {
  if (app === "__choose__") return true; // Windows "打开方式" 对话框
  if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    return (
      app.startsWith("/Applications/") ||
      app.startsWith("/System/Applications/") ||
      (home !== "" && app.startsWith(path.join(home, "Applications") + path.sep))
    );
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "";
    const prefixes = [localAppData, programFiles, programFilesX86].filter(Boolean);
    return prefixes.some((prefix) => app.startsWith(prefix + path.sep));
  }
  return false; // 其它平台暂不接受自定义 app 路径，回落系统默认打开方式
}
