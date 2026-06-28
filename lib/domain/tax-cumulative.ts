// 工资薪金个税:累计预扣预缴法。
// 算法已迁到 payroll-calc skill 的**固定脚本**:agent-skills/skills/payroll-calc/scripts/payroll.py
// (你可直接改那个 .py 调口径;parity 见 selftest_payroll.py、CI 见 tests/payroll-script.test.ts)。
// 本文件只留 canonical 类型 + 一个**同步 shell 包装**,签名不变,所有 TS 消费方(工具/demo/测试)零改动。
// 政策数字仍在 tax-config.ts(运行期可被 app_settings 覆盖),由调用方传入脚本,覆盖照样生效。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath, getBundledPluginRoot } from "@/lib/runtime/paths";
import { DEFAULT_TAX_CONFIG, type TaxConfig } from "./tax-config";

export { DEFAULT_TAX_CONFIG, type TaxBracket, type TaxConfig } from "./tax-config";

/** 本年度截至上月的累计数(本单位口径),冷启动时由财务从扣缴端抄录 */
export type PriorCumulative = {
  grossCum: number;
  socialCum: number;
  fundCum: number;
  specialCum: number;
  taxWithheldCum: number;
};

export const ZERO_PRIOR_CUMULATIVE: PriorCumulative = {
  grossCum: 0,
  socialCum: 0,
  fundCum: 0,
  specialCum: 0,
  taxWithheldCum: 0
};

export type CumulativePayrollInput = {
  employeeName: string;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  /** 本年度在本单位任职月数,含本月(年中入职从入职月起算) */
  monthsEmployed: number;
  prior?: PriorCumulative;
};

export type CumulativeTaxDetail = {
  grossCum: number;
  basicDeductionCum: number;
  socialCum: number;
  fundCum: number;
  specialCum: number;
  taxableIncomeCum: number;
  bracketRate: number;
  quickDeduction: number;
  taxDueCum: number;
  taxWithheldPriorCum: number;
  formula: string;
  taxConfigVersion: string;
};

export type CumulativePayrollResult = {
  employeeName: string;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  taxCurrent: number;
  netPay: number;
  /** 含本期的累计已预扣 */
  taxWithheldCum: number;
  detail: CumulativeTaxDetail;
};

const PAYROLL_SCRIPT = path.join(getBundledPluginRoot(), "skills", "payroll-calc", "scripts", "payroll.py");

/**
 * 累计预扣计算:同步调固定脚本 payroll.py(算法在那)。签名/语义与原 TS 引擎一致;
 * 输入校验失败时脚本返回 error,本包装如实抛错(与原行为一致,红线 4)。
 */
export function calculateCumulativePayroll(
  input: CumulativePayrollInput,
  config: TaxConfig = DEFAULT_TAX_CONFIG
): CumulativePayrollResult {
  // Infinity 经 JSON 变 null;脚本侧把 null 当 +∞。
  const payload = JSON.stringify({ config, items: [{ ...input, prior: input.prior ?? null }] });
  let out: string;
  try {
    out = execFileSync(getPythonPath(), [PAYROLL_SCRIPT], { input: payload, encoding: "utf-8" });
  } catch (e) {
    throw new Error(`薪税脚本执行失败:${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = JSON.parse(out) as {
    results?: Array<{ ok: boolean; result?: CumulativePayrollResult; error?: string }>;
    error?: string;
  };
  if (parsed.error) throw new Error(parsed.error);
  const r = parsed.results?.[0];
  if (!r) throw new Error("薪税脚本无输出");
  if (!r.ok || !r.result) throw new Error(r.error ?? "薪税计算失败");
  return r.result;
}
