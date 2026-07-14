/**
 * session-trust.ts — run_python 会话级信任存储
 *
 * 进程内、按 (conversationId, toolName) 作用域存储用户主动授权的信任。
 * 重启即失效；子代理调用路径永不写入（trust bypass 以「存在交互确认通道」为前提，见 built-in.ts）。
 *
 * 严禁 node: 前缀导入：本文件会被 ask-user-panel.tsx（客户端组件）直接 import sentinel 常量，
 * 带 node: 依赖会污染客户端 bundle。只用 Web 平台全局（globalThis / Symbol.for / Set）。
 *
 * 参照 lib/knowledge/storage.ts 的 lease registry 写法。
 */

/** 稳定机器 sentinel：用户勾选「本次对话不再询问」后确认执行时提交的答案。
 *  精确匹配（不 trim/lowercase），与 EXPLICIT_CONFIRM_ANSWERS 白名单互不干涉。 */
export const SESSION_TRUST_CONFIRM_ANSWER = "__confirm_trust_session__";

const TRUST_STORE_SYMBOL = Symbol.for("finance-agent.run-python-session-trust");

function getTrustStore(): Set<string> {
  const root = globalThis as typeof globalThis & { [TRUST_STORE_SYMBOL]?: Set<string> };
  return (root[TRUST_STORE_SYMBOL] ??= new Set<string>());
}

function trustKey(conversationId: number, toolName: string): string {
  return `${conversationId}:${toolName}`;
}

/** 对 (conversationId, toolName) 写入信任。conversationId 为 undefined 时无操作（无法作用域）。 */
export function trustToolForConversation(conversationId: number | undefined, toolName: string): void {
  if (conversationId == null) return;
  getTrustStore().add(trustKey(conversationId, toolName));
}

/** 查询 (conversationId, toolName) 是否已被信任。
 *  未知对话或 conversationId 为 undefined 一律返回 false。 */
export function isToolTrustedForConversation(conversationId: number | undefined, toolName: string): boolean {
  if (conversationId == null) return false;
  return getTrustStore().has(trustKey(conversationId, toolName));
}
