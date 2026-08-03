import path from "node:path";

/**
 * 文件路径策略的单一真相。
 *
 * 历史上这些判据私有在 `hooks/built-in.ts` 里，只服务 Claude SDK 时代的
 * `Write`/`Edit`/`Read` 内置工具名。Pi 的内置工具叫 `write`/`edit`/`read`，
 * 入参是 `path` 而不是 `file_path`——名字和形状都不同。抽到这里让两边共用同一份
 * 判据，而不是各写一套。
 */

export function isInsidePath(filePath: string, rootPath: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootPath);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
}

/** delivered/ 与 generate/ 同级；也拒绝对 outputDir 内误建的 delivered 子路径写入。 */
export function isDeliveredPath(filePath: string, outputDir: string): boolean {
  const abs = path.resolve(filePath);
  const parts = abs.split(path.sep);
  if (parts.includes("delivered")) return true;
  const genParent = path.dirname(path.resolve(outputDir));
  const deliveredRoot = path.join(genParent, "delivered");
  return abs === deliveredRoot || abs.startsWith(deliveredRoot + path.sep);
}
