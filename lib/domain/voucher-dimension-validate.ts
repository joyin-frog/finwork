/**
 * 维度合法性确定性校验:纯函数,无副作用。
 *
 * 规则(来自生产事故):
 *  1. 科目表无核算维度(dimension 字段空/缺) → 行的 dimensionType/Value 必须为空,否则报错。
 *  2. 科目表有核算维度 → 行的 dimensionType 须与科目表一致,不一致报错。
 *  3. 科目表有核算维度、dimensionType 一致但 dimensionValue 为空 → 出 warning(不阻断)。
 */
import type { VoucherLine } from "@/lib/domain/voucher-build";
import type { KingdeeAccount } from "@/lib/db/finance-store";

export type DimensionValidateResult = {
  errors: string[];
  warnings: string[];
};

export function validateVoucherDimensions(lines: VoucherLine[], chart: KingdeeAccount[]): DimensionValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    if (!line.account) continue;
    const entry = chart.find((a) => a.code === line.account);
    if (!entry) continue; // 科目不在表里,不校验(可由其他步骤处理)

    const chartDim = entry.dimension?.trim() || undefined;
    const lineDimType = line.dimensionType?.trim() || undefined;
    const lineDimValue = line.dimensionValue?.trim() || undefined;

    if (!chartDim) {
      // 科目无核算维度:行不应填任何维度
      if (lineDimType || lineDimValue) {
        errors.push(
          `科目 ${entry.code}(${entry.name})无核算维度,不应填 ${lineDimType ?? lineDimValue}`
        );
      }
    } else {
      // 科目有核算维度:维度类型必须一致
      if (lineDimType && lineDimType !== chartDim) {
        errors.push(
          `科目 ${entry.code}(${entry.name})核算维度应为「${chartDim}」,但行填了「${lineDimType}」`
        );
      } else if (!lineDimValue) {
        // 类型正确(或未填类型)但值为空:warning
        warnings.push(
          `科目 ${entry.code}(${entry.name})核算维度「${chartDim}」值未填写`
        );
      }
    }
  }

  return { errors, warnings };
}
