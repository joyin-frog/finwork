/**
 * error-detail.ts — 纯函数，清洗工具错误详情的展示文本。
 *
 * 职责：
 * 1. 剥 <tool_use_error>…</tool_use_error> XML 包裹；
 * 2. 内容为合法 JSON（或 JSON 字符串双重编码）则 pretty-print（2 空格）；
 * 3. MCP -32602 类校验错误提取数组中首个 message 字段作为 headline；
 * 4. 其余情形 headline = body = 原文（或剥壳后文本）。
 */

/** 剥壳结果：headline 用于行摘要，body 用于展开详情。 */
export type ErrorDetail = { headline: string; body: string };

/** 尝试将字符串解析为 JSON（支持双重 JSON.stringify 编码）。成功返回解析后对象，失败返回 null。 */
function tryParseJson(text: string): unknown | null {
  try {
    const parsed = JSON.parse(text);
    // 双重编码：inner 可能是再一次 JSON.stringify 的字符串
    if (typeof parsed === "string") {
      try {
        return JSON.parse(parsed);
      } catch {
        return parsed; // 内层不是 JSON，返回已解析的字符串
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 从 MCP -32602 校验错误字符串里提取 JSON 负载（数组或对象）。
 * 格式：`MCP error -32602: Input validation error: Invalid arguments for tool <name>: <json>`
 */
function extractMcpValidationJson(text: string): unknown | null {
  // 找到 -32602 后，截取最后一段 JSON（以 [ 或 { 开头）
  const idx = text.indexOf("-32602");
  if (idx === -1) return null;
  const after = text.slice(idx);
  const jsonStart = after.search(/[\[{]/);
  if (jsonStart === -1) return null;
  return tryParseJson(after.slice(jsonStart));
}

/** 从已解析的 JSON 值里提取首个 message 字段。支持数组（取 [0].message）或对象（取 .message）。 */
function extractFirstMessage(parsed: unknown): string | null {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object" && "message" in item) {
        const msg = (item as Record<string, unknown>).message;
        if (typeof msg === "string") return msg;
      }
    }
    return null;
  }
  if (parsed && typeof parsed === "object" && "message" in parsed) {
    const msg = (parsed as Record<string, unknown>).message;
    return typeof msg === "string" ? msg : null;
  }
  return null;
}

export function cleanErrorDetail(raw: string): ErrorDetail {
  // ── 1. 剥 <tool_use_error> XML 包裹 ──
  let text = raw;
  const xmlMatch = raw.match(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/);
  if (xmlMatch) {
    text = xmlMatch[1].trim();
  }

  // ── 2. MCP -32602 校验错误优先处理 ──
  if (raw.includes("-32602")) {
    const parsed = extractMcpValidationJson(text.length < raw.length ? raw : text);
    if (parsed != null) {
      const pretty = JSON.stringify(parsed, null, 2);
      const msg = extractFirstMessage(parsed);
      const headline = msg ?? `MCP 校验错误`;
      return { headline, body: pretty };
    }
  }

  // ── 3. 尝试 pretty-print JSON ──
  const parsed = tryParseJson(text);
  if (parsed != null && typeof parsed !== "string") {
    const pretty = JSON.stringify(parsed, null, 2);
    const msg = extractFirstMessage(parsed);
    return { headline: msg ?? text, body: pretty };
  }
  // parsed 为字符串（双重编码剥壳结果）
  if (parsed != null && typeof parsed === "string") {
    const inner = tryParseJson(parsed);
    if (inner != null) {
      const pretty = JSON.stringify(inner, null, 2);
      const msg = extractFirstMessage(inner);
      return { headline: msg ?? parsed, body: pretty };
    }
    return { headline: parsed, body: parsed };
  }

  // ── 4. 纯文本兜底 ──
  return { headline: text, body: text };
}
