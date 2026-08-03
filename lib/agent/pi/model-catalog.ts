/**
 * 模型元数据解析（L2）。
 *
 * 在此之前 `provider.ts` 对**所有**模型写死 `cost: 全 0` + `contextWindow: 200_000`
 * + `maxTokens: 8_192`。两处后果：
 *
 * 1. `totalCostUsd` 恒为 0——但这不是「算错了」，是**把「未知」报成了「零」**。
 *    Finwork 的模型和网关都是用户自填的，我们无从知道费率；报 $0.00 会让用户以为
 *    这次运行不花钱。财务应用尤其不能这样。
 * 2. compaction 的触发点按 `contextWindow` 算。对真实上下文窗口不是 200k 的模型，
 *    压缩要么过早要么过晚，而且不会报错，只会表现为「行为怪」。
 *
 * 这里**不内置价格表**：编一张自己无法核实的价格，比没有价格更糟。费率由用户在
 * settings 里声明（`modelPricing`），声明了就由 pi 自己算真实成本；没声明就诚实地
 * 标为未知，让上层把 `totalCostUsd` 报成 null 而不是 0。
 */

/** 费率单位：USD / 每百万 token。与 pi-ai 的 `Model.cost` 同单位（其内部除以 1e6）。 */
export type ModelRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelLimits = {
  contextWindow: number;
  maxTokens: number;
};

export type ResolvedModelMetadata = {
  cost: ModelRates;
  limits: ModelLimits;
  /** false = 用户未声明该模型费率，成本不可知（≠ 成本为 0）。 */
  pricingKnown: boolean;
};

/**
 * 未声明模型时的上下文/输出上限。沿用改动前的既有值，避免这批顺手改掉压缩行为；
 * 要按真实模型调整时在 settings 里声明。
 */
export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const ZERO_RATES: ModelRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** settings 里每个模型的可选声明。省略 limits 则用默认值。 */
export type ModelPricingEntry = {
  rates?: Partial<ModelRates>;
  limits?: Partial<ModelLimits>;
};

export type ModelPricingConfig = Record<string, ModelPricingEntry>;

export function resolveModelMetadata(
  modelId: string,
  pricing: ModelPricingConfig | undefined,
): ResolvedModelMetadata {
  const entry = pricing?.[modelId];
  const rates = normalizeRates(entry?.rates);
  return {
    cost: rates ?? ZERO_RATES,
    limits: {
      contextWindow: positive(entry?.limits?.contextWindow) ?? DEFAULT_MODEL_LIMITS.contextWindow,
      maxTokens: positive(entry?.limits?.maxTokens) ?? DEFAULT_MODEL_LIMITS.maxTokens,
    },
    // 费率必须四项齐全才算已知：缺项会让某一维静默按 0 计，重演「未知伪装成零」。
    pricingKnown: rates !== null,
  };
}

/** 校验并解析用户声明的 `modelPricing`；任何非法结构都当作未声明，不抛错。 */
export function parseModelPricing(raw: unknown): ModelPricingConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: ModelPricingConfig = {};
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!modelId.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as { rates?: unknown; limits?: unknown };
    const entry: ModelPricingEntry = {};
    if (source.rates && typeof source.rates === "object" && !Array.isArray(source.rates)) {
      const rates = pickNumbers(source.rates as Record<string, unknown>, [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
      ]);
      // 全部取值非法时不要留下空 `rates: {}`——那会让配置里堆一堆无意义条目。
      if (Object.keys(rates).length > 0) entry.rates = rates;
    }
    if (source.limits && typeof source.limits === "object" && !Array.isArray(source.limits)) {
      const limits = pickNumbers(source.limits as Record<string, unknown>, [
        "contextWindow",
        "maxTokens",
      ]);
      if (Object.keys(limits).length > 0) entry.limits = limits;
    }
    if (entry.rates || entry.limits) out[modelId] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRates(raw: Partial<ModelRates> | undefined): ModelRates | null {
  if (!raw) return null;
  const input = nonNegative(raw.input);
  const output = nonNegative(raw.output);
  const cacheRead = nonNegative(raw.cacheRead);
  const cacheWrite = nonNegative(raw.cacheWrite);
  if (input == null || output == null || cacheRead == null || cacheWrite == null) return null;
  return { input, output, cacheRead, cacheWrite };
}

function pickNumbers<K extends string>(
  source: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

function nonNegative(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
