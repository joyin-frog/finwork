/**
 * 整数分（fen）金额工具。
 *
 * 核心纪律：
 * - 所有内部计算均用整数分（cents），禁止浮点存储。
 * - 展示层单向转换（分→元），不回流计算。
 * - 尾差调整：先全量整除，差额补最后一项，保证明细之和 === 合计（满足 1 分容差）。
 */

/** 舍入规则（对齐 CalcReceipt.rounding） */
export type RoundingMode = "half_up" | "bankers";

/**
 * 元→分（整数分）。
 * 使用 Math.round 规避 JS 浮点乘法误差（如 0.1+0.2 = 0.30000000000000004）。
 */
export function yuanToFen(yuan: number): number {
  if (!Number.isFinite(yuan)) throw new Error(`无效金额: ${yuan}`);
  return Math.round(yuan * 100);
}

/**
 * 分→元（仅展示层单向使用，不回流计算）。
 */
export function fenToYuan(fen: number): number {
  if (!Number.isInteger(fen)) throw new Error(`分必须是整数: ${fen}`);
  return fen / 100;
}

/**
 * 四舍五入（half_up）：恰好 0.5 时向正无穷。
 * roundHalfUp(2.5) → 3  roundHalfUp(-2.5) → -2
 */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/**
 * 银行家舍入（round half to even）：恰好 0.5 时取最近偶数。
 * roundBankers(0.5) → 0  roundBankers(1.5) → 2  roundBankers(2.5) → 2  roundBankers(3.5) → 4
 */
export function roundBankers(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) > Number.EPSILON) {
    // 非恰好 0.5：正常四舍五入
    return Math.round(x);
  }
  // 恰好 0.5：取最近偶数
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 按指定规则对浮点分值取整（结果为整数分）。
 */
export function roundFen(fenFloat: number, mode: RoundingMode): number {
  return mode === "bankers" ? roundBankers(fenFloat) : roundHalfUp(fenFloat);
}

/**
 * 尾差调整分摊：把 totalFen 按 weights 比例拆成整数分各份，保证各份之和 === totalFen。
 *
 * 算法：
 * 1. 对每份按比例取整（按 mode 规则）。
 * 2. 差额（totalFen - Σ取整值）累加到最后一项。
 *
 * @param totalFen  总额（必须是整数分）
 * @param weights   分摊权重（非负数组，不必归一化；全零则均分）
 * @param mode      舍入规则（默认 half_up）
 * @returns         各项整数分（之和严格等于 totalFen）
 */
export function allocateFen(totalFen: number, weights: number[], mode: RoundingMode = "half_up"): number[] {
  if (!Number.isInteger(totalFen)) throw new Error(`totalFen 必须是整数: ${totalFen}`);
  if (weights.length === 0) return [];

  const weightSum = weights.reduce((a, b) => a + b, 0);

  if (weightSum === 0) {
    // 全零权重 → 均分（尾差补最后一项）
    const base = Math.floor(totalFen / weights.length);
    const rem = totalFen - base * weights.length;
    return weights.map((_, i) => base + (i < rem ? 1 : 0));
  }

  const allocated = weights.map((w) => roundFen((w / weightSum) * totalFen, mode));
  const diff = totalFen - allocated.reduce((a, b) => a + b, 0);
  // 差额补到最后一项（最大概率是 ±1 分）
  allocated[allocated.length - 1] += diff;
  return allocated;
}
