import { randomUUID } from "node:crypto";
import type { AgentQuestion } from "./claude-adapter";

// 挂起的用户确认/提问:agent 在 SSE 流中下发问题后在此等待,
// 前端通过 POST /api/agent/answer 应答。Map 挂在 globalThis 上,
// 防止 Next dev 多模块实例导致 answer 路由 resolve 不到 query 路由的 promise。
// 注意:仅支持单进程部署(Tauri sidecar / next start)。

type PendingQuestion = {
  id: string;
  traceId: string;
  question: AgentQuestion;
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function getStore(): Map<string, PendingQuestion> {
  const holder = globalThis as { __financePendingQuestions?: Map<string, PendingQuestion> };
  holder.__financePendingQuestions ??= new Map();
  return holder.__financePendingQuestions;
}

/** 创建挂起问题;超时自动以空串 resolve(下游按"未确认"处理)。 */
export function createPendingQuestion(
  traceId: string,
  question: AgentQuestion,
  timeoutMs = DEFAULT_TIMEOUT_MS
): { id: string; promise: Promise<string> } {
  const id = randomUUID();
  let resolveFn!: (answer: string) => void;
  const promise = new Promise<string>((resolve) => { resolveFn = resolve; });
  const timer = setTimeout(() => { settle(id, ""); }, timeoutMs);
  timer.unref?.();
  getStore().set(id, { id, traceId, question, resolve: resolveFn, timer, createdAt: Date.now() });
  return { id, promise };
}

/** 应答挂起问题;未知/已结清的 id 返回 false,不抛错。 */
export function answerPendingQuestion(id: string, answer: string): boolean {
  return settle(id, answer);
}

/** 结清某次请求名下的全部挂起问题(请求中断/结束时调用),按"未确认"处理。 */
export function cancelPendingQuestions(traceId: string): void {
  for (const pending of [...getStore().values()]) {
    if (pending.traceId === traceId) settle(pending.id, "");
  }
}

function settle(id: string, answer: string): boolean {
  const store = getStore();
  const pending = store.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  store.delete(id);
  pending.resolve(answer);
  return true;
}
