import assert from "node:assert/strict";
import {
  classifyTier,
  billableTokensForTrace,
  nextWindowStart,
  computeUsage,
  buildBlockedNotice,
  FIVE_HOUR_MS,
  WEEK_MS,
  FIVE_HOUR_LIMIT,
  WEEK_LIMIT,
  FAST_WEIGHT,
  type RoleModels,
  type UsageTrace,
} from "../lib/usage/quota";

const { equal, ok } = assert;

export const usageQuotaTestPromise = (async () => {
  const roles: RoleModels = {
    routerModel: "claude-haiku-4-5",
    mainModel: "claude-opus-4-8",
    subagentModel: "claude-sonnet-4-6",
  };

  // ── T1: 档位判定 ────────────────────────────────────────────────
  {
    equal(classifyTier("claude-haiku-4-5", roles), "fast", "T1 FAIL: router 槽模型应为快档");
    equal(classifyTier("claude-opus-4-8", roles), "reasoning", "T1 FAIL: 主模型应为推理档");
    equal(classifyTier("claude-sonnet-4-6", roles), "reasoning", "T1 FAIL: subagent 应为推理档");
    equal(classifyTier("some-unknown-gateway-model", roles), "reasoning", "T1 FAIL: 未知模型应落推理(贵)档");
    // router 槽为空时绝不误判为快档(偏保守)
    equal(classifyTier("anything", { routerModel: "", mainModel: "x" }), "reasoning", "T1 FAIL: 空 router 槽不应命中快档");
    // 推理槽优先(P2):同一模型既填 router 又填主槽 → 推理档,不误乘 FAST_WEIGHT
    equal(classifyTier("claude-opus-4-8", { routerModel: "claude-opus-4-8", mainModel: "claude-opus-4-8" }), "reasoning", "T1 FAIL: 多槽共享模型应推理档");
    // 推理槽优先于 router 子串误命中:router='claude' 子串会命中 opus,但主槽全名应把它拉回推理档
    equal(classifyTier("claude-opus-4-8", { routerModel: "claude", mainModel: "claude-opus-4-8" }), "reasoning", "T1 FAIL: 推理槽应优先于 router 子串命中");
  }

  // ── T2: 成本加权(token 类型比例 + 推理档基准 1.0) ──────────────
  {
    const trace: UsageTrace = {
      startedAt: 1_000_000_000_000,
      models: [{ model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 400, cacheReadTokens: 5000 }],
    };
    // 1*(1000 + 5*200 + 1.25*400 + 0.1*5000) = 1000 + 1000 + 500 + 500 = 3000
    equal(billableTokensForTrace(trace, roles), 3000, "T2 FAIL: 推理档成本加权应为 3000");
  }

  // ── T3: 快档权重生效 ────────────────────────────────────────────
  {
    const trace: UsageTrace = {
      startedAt: 1_000_000_000_000,
      models: [{ model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 1000 }],
    };
    // raw = 1000 + 5*1000 = 6000;快档 ×FAST_WEIGHT
    equal(billableTokensForTrace(trace, roles), 6000 * FAST_WEIGHT, "T3 FAIL: 快档应乘 FAST_WEIGHT");
  }

  // ── T4: 多模型一行分别归档求和 ──────────────────────────────────
  {
    const trace: UsageTrace = {
      startedAt: 1_000_000_000_000,
      models: [
        { model: "claude-opus-4-8", inputTokens: 100 },               // 推理:100
        { model: "claude-haiku-4-5", inputTokens: 100 },              // 快:100*FAST_WEIGHT
      ],
    };
    equal(billableTokensForTrace(trace, roles), 100 + 100 * FAST_WEIGHT, "T4 FAIL: 多模型应分档求和");
  }

  // ── T5: 懒锚定窗口起点 ──────────────────────────────────────────
  {
    const now = 1_000_000_000_000;
    equal(nextWindowStart(null, now, FIVE_HOUR_MS), now, "T5 FAIL: 无窗口应锚定为 now");
    const fresh = now - 1000;
    equal(nextWindowStart(fresh, now, FIVE_HOUR_MS), fresh, "T5 FAIL: 未过期应保持原起点");
    const expired = now - FIVE_HOUR_MS - 1;
    equal(nextWindowStart(expired, now, FIVE_HOUR_MS), now, "T5 FAIL: 过期应重锚为 now");
    // 边界:正好到点视为过期、重锚
    equal(nextWindowStart(now - FIVE_HOUR_MS, now, FIVE_HOUR_MS), now, "T5 FAIL: 正好到点应重置");
  }

  // ── T6: computeUsage 窗口过滤 + 任一超限即 blocked ──────────────
  {
    const now = 1_000_000_000_000;
    const inWindow = now - 1000;             // 5h、周窗口内
    const outOf5hInWeek = now - FIVE_HOUR_MS - 1000; // 出 5h、入周
    const traces: UsageTrace[] = [
      { startedAt: inWindow, models: [{ model: "claude-opus-4-8", inputTokens: 100 }] },
      { startedAt: outOf5hInWeek, models: [{ model: "claude-opus-4-8", inputTokens: 200 }] },
    ];
    // 5h 起点早于 inWindow、晚于 outOf5hInWeek;周起点早于两者。均未过期。
    const storedStart5h = now - FIVE_HOUR_MS + 2000;
    const storedStartWeek = now - WEEK_MS + 1000;
    const r = computeUsage({ traces, now, storedStart5h, storedStartWeek, roles });
    equal(r.fivehour.used, 100, "T6 FAIL: 5h 窗口只应计入窗口内的 100");
    equal(r.week.used, 300, "T6 FAIL: 周窗口应计入 100+200=300");
    equal(r.blocked, false, "T6 FAIL: 远未超限不应 blocked");
    // 未过期 → 起点保持;resetAt = 返回起点 + 时长
    equal(r.start5h, storedStart5h, "T6 FAIL: 未过期 5h 起点应保持");
    equal(r.fivehour.resetAt, r.start5h + FIVE_HOUR_MS, "T6 FAIL: 5h resetAt 应为起点+5h");
    equal(r.week.resetAt, r.startWeek + WEEK_MS, "T6 FAIL: 周 resetAt 应为起点+7d");
  }

  // ── T7: 超限拦截(任一窗口) + pct clamp 100 ────────────────────
  {
    const now = 1_000_000_000_000;
    const overTrace: UsageTrace = { startedAt: now - 1000, models: [{ model: "claude-opus-4-8", inputTokens: FIVE_HOUR_LIMIT + 1 }] };
    const r = computeUsage({ traces: [overTrace], now, storedStart5h: now - 2000, storedStartWeek: now - 2000, roles });
    ok(r.fivehour.used > FIVE_HOUR_LIMIT, "T7 FAIL: 5h used 应超上限");
    equal(r.fivehour.pct, 100, "T7 FAIL: pct 应 clamp 到 100");
    equal(r.blocked, true, "T7 FAIL: 5h 超限即 blocked");
    ok(WEEK_LIMIT > 0, "T7 FAIL: 周上限常量应为正");
  }

  // ── T8: computeUsage 内部对过期窗口重锚 → used 归零 ─────────────
  {
    const now = 1_000_000_000_000;
    const oldTrace: UsageTrace = { startedAt: now - FIVE_HOUR_MS - 5000, models: [{ model: "claude-opus-4-8", inputTokens: 999 }] };
    // storedStart5h 已过期 → 内部重锚为 now → 旧 trace 落在窗口外 → used=0
    const r = computeUsage({ traces: [oldTrace], now, storedStart5h: now - FIVE_HOUR_MS - 10_000, storedStartWeek: now - 1, roles });
    equal(r.fivehour.used, 0, "T8 FAIL: 过期窗口重锚后旧 trace 不应计入");
    equal(r.start5h, now, "T8 FAIL: 应返回重锚后的起点供持久化");
  }

  // ── T9: buildBlockedNotice 选窗口/文案/resetAt ──────────────────
  {
    const now = 1_000_000_000_000;
    // 仅 5h 超限
    const over5h = computeUsage({
      traces: [{ startedAt: now - 1000, models: [{ model: "claude-opus-4-8", inputTokens: FIVE_HOUR_LIMIT + 1 }] }],
      now, storedStart5h: now - 2000, storedStartWeek: now - 2000, roles,
    });
    const n5 = buildBlockedNotice(over5h);
    ok(n5, "T9 FAIL: 5h 超限应有 notice");
    equal(n5!.window, "5h", "T9 FAIL: 应标记 5h 窗口");
    equal(n5!.resetAt, over5h.fivehour.resetAt, "T9 FAIL: resetAt 应取 5h 窗口");
    ok(n5!.message.includes("上限"), "T9 FAIL: 文案应含'上限'");

    // 仅周超限(大 trace 落在 5h 窗外、周窗内)
    const onlyWeek = computeUsage({
      traces: [{ startedAt: now - FIVE_HOUR_MS - 1000, models: [{ model: "claude-opus-4-8", inputTokens: WEEK_LIMIT + 1 }] }],
      now, storedStart5h: now - 2000, storedStartWeek: now - WEEK_MS + 1000, roles,
    });
    equal(onlyWeek.fivehour.used, 0, "T9 FAIL: 5h 窗内应无用量");
    const nw = buildBlockedNotice(onlyWeek);
    ok(nw, "T9 FAIL: 周超限应有 notice");
    equal(nw!.window, "week", "T9 FAIL: 应标记周窗口");
    equal(nw!.resetAt, onlyWeek.week.resetAt, "T9 FAIL: resetAt 应取周窗口");

    // 未拦截 → null
    const fine = computeUsage({ traces: [], now, storedStart5h: now - 1, storedStartWeek: now - 1, roles });
    equal(buildBlockedNotice(fine), null, "T9 FAIL: 未拦截应为 null");
  }

  console.log("usage-quota tests passed");
})();
