import {
  calculateCumulativePayroll,
  ZERO_PRIOR_CUMULATIVE,
  type CumulativePayrollResult,
  type PriorCumulative
} from "@/lib/domain/tax-cumulative";
import {
  confirmPayrollPeriod,
  getLatestConfirmedPayroll,
  listPayrollRecords,
  loadTaxConfig,
  savePayrollDraft
} from "@/lib/db/finance-store";
import { backupDatabase, getDb } from "@/lib/db/sqlite";
import { withIdempotency } from "@/lib/agent/tools/idempotency";
import { checkSumConsistent, checkMoneyPrecision, collectNumericIssues } from "@/lib/safety/numeric-check";
import { getDatabasePath } from "@/lib/runtime/paths";
import { z } from "zod/v4";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = { tool: (name: string, desc: string, schema: any, handler: (args: any) => any) => any };

type EmployeeInput = {
  employeeName: string;
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  monthsEmployed?: number | null;
  ytd?: {
    grossCum: number;
    socialCum: number;
    fundCum: number;
    specialCum: number;
    taxWithheldCum: number;
  } | null;
};

export function createPayrollTools(sdk: Sdk) {
  const calculate = sdk.tool(
    "calculate_payroll_batch",
    "按累计预扣预缴法计算员工某月工资个税(确定性引擎,非估算)。自动接力本年度已确认月份的累计数;本年度首次使用时需提供 ytd 累计数(从扣缴端抄录)。结果保存为草稿,财务核对后用 confirm_payroll_period 确认生效。",
    {
      year: z.number().int().describe("年份,如 2026"),
      month: z.number().int().min(1).max(12).describe("月份 1-12"),
      employees: z
        .array(
          z.object({
            employeeName: z.string().describe("员工姓名"),
            grossPay: z.number().describe("本月税前工资(元)"),
            socialInsurance: z.number().describe("本月五险个人缴纳部分(元)"),
            housingFund: z.number().describe("本月公积金个人缴纳部分(元)"),
            specialDeduction: z.number().describe("本月专项附加扣除(元),无则传 0"),
            monthsEmployed: z
              .number()
              .int()
              .nullish()
              .describe("本年度在本单位任职月数(含本月)。不传则按已确认记录自动推算;无记录时视为本年首月"),
            ytd: z
              .object({
                grossCum: z.number().describe("年初至上月累计收入(元)"),
                socialCum: z.number().describe("累计五险个人部分(元)"),
                fundCum: z.number().describe("累计公积金个人部分(元)"),
                specialCum: z.number().describe("累计专项附加扣除(元)"),
                taxWithheldCum: z.number().describe("累计已预扣预缴税额(元)")
              })
              .nullish()
              .describe("冷启动累计数(从个税扣缴端导出),仅当系统里没有该员工已确认记录时需要;提供时必须同时提供 monthsEmployed")
          })
        )
        .describe("员工薪资输入列表"),
      overwriteConfirmed: z
        .boolean()
        .nullish()
        .describe("仅当财务明确要求重算已确认月份时传 true,操作会记录审计日志")
    },
    withIdempotency("calculate_payroll_batch", async (args: { year: number; month: number; employees: EmployeeInput[]; overwriteConfirmed?: boolean | null }) => {
      const taxConfig = loadTaxConfig();
      const results: CumulativePayrollResult[] = [];
      const coldStarts: string[] = [];
      const failures: string[] = [];
      const numericWarnings: string[] = [];

      for (const emp of args.employees) {
        try {
          let prior: PriorCumulative;
          let monthsEmployed: number;
          if (emp.ytd) {
            if (emp.monthsEmployed == null) {
              throw new Error(`${emp.employeeName}:提供 ytd 累计数时必须同时提供 monthsEmployed(本年任职月数,含本月)`);
            }
            prior = emp.ytd;
            monthsEmployed = emp.monthsEmployed;
            coldStarts.push(emp.employeeName);
          } else {
            const confirmedPrior = getLatestConfirmedPayroll(emp.employeeName, args.year, args.month);
            if (confirmedPrior) {
              prior = {
                grossCum: confirmedPrior.grossCum,
                socialCum: confirmedPrior.socialCum,
                fundCum: confirmedPrior.fundCum,
                specialCum: confirmedPrior.specialCum,
                taxWithheldCum: confirmedPrior.taxWithheldCum
              };
              monthsEmployed = emp.monthsEmployed ?? confirmedPrior.monthsEmployed + 1;
            } else {
              prior = ZERO_PRIOR_CUMULATIVE;
              monthsEmployed = emp.monthsEmployed ?? 1;
              coldStarts.push(emp.employeeName);
            }
          }

          const result = calculateCumulativePayroll(
            {
              employeeName: emp.employeeName,
              grossPay: emp.grossPay,
              socialInsurance: emp.socialInsurance,
              housingFund: emp.housingFund,
              specialDeduction: emp.specialDeduction,
              monthsEmployed,
              prior
            },
            taxConfig
          );
          savePayrollDraft(args.year, args.month, result, monthsEmployed, {
            overwriteConfirmed: args.overwriteConfirmed ?? false
          });
          results.push(result);
          // 数值自检(红线 2 校验侧):确定性引擎结果应自洽,不自洽则告警不静默(红线 4)
          for (const issue of collectNumericIssues([
            checkSumConsistent(
              result.grossPay,
              [result.netPay, result.socialInsurance, result.housingFund, result.taxCurrent],
              `${result.employeeName} 实发对账`
            ),
            checkMoneyPrecision(result.netPay, `${result.employeeName} 实发`),
            checkMoneyPrecision(result.taxCurrent, `${result.employeeName} 个税`)
          ])) {
            numericWarnings.push(issue.detail);
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      const totalNetPay = results.reduce((sum, r) => sum + r.netPay, 0);
      const totalTax = results.reduce((sum, r) => sum + r.taxCurrent, 0);
      const lines = [
        `${args.year}年${args.month}月工资草稿:${results.length} 人计算成功,实发合计 ¥${totalNetPay.toFixed(2)},本期个税合计 ¥${totalTax.toFixed(2)}(税率配置 ${taxConfig.version})`,
        ...results.map((r) =>
          [
            `- ${r.employeeName}:税前 ¥${r.grossPay.toFixed(2)} → 实发 ¥${r.netPay.toFixed(2)}(本期个税 ¥${r.taxCurrent.toFixed(2)})`,
            `  计算过程:${r.detail.formula}`
          ].join("\n")
        )
      ];
      if (coldStarts.length > 0) {
        lines.push(
          `⚠ 以下员工按本年首次计算处理(无已确认历史):${coldStarts.join("、")}。请与个税扣缴端的累计数核对,确认累计起点无误。`
        );
      }
      if (failures.length > 0) {
        lines.push(`⚠ 以下员工计算失败,需人工处理(未写入草稿):`, ...failures.map((f) => `  - ${f}`));
      }
      if (numericWarnings.length > 0) {
        lines.push(
          `⚠ 数值自检异常(确定性引擎结果不自洽,请勿据此发薪,需人工核对):`,
          ...numericWarnings.map((w) => `  - ${w}`)
        );
      }
      if (results.length > 0) {
        lines.push(`草稿已保存。请财务核对后回复确认,我再调用 confirm_payroll_period 使 ${args.year}年${args.month}月工资生效。`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { results, failures, coldStarts, totalNetPay, totalTax, taxConfigVersion: taxConfig.version },
        ...(results.length === 0 && failures.length > 0 ? { isError: true as const } : {})
      };
    }, { riskLevel: "high" })
  );

  const confirm = sdk.tool(
    "confirm_payroll_period",
    "把某年某月的工资草稿确认生效(写审计日志)。确认后才作为下月累计预扣基础,且不可被静默覆盖。必须在财务明确表示确认后才调用,不得自行决定。",
    {
      year: z.number().int().describe("年份"),
      month: z.number().int().min(1).max(12).describe("月份"),
      employeeNames: z.array(z.string()).nullish().describe("只确认这些员工;不传则确认该月全部草稿")
    },
    withIdempotency("confirm_payroll_period", async (args: { year: number; month: number; employeeNames?: string[] | null }) => {
      try {
        const { confirmed, alreadyConfirmed } = confirmPayrollPeriod(args.year, args.month, args.employeeNames ?? undefined);
        if (confirmed.length === 0) {
          // 幂等:重复确认不报错也不重写审计日志,如实告知无变更
          return {
            content: [
              {
                type: "text" as const,
                text: `${args.year}年${args.month}月工资此前已确认生效(${alreadyConfirmed.join("、")}),本次无变更。`
              }
            ],
            structuredContent: { confirmed, alreadyConfirmed }
          };
        }
        // 工资确认是关键写操作:成功后立即追加一次备份(失败仅告警,不影响确认结果)
        backupDatabase(getDb(), getDatabasePath());
        return {
          content: [
            {
              type: "text" as const,
              text: `${args.year}年${args.month}月工资已确认生效:${confirmed.join("、")}(共 ${confirmed.length} 人,已写入审计日志)`
            }
          ],
          structuredContent: { confirmed, alreadyConfirmed }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `确认失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }, { riskLevel: "high" })
  );

  const queryStatus = sdk.tool(
    "query_payroll_status",
    "查询某年某月工资计算与确认状态(只读):哪些员工已确认生效、哪些还是待确认草稿、各自税额与实发。申报前检查、回答\"哪些人还没确认\"时优先用本工具,不要让用户重复上传工资表。",
    {
      year: z.number().int().describe("年份,如 2026"),
      month: z.number().int().min(1).max(12).describe("月份 1-12")
    },
    async (args: { year: number; month: number }) => {
      try {
        const records = listPayrollRecords(args.year, args.month);
        if (records.length === 0) {
          return {
            content: [{ type: "text" as const, text: `${args.year}年${args.month}月没有任何工资记录(尚未用 calculate_payroll_batch 计算)。` }],
            structuredContent: { year: args.year, month: args.month, drafts: [], confirmed: [] }
          };
        }
        const drafts = records.filter((r) => r.status === "draft");
        const confirmed = records.filter((r) => r.status === "confirmed");
        const fmtNames = (rows: typeof records) => rows.map((r) => r.employeeName).join("、");
        const lines = [
          `${args.year}年${args.month}月工资状态:共 ${records.length} 人。`,
          confirmed.length ? `已确认生效 ${confirmed.length} 人:${fmtNames(confirmed)}` : "已确认生效:无",
          drafts.length ? `待确认草稿 ${drafts.length} 人:${fmtNames(drafts)}(确认后才进入累计预扣与申报口径)` : "待确认草稿:无"
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: {
            year: args.year,
            month: args.month,
            drafts: drafts.map((r) => ({ employeeName: r.employeeName, netPay: r.netPay, taxCurrent: r.taxCurrent })),
            confirmed: confirmed.map((r) => ({ employeeName: r.employeeName, netPay: r.netPay, taxCurrent: r.taxCurrent }))
          }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `查询失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }
  );

  return [calculate, confirm, queryStatus];
}
