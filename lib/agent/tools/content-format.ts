// 工具输入/输出 → 渲染格式。有语言才高亮;纯文本/命中行/输出兜底不上色。
export type FormattedContent = { lang: string; text: string } | { plain: string };

const HIGHLIGHT_MAX_CHARS = 8000;

function str(o: unknown, k: string): string {
  return o && typeof o === "object" && typeof (o as Record<string, unknown>)[k] === "string"
    ? (o as Record<string, string>)[k] : "";
}

/** JSON 串(且不超长)→ json 高亮;否则纯文本。 */
function sniff(text: string): FormattedContent {
  const t = text.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && t.length <= HIGHLIGHT_MAX_CHARS) {
    try { JSON.parse(t); return { lang: "json", text }; } catch { /* 非 JSON */ }
  }
  return { plain: text };
}

/** 入参:code→python、command→bash、sql→sql,其余对象→json,标量→纯文本。 */
export function formatToolInput(toolName: string, input: unknown): FormattedContent {
  const code = str(input, "code");
  if (code) return code.length <= HIGHLIGHT_MAX_CHARS ? { lang: "python", text: code } : { plain: code.slice(0, HIGHLIGHT_MAX_CHARS) };
  const command = str(input, "command");
  if (command) return { lang: "bash", text: command };
  const sql = str(input, "sql");
  if (sql) return { lang: "sql", text: sql };
  if (input && typeof input === "object") {
    const json = JSON.stringify(input, null, 2);
    return json.length <= HIGHLIGHT_MAX_CHARS ? { lang: "json", text: json } : { plain: json };
  }
  return { plain: String(input ?? "") };
}

/** 输出:shell/搜索类工具的输出是纯文本/命中行,不上色;其余按 JSON 嗅探。 */
export function formatToolOutput(toolName: string, result: string): FormattedContent {
  const name = toolName.replace(/^mcp__\w+__/, "");
  if (!result) return { plain: "" };
  // grep 命中行、Bash stdout、glob 路径、抓取正文都不是某种语言 → 不上色(用户明确要求 grep 输出不高亮)
  if (["Bash", "Grep", "Glob", "WebSearch", "WebFetch"].includes(name)) return { plain: result };
  return sniff(result);
}
