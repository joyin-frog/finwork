/**
 * 清理 LLM 输出中的文件链接,避免在没有文件上下文的视图(如观测页)中暴露丑陋的 sandbox:/file: URL。
 *
 * 处理两类:
 * 1. Markdown 链接 `[text](url)` → 只保留 `text`
 * 2. 裸 scheme URL:sandbox: 或 file: 开头后跟一串非空白字符 → 整段移除
 *
 * 注意:URL 里可能含字面括号(如文件名 `公司(2)_...pptx`),所以**不能**用 `\([^)]*\)` 这种
 * 朴素正则——它会在 URL 的第一个 `)` 就截断,把后半段路径当普通文本留下。改用括号配平扫描,
 * 与 CommonMark 解析器(聊天页 ReactMarkdown 走的就是它)对链接 URL 的处理一致。
 */

// 匹配裸 sandbox: 或 file: URL(非空白字符序列;括号非空白,会被一并吃掉)
const BARE_URL_RE = /(?:sandbox:|file:)\S+/g;

/** 把 `[text](url)` 降级为 `text`,URL 内按括号配平找真正的闭合 `)`。 */
function degradeMarkdownLinks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      // 形如 [text]( ,才尝试当链接解析
      if (close !== -1 && text[close + 1] === "(") {
        let depth = 1;
        let j = close + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") depth--;
          if (depth === 0) break;
          j++;
        }
        if (depth === 0) {
          // 合法链接:只保留 link text,跳过整个 (url)
          out += text.slice(i + 1, close);
          i = j + 1;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

export function stripFileLinks(text: string): string {
  if (!text) return text;
  // 先把 markdown 链接展开为纯文本(URL 按括号配平,能处理路径里的字面括号)
  let result = degradeMarkdownLinks(text);
  // 再清除残留的裸 scheme URL
  result = result.replace(BARE_URL_RE, "");
  return result;
}
