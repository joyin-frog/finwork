/**
 * CR-R2 v1 Run Policy：按 executionTier 放宽 turns / 硬超时。
 * idle timeout / resume epoch 后续补；本文件只提供 adapter 消费的数字。
 */

import type { ExecutionTier } from "@/lib/settings/model-config";

export type RunBudget = {
  maxTurns: number;
  /** 硬超时（ms）；等待用户/依赖不计时由上层另行处理 */
  hardTimeoutMs: number;
};

const BUDGETS: Record<ExecutionTier, RunBudget> = {
  fast: { maxTurns: 50, hardTimeoutMs: 20 * 60_000 },
  reasoning: { maxTurns: 80, hardTimeoutMs: 60 * 60_000 },
};

export function runBudgetForTier(tier: ExecutionTier | null | undefined): RunBudget {
  if (tier === "reasoning") return BUDGETS.reasoning;
  return BUDGETS.fast;
}
