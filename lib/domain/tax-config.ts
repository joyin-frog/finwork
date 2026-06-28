// 个税政策参数默认配置。所有政策数字只存在于此文件(及 app_settings 运行时覆盖),
// 引擎(tax-cumulative.ts)零政策数字。逐年调整,需核实当年政策。

export type TaxBracket = {
  /** 累计应纳税所得额上限(元),最后一档为 Infinity */
  limit: number;
  rate: number;
  quickDeduction: number;
};

export type TaxConfig = {
  /** 配置版本号,随计算结果记录,政策调整时升版本 */
  version: string;
  effectiveYear: number;
  /** 每月基本减除费用(元),需核实当年政策 */
  basicDeductionMonthly: number;
  /** 综合所得预扣率表(按累计应纳税所得额),需核实当年政策 */
  brackets: TaxBracket[];
};

export const DEFAULT_TAX_CONFIG: TaxConfig = {
  version: "2026-standard-v1",
  effectiveYear: 2026,
  basicDeductionMonthly: 5000,
  brackets: [
    { limit: 36000, rate: 0.03, quickDeduction: 0 },
    { limit: 144000, rate: 0.1, quickDeduction: 2520 },
    { limit: 300000, rate: 0.2, quickDeduction: 16920 },
    { limit: 420000, rate: 0.25, quickDeduction: 31920 },
    { limit: 660000, rate: 0.3, quickDeduction: 52920 },
    { limit: 960000, rate: 0.35, quickDeduction: 85920 },
    { limit: Number.POSITIVE_INFINITY, rate: 0.45, quickDeduction: 181920 }
  ]
};

/** 增值税 / 企业所得税法定税率集(政策变更改此处,或经 app_settings 的 tax_rates 运行期覆盖,不必改代码)。 */
export type TaxRates = { vat: string[]; cit: string[] };

export const DEFAULT_TAX_RATES: TaxRates = {
  vat: ["0.13", "0.09", "0.06", "0.03"],
  cit: ["0.25", "0.20", "0.15"],
};
