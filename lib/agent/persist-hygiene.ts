/**
 * 持久化卫生:持久化端噪声过滤 + 单回合事件数硬上限
 *
 * emit 层(claude-adapter.ts isMeaningfulSystemEvent)已是第一道闸;
 * 本模块是纵深防御第二道闸,防任何路径绕过 emit 过滤的事件洪泛灌库。
 * 历史教训:会话 38 单回合 5384 thinking_tokens 噪声事件 / 1.5MB。
 */

/** 持久化时丢弃的 system 子类型(纯噪声/进度 token,非内容/计时/审计)。 */
export const DROP_SYSTEM_SUBTYPES = new Set(["thinking_tokens", "status"]);

/**
 * 每回合最多持久化的事件数。正常回合远低于此(实测 ~100 以内);
 * 只在异常洪泛时兜底截断。若未来正常事件数逼近 500 再上调。
 */
export const MAX_EVENTS_PER_TURN = 500;

type AnyEvent = { type: string; [k: string]: unknown };

/**
 * 过滤掉噪声 system 事件,并对单回合事件总数设硬上限。
 *
 * - 保留:tool_use / tool_result / text / ask_user* / system(init / compact_boundary / turn_duration)
 * - 丢弃:system(thinking_tokens / status)
 * - 超过 MAX_EVENTS_PER_TURN 时截断并 warn
 */
export function sanitizeTurnEvents(events: AnyEvent[]): AnyEvent[] {
  const kept = events.filter((e) => {
    if (e.type !== "system") return true;
    return !DROP_SYSTEM_SUBTYPES.has(String((e as { subtype?: unknown }).subtype ?? ""));
  });
  if (kept.length > MAX_EVENTS_PER_TURN) {
    console.warn("[persist] turn events capped", { kept: kept.length, cap: MAX_EVENTS_PER_TURN });
    return kept.slice(0, MAX_EVENTS_PER_TURN);
  }
  return kept;
}
