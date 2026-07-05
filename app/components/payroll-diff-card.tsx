// 薪税差异复核卡片——diff_payroll_period 工具结果专属渲染。
// 卡片明确标注"本月草稿 vs 上月已确认"，防止被当作环比趋势读。
// 变动高亮用 --tone-notice；新增/漏算用 --tone-warn。

import { HugeiconsIcon } from "@hugeicons/react";
import { WarningIcon } from "@/lib/icons";
import { formatSignedDelta, type PayrollDiffCardData, type PayrollDiffFieldData } from "./payroll-diff-card-data";

function DeltaCell({ field }: { field: PayrollDiffFieldData }) {
  const { delta } = field;
  if (delta === 0) {
    return <span className="text-muted-foreground tabular-nums">—</span>;
  }
  return (
    <span className="tabular-nums" style={{ color: "var(--tone-notice)" }}>
      {formatSignedDelta(delta)}
      <span className="sr-only">{delta > 0 ? "增加" : "减少"}</span>
    </span>
  );
}

function FlagBadge({ flag }: { flag: string }) {
  if (flag === "new") {
    return (
      <span
        className="inline-block text-[10px] px-1 py-0.5 rounded leading-none font-medium"
        style={{ background: "color-mix(in oklch, var(--tone-notice) 15%, transparent)", color: "var(--tone-notice)" }}
      >
        新增
      </span>
    );
  }
  if (flag === "tax_config_changed") {
    return (
      <span
        className="inline-block text-[10px] px-1 py-0.5 rounded leading-none"
        style={{ background: "color-mix(in oklch, var(--tone-warn) 10%, transparent)", color: "var(--tone-warn)" }}
      >
        税率版本变
      </span>
    );
  }
  return null;
}

export function PayrollDiffCard({ data }: { data: PayrollDiffCardData }) {
  const hasAnomalies = data.newEmployees.length > 0 || data.dropped.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card text-body overflow-hidden">
      {/* 标注头：草稿 vs 已确认，防止被当环比趋势读 */}
      <div
        className="px-3 py-2 border-b text-meta flex items-start gap-2"
        style={{
          borderColor: hasAnomalies ? "color-mix(in oklch, var(--tone-notice) 30%, transparent)" : undefined,
          background: hasAnomalies ? "color-mix(in oklch, var(--tone-notice) 8%, transparent)" : undefined,
        }}
      >
        {hasAnomalies && (
          <HugeiconsIcon icon={WarningIcon} size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
        )}
        <div>
          <span className="font-medium">
            本月草稿 vs 上月已确认
            {data.comparedFromPeriod ? `（${data.comparedFromPeriod}）` : "（无上月已确认期间）"}
          </span>
          <span className="text-muted-foreground ml-2">· 仅供复核，非环比分析</span>
        </div>
      </div>

      {/* 新增/漏算警告 */}
      {(data.newEmployees.length > 0 || data.dropped.length > 0) && (
        <div className="px-3 py-2 border-b border-border/60 text-small space-y-1">
          {data.newEmployees.length > 0 && (
            <div className="flex items-start gap-1.5" style={{ color: "var(--tone-notice)" }}>
              <HugeiconsIcon icon={WarningIcon} size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>新增员工（本月有、上月无，需核累计起点）：{data.newEmployees.join("、")}</span>
            </div>
          )}
          {data.dropped.length > 0 && (
            <div className="flex items-start gap-1.5" style={{ color: "var(--tone-warn)" }}>
              <HugeiconsIcon icon={WarningIcon} size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>漏算/离职嫌疑（上月有、本月无，请人工核实）：{data.dropped.join("、")}</span>
            </div>
          )}
        </div>
      )}

      {/* 差异表格 */}
      {data.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-small">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left font-normal px-3 py-1.5">姓名</th>
                <th className="text-right font-normal px-2 py-1.5">税前</th>
                <th className="text-right font-normal px-2 py-1.5">五险</th>
                <th className="text-right font-normal px-2 py-1.5">公积金</th>
                <th className="text-right font-normal px-2 py-1.5">专项</th>
                <th className="text-right font-normal px-2 py-1.5">个税</th>
                <th className="text-right font-normal px-3 py-1.5">实发</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr
                  key={row.employeeName}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span>{row.employeeName}</span>
                      {row.flags.map((f) => (
                        <FlagBadge key={f} flag={f} />
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <DeltaCell field={row.fields.grossPay} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <DeltaCell field={row.fields.socialInsurance} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <DeltaCell field={row.fields.housingFund} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <DeltaCell field={row.fields.specialDeduction} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <DeltaCell field={row.fields.taxCurrent} />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <DeltaCell field={row.fields.netPay} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.rows.length === 0 && !hasAnomalies && (
        <div className="px-3 py-3 text-small text-muted-foreground">
          所有员工与上月已确认数据一致，无差异。
        </div>
      )}
    </div>
  );
}
