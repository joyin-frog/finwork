/** 落库/发给 Agent 的文件夹路径行前缀;UI 会解析成卡片,不直接当气泡正文展示。 */
export const FOLDER_PATH_LINE_PREFIX = "文件夹路径:";

/**
 * 选文件夹后把本地绝对路径格式化成一行(随消息发给 Agent)。
 * 空/纯空白路径返回 ""。
 */
export function formatFolderPathLine(folderPath: string): string {
  const p = folderPath.trim();
  if (!p) return "";
  return `${FOLDER_PATH_LINE_PREFIX}${p}`;
}

/** 从绝对路径取文件夹名(末段);Windows/POSIX 都认。 */
export function folderNameFromPath(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

/**
 * 从消息正文拆出「文件夹路径:」行 → 卡片数据 + 剩余正文。
 * 历史会话里只有路径文案的,也能升级成文件夹卡。
 */
export function splitFolderPathLines(content: string): {
  folders: Array<{ path: string; name: string }>;
  text: string;
} {
  const folders: Array<{ path: string; name: string }> = [];
  const seen = new Set<string>();
  const other: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith(FOLDER_PATH_LINE_PREFIX)) {
      const p = line.slice(FOLDER_PATH_LINE_PREFIX.length).trim();
      if (p && !seen.has(p)) {
        seen.add(p);
        folders.push({ path: p, name: folderNameFromPath(p) });
      }
      continue;
    }
    other.push(line);
  }
  return { folders, text: other.join("\n").replace(/^\n+|\n+$/g, "") };
}
