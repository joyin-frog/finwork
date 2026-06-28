// 工具调用事件追踪:按 tool_use_id 配对 tool_use 与 tool_result。
// 统一两条结果通道:内置工具(user 消息里的 tool_result 块)与 MCP 工具
// (assistant 消息里的 mcp_tool_result 块),并对同一 tool_use_id 去重。

export type ToolResultBlockLike = {
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type TrackedToolResult = {
  toolUseId: string;
  name: string;
  input: unknown;
  content?: string;
  isError: boolean;
  durationMs: number;
  structured?: unknown;
};

export function createToolEventTracker() {
  const pending = new Map<string, { name: string; input: unknown; startTime: number }>();
  const handled = new Set<string>();

  function trackToolUse(block: { id?: string; name: string; input?: unknown }) {
    if (!block.id) return;
    pending.set(block.id, { name: block.name, input: block.input, startTime: Date.now() });
  }

  /** 返回配对成功的结果;重复或未登记的 tool_use_id 返回 null(如 subagent 内部调用)。 */
  function resolveToolResult(block: ToolResultBlockLike, toolUseResult?: unknown): TrackedToolResult | null {
    const toolUseId = block.tool_use_id;
    if (!toolUseId || handled.has(toolUseId)) return null;
    const use = pending.get(toolUseId);
    if (!use) return null;
    handled.add(toolUseId);
    pending.delete(toolUseId);
    return {
      toolUseId,
      name: use.name,
      input: use.input,
      content: stringifyToolResult(block.content),
      isError: Boolean(block.is_error),
      durationMs: Date.now() - use.startTime,
      structured: extractStructuredContent(toolUseResult, block)
    };
  }

  return { trackToolUse, resolveToolResult };
}

/** 从 SDK user 消息中提取 tool_result 块(形状防御式,提取不到返回空数组)。 */
export function extractUserToolResults(message: { message?: { content?: unknown } }): ToolResultBlockLike[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ToolResultBlockLike & { type: "tool_result" } =>
      Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "tool_result"
  );
}

/** structuredContent 透传:优先取 SDK 顶层 tool_use_result,其次取结果块自身;均无则 undefined。 */
export function extractStructuredContent(...sources: unknown[]): unknown {
  for (const source of sources) {
    if (source && typeof source === "object" && "structuredContent" in source) {
      const structured = (source as { structuredContent?: unknown }).structuredContent;
      if (structured != null) return structured;
    }
  }
  return undefined;
}

export function stringifyToolResult(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n") || undefined;
  }
  if (content == null) return undefined;
  try { return JSON.stringify(content); } catch { return String(content); }
}
