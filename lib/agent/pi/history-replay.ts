import type { AgentMessage } from "@/lib/agent/contracts";

/**
 * 历史回放（L3b）。
 *
 * 取代 `fallbackFlatRecap`：那个做法把整段历史压成
 * `<对话回顾>\n用户:…\n助手:…\n</对话回顾>\n\n当前请求:\n…` 塞进**一条 user 消息**。
 * 三个问题：
 *
 * 1. **可伪造边界**。内容是裸插值的，消息里出现 `</对话回顾>` 就能提前闭合，把伪造的
 *    「当前请求」排在真请求前面。实测可复现。更要紧的是助手消息——发票 PDF 抽出的文本
 *    可能被助手复述过，于是外部内容不经 `wrapExternalContext` 就进了提示词。
 * 2. **角色归属丢失**。模型只看到一条用户消息里有份对话记录，分不清「助手说过」和
 *    「用户声称助手说过」。
 * 3. **pi 的压缩看不懂**。它是一坨不透明文本，compaction 无法按消息粒度取舍。
 *
 * 改成经 `context` 钩子注入真消息：用户轮就是 `user` 消息（本来就是用户说的，无需转义）；
 * 助手轮用 `custom`——它是**回放的历史**，不是本 session 模型说过的话，冒充 assistant
 * 既要编造 usage/stopReason，也不诚实。
 *
 * 只在「有 Finwork 聊天记录但还没有 pi session」时用（旧会话、或 session 文件被清理后）。
 * 正常续聊走 pi 自己的 session 恢复，根本不经过这里。
 */

/** pi 侧消息的最小结构；避免在边界外 import Pi 类型。 */
export type ReplayMessage =
  | { role: "user"; content: string }
  | { role: "custom"; customType: string; content: string; display: boolean };

export const REPLAY_CUSTOM_TYPE = "finwork-history";

export function buildReplayMessages(history: AgentMessage[]): ReplayMessage[] {
  const out: ReplayMessage[] = [];
  for (const message of history) {
    const content = message.content?.trim();
    if (!content) continue;
    if (message.role === "user") {
      out.push({ role: "user", content });
    } else {
      out.push({
        role: "custom",
        customType: REPLAY_CUSTOM_TYPE,
        content,
        // 不进 TUI/前端渲染：这是重放的旧内容，重复显示会让人以为又说了一遍。
        display: false,
      });
    }
  }
  return out;
}
