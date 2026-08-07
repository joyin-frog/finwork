import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * 在途 Pi session 注册表（L6a）——「运行中插话」的落点。
 *
 * ## 为什么不是 `design-pi-live-session.md` 里那套「session 活过 HTTP 回合」
 *
 * 那份设计给长活 session 列了三条收益，核实后只剩一条半：
 *
 * - **compaction 连续性**：不成立。`SessionManager.appendCompaction()` 把压缩条目写进
 *   JSONL，重开 session 即恢复——已核实 pi 源码。
 * - **免掉每回合 `loader.reload()` / 重注册 provider**：真实，但不需要长活 session，
 *   按装配指纹缓存 ModelRuntime 与 ResourceLoader 就够（见 `provider.ts` / `resource-loader.ts`）。
 * - **运行中插话**：真实，但插话的语义是「往**正在跑**的 session 注入消息」。回合结束后
 *   那个 session 已经 idle，没有什么可插。所以需要的是**在途**注册表，不是跨回合持有。
 *
 * 而跨回合持有的代价很重：`emit`、`traceId`、`resolveUserQuestion`、`onSubagentEvent`
 * 全部要改成经可变「当前回合上下文」间接引用。这条路径每条消息都走，一旦指向错了，
 * 事件就会串进**另一个会话的 SSE 流**——财务应用里的跨会话泄漏。收益既然都能用更小的
 * 改动拿到，就不该在热路径上冒这个险。
 *
 * ## 边界
 *
 * 与 `pending-questions.ts` / `session-trust.ts` 同构：挂 `globalThis`，**仅支持单进程
 * 部署**（Tauri sidecar / next start）。条目在回合开始时登记、`finally` 里注销，
 * 因此表内只会有正在跑的会话，不会有泄漏残留。
 */

type LiveEntry = {
  conversationId: number;
  session: AgentSession;
  traceId: string;
  startedAt: number;
};

const STORE_SYMBOL = Symbol.for("finwork.pi.liveSessions");

function getStore(): Map<number, LiveEntry> {
  const root = globalThis as typeof globalThis & { [STORE_SYMBOL]?: Map<number, LiveEntry> };
  root[STORE_SYMBOL] ??= new Map();
  return root[STORE_SYMBOL];
}

export type LiveSessionHandle = { release: () => void };

/**
 * 登记一个正在跑的 session。
 *
 * 同一 conversationId 已有在途条目时**覆盖**并返回句柄——不抛错：并发两个回合是 Query
 * 层该管的事（那里有 run 级去重），这里只保证「表里的条目指向最新那次运行」，
 * 否则插话会打进一个已经结束的 session。
 */
export function registerLiveSession(
  conversationId: number | null | undefined,
  session: AgentSession,
  traceId: string,
): LiveSessionHandle {
  if (conversationId == null) return { release: () => {} };
  const store = getStore();
  const entry: LiveEntry = { conversationId, session, traceId, startedAt: Date.now() };
  store.set(conversationId, entry);
  return {
    release: () => {
      // 只删自己那条：回合 B 覆盖了条目之后，回合 A 的 finally 不该把 B 删掉。
      if (store.get(conversationId) === entry) store.delete(conversationId);
    },
  };
}

/** 该会话是否有正在跑的回合。 */
export function isConversationRunning(conversationId: number): boolean {
  return getStore().has(conversationId);
}

/**
 * 插话：打断当前助手轮，让它读到新指令后继续。
 *
 * 返回 false 表示该会话当前没有在途运行——调用方应按「起新回合」处理。
 */
export async function steerConversation(conversationId: number, text: string): Promise<boolean> {
  const entry = getStore().get(conversationId);
  if (!entry) return false;
  await entry.session.steer(text);
  return true;
}

/** 排队追加：等当前回合自然跑完再投递，不打断。 */
export async function followUpConversation(conversationId: number, text: string): Promise<boolean> {
  const entry = getStore().get(conversationId);
  if (!entry) return false;
  await entry.session.followUp(text);
  return true;
}

/** 仅供测试与诊断：当前在途会话数。 */
export function liveSessionCount(): number {
  return getStore().size;
}

/** 仅供测试：清空注册表。 */
export function _resetLiveSessionsForTest(): void {
  getStore().clear();
}
