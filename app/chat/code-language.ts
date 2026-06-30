/** 从 <code> 的 className(如 "language-python hljs")里取语言名;取不到返回 null。
 *  允许字母数字下划线 + # - 等(覆盖 c++ / c# / objective-c 等),供代码块右上角语言标签用。 */
export function parseCodeLanguage(className: string | undefined | null): string | null {
  if (!className) return null;
  const match = /language-([\w+#-]+)/.exec(className);
  return match ? match[1] : null;
}
