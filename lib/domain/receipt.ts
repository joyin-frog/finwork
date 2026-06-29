/**
 * CalcReceipt — 可追溯计算回执通用类型。
 *
 * 所有 domain 计算函数的标准输出信封，对齐数据可信度四标签：
 * 结算状态 / 口径版本 / 合规标记 / 精度规格，以及三连问：从哪来 / 怎么算 / 为什么这么处理。
 */

/** 单步计算过程 */
export interface CalcStep {
  label: string;
  expr: string;
  inputs: Record<string, number | string>;
  subtotal: number;
}

/** 原始数据来源（文件 / 单元格 / 发票号 / 记录数） */
export interface CalcSource {
  file?: string;
  ref?: string;
  recordCount?: number;
}

/** 计算口径与结算状态 */
export interface CalcReceiptBasis {
  /** 口径/费率版本，如 tax-config 版本号 */
  caliberVersion: string;
  /** 结算状态：草稿绝不当终值 */
  settlementStatus: "draft" | "closed" | "filed";
  /** 时点（会计期间），取当期适用口径，如 "2025-01" */
  asOf: string;
}

/** 统一计算回执信封 */
export interface CalcReceipt {
  /** 展示用元；内部计算一律整数分 */
  value: number;
  /** 金额必带单位；万元/千元只在展示层单向转换 */
  unit: "CNY";
  /** 舍入规则显式声明，不靠语言默认 */
  rounding: "half_up" | "bankers";
  /** 逐步公式 + 输入 + 小计 */
  steps: CalcStep[];
  /** 原始文件 / 单元格 / 发票号 / 记录数 */
  source: CalcSource[];
  basis: CalcReceiptBasis;
  /** 不确定点 / 降级措辞 / 合规备注 */
  caveats?: string[];
}

/**
 * 校验器：校验通过返回原对象，否则抛出带说明的错误。
 */
export function validateCalcReceipt(r: unknown): CalcReceipt {
  if (typeof r !== "object" || r === null) {
    throw new Error("CalcReceipt 必须是对象");
  }
  const rec = r as Record<string, unknown>;

  if (typeof rec.value !== "number" || !Number.isFinite(rec.value)) {
    throw new Error(`CalcReceipt.value 必须是有限数: ${rec.value}`);
  }
  if (rec.unit !== "CNY") {
    throw new Error(`CalcReceipt.unit 必须是 "CNY"，实际: ${String(rec.unit)}`);
  }
  if (rec.rounding !== "half_up" && rec.rounding !== "bankers") {
    throw new Error(`CalcReceipt.rounding 必须是 "half_up" 或 "bankers"，实际: ${String(rec.rounding)}`);
  }
  if (!Array.isArray(rec.steps)) {
    throw new Error("CalcReceipt.steps 必须是数组");
  }
  if (!Array.isArray(rec.source)) {
    throw new Error("CalcReceipt.source 必须是数组");
  }

  const basis = rec.basis;
  if (typeof basis !== "object" || basis === null) {
    throw new Error("CalcReceipt.basis 必须是对象");
  }
  const b = basis as Record<string, unknown>;
  if (typeof b.caliberVersion !== "string") {
    throw new Error("CalcReceipt.basis.caliberVersion 必须是字符串");
  }
  if (!["draft", "closed", "filed"].includes(b.settlementStatus as string)) {
    throw new Error(`CalcReceipt.basis.settlementStatus 非法值: ${String(b.settlementStatus)}（必须是 draft/closed/filed）`);
  }
  if (typeof b.asOf !== "string") {
    throw new Error("CalcReceipt.basis.asOf 必须是字符串");
  }

  return rec as unknown as CalcReceipt;
}

/**
 * 构造器：带合理默认值，校验通过后返回 CalcReceipt。
 */
export function makeCalcReceipt(opts: {
  value: number;
  steps?: CalcStep[];
  source?: CalcSource[];
  basis: CalcReceiptBasis;
  rounding?: "half_up" | "bankers";
  caveats?: string[];
}): CalcReceipt {
  return validateCalcReceipt({
    value: opts.value,
    unit: "CNY" as const,
    rounding: opts.rounding ?? "half_up",
    steps: opts.steps ?? [],
    source: opts.source ?? [],
    basis: opts.basis,
    ...(opts.caveats !== undefined ? { caveats: opts.caveats } : {}),
  });
}
