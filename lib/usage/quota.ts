// 用量配额·纯计算层(无 IO、无时钟):所有窗口/加权/档位逻辑集中于此,便于单测。
// 设计见 docs/spec/spec-usage-limit.md。时钟以 `now` 入参注入,绝不内部调 Date.now()。

// ── 写死的配置常量(用户不可调;调限额改这里) ─────────────────────────────
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 计费 token 上限(成本加权后,以"推理档 input token"为单位 1.0) */
export const FIVE_HOUR_LIMIT = 10_000_000; // 1000 万
export const WEEK_LIMIT = 50_000_000; // 5000 万

/** token 类型权重(贴合官方价比例,相对同模型 input):output≈5×、cache 写≈1.25×、cache 读≈0.1× */
const OUTPUT_WEIGHT = 5.0;
const CACHE_WRITE_WEIGHT = 1.25;
const CACHE_READ_WEIGHT = 0.1;

/** 快档(router 类轻模型)相对推理档基准 1.0 的成本系数。Haiku≈Opus/Sonnet 的 1/3~1/12,取保守中值。 */
export const FAST_WEIGHT = 0.3;

export type RoleModels = {
  routerModel?: string;
  mainModel?: string;
  subagentModel?: string;
};

export type ModelTokens = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type UsageTrace = {
  /** epoch ms */
  startedAt: number;
  models: ModelTokens[];
};

export type WindowUsage = {
  /** 原始计费 token 累计(未 clamp,供超限判定) */
  used: number;
  /** 展示用百分比,clamp 到 [0,100] */
  pct: number;
  /** 重置时刻 epoch ms = 窗口起点 + 时长 */
  resetAt: number;
};

/** 模型名归档:命中 router 槽 → 快档;其余(含未知/对不上任何槽)→ 推理(贵)档。偏保守。 */
export function classifyTier(model: string, roles: RoleModels): "fast" | "reasoning" {
  return matchesSlot(model, roles.routerModel) ? "fast" : "reasoning";
}

/** 槽名为空一律不命中;否则双向子串匹配,容忍网关返回的限定名与配置名略有出入。 */
function matchesSlot(model: string, slot: string | undefined): boolean {
  const s = (slot ?? "").trim();
  const m = (model ?? "").trim();
  if (!s || !m) return false;
  return m === s || m.includes(s) || s.includes(m);
}

function tierWeight(model: string, roles: RoleModels): number {
  return classifyTier(model, roles) === "fast" ? FAST_WEIGHT : 1.0;
}

/** 单条 trace 的成本加权计费 token:逐模型分档,token 类型按成本比折算后求和。 */
export function billableTokensForTrace(trace: UsageTrace, roles: RoleModels): number {
  let total = 0;
  for (const m of trace.models) {
    const raw =
      (m.inputTokens ?? 0) +
      OUTPUT_WEIGHT * (m.outputTokens ?? 0) +
      CACHE_WRITE_WEIGHT * (m.cacheCreationTokens ?? 0) +
      CACHE_READ_WEIGHT * (m.cacheReadTokens ?? 0);
    total += tierWeight(m.model, roles) * raw;
  }
  return total;
}

/** 懒锚定:无窗口或已过期(到点含)→ 锚定为 now;否则保持原起点。 */
export function nextWindowStart(windowStart: number | null, now: number, durationMs: number): number {
  if (windowStart == null) return now;
  if (now >= windowStart + durationMs) return now;
  return windowStart;
}

function computeWindow(
  traces: UsageTrace[],
  windowStart: number,
  durationMs: number,
  limit: number,
  roles: RoleModels,
): WindowUsage {
  let used = 0;
  for (const t of traces) {
    if (t.startedAt >= windowStart) used += billableTokensForTrace(t, roles);
  }
  const pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  return { used, pct, resetAt: windowStart + durationMs };
}

export type UsageResult = {
  fivehour: WindowUsage;
  week: WindowUsage;
  /** 任一窗口达到上限即拦截 */
  blocked: boolean;
  /** 重锚后的窗口起点(供调用方持久化;请求路径写回,展示路径忽略) */
  start5h: number;
  startWeek: number;
};

/**
 * 计算两窗口用量与拦截状态。内部对过期窗口懒重锚(返回 start5h/startWeek 供持久化)。
 * 纯函数:traces / now / 已存窗口起点 全部入参。
 */
export type BlockedNotice = {
  /** 触发拦截的窗口 */
  window: "5h" | "week";
  resetAt: number;
  /** 渲染在对话正文的红字文案 */
  message: string;
};

/** 未拦截返回 null;拦截时取"先满"的窗口(5h 优先)给出恢复时刻与文案。 */
export function buildBlockedNotice(result: UsageResult): BlockedNotice | null {
  if (!result.blocked) return null;
  const fiveOver = result.fivehour.used >= FIVE_HOUR_LIMIT;
  const window: "5h" | "week" = fiveOver ? "5h" : "week";
  const resetAt = fiveOver ? result.fivehour.resetAt : result.week.resetAt;
  return { window, resetAt, message: `本周期用量已达上限，将于 ${formatResetAt(resetAt, window)} 恢复，可稍后再试。` };
}

/** 5h 窗口给"时:分",周窗口给"X月X日"(用本地时区)。 */
export function formatResetAt(resetAt: number, window: "5h" | "week"): string {
  const d = new Date(resetAt);
  return window === "5h"
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

export function computeUsage(args: {
  traces: UsageTrace[];
  now: number;
  storedStart5h: number | null;
  storedStartWeek: number | null;
  roles: RoleModels;
}): UsageResult {
  const { traces, now, storedStart5h, storedStartWeek, roles } = args;
  const start5h = nextWindowStart(storedStart5h, now, FIVE_HOUR_MS);
  const startWeek = nextWindowStart(storedStartWeek, now, WEEK_MS);

  const fivehour = computeWindow(traces, start5h, FIVE_HOUR_MS, FIVE_HOUR_LIMIT, roles);
  const week = computeWindow(traces, startWeek, WEEK_MS, WEEK_LIMIT, roles);

  return {
    fivehour,
    week,
    blocked: fivehour.used >= FIVE_HOUR_LIMIT || week.used >= WEEK_LIMIT,
    start5h,
    startWeek,
  };
}
