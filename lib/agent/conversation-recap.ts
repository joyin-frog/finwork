import type { AgentMessage } from "./contracts";

/**
 * 新 Pi session 首轮使用的确定性历史回顾。
 * 已恢复的 Pi session 只发送当前用户消息，不重复注入历史。
 */
export function fallbackFlatRecap(
  history: AgentMessage[],
  lastPromptText: string,
): string {
  const recap = history.length
    ? `<对话回顾>\n${history
        .map((message) => `${message.role === "user" ? "用户" : "助手"}:${message.content}`)
        .join("\n")}\n</对话回顾>\n\n当前请求:\n`
    : "";
  return `${recap}${lastPromptText}`;
}
