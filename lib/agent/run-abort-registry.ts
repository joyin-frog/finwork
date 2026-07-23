/**
 * CR-R2：按 runId 登记执行期 AbortController。
 * SSE 订阅断开不得 abort；只有显式 stop API（或进程退出清理）可终止。
 */

type Entry = {
  controller: AbortController;
  conversationId: number | null;
};

const registry = new Map<string, Entry>();

export function registerRunAbort(
  runId: string,
  controller: AbortController,
  conversationId: number | null = null,
): void {
  // 同 runId 重复登记：先 abort 旧的，避免泄漏
  const prev = registry.get(runId);
  if (prev && prev.controller !== controller && !prev.controller.signal.aborted) {
    prev.controller.abort();
  }
  registry.set(runId, { controller, conversationId });
}

export function unregisterRunAbort(runId: string): void {
  registry.delete(runId);
}

/** @returns true 若找到并触发 abort */
export function abortRunById(runId: string): boolean {
  const entry = registry.get(runId);
  if (!entry) return false;
  if (!entry.controller.signal.aborted) {
    entry.controller.abort();
  }
  return true;
}

export function getActiveRunAbort(runId: string): AbortController | undefined {
  return registry.get(runId)?.controller;
}

export function listActiveRunIds(): string[] {
  return [...registry.keys()];
}

/** 测试用 */
export function _resetRunAbortRegistryForTests(): void {
  registry.clear();
}
