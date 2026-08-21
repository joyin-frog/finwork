import { z } from "zod/v4";
import {
  buildBusinessAnalysisV2,
  renderAnalysisMarkdownV2,
  type BudgetData,
} from "@/lib/domain/business-analysis";
import type { CanonicalBalanceSheet, CanonicalIncomeStatement } from "@/lib/domain/canonical-financials";
import { getDb } from "@/lib/db/sqlite";
import { jsonCoercible } from "./coerce-json";
import type { SdkLike } from "./sdk-types";

type Sdk = SdkLike;

// ─────── 类型辅助 ───────

type PriorPeriodArg = {
  bs?: {
    totalAssets?: number | null;
    equity?: number | null;
    currentAssets?: number | null;
    receivables?: number | null;
    inventory?: number | null;
  } | null;
  is?: {
    revenue?: number | null;
    cost?: number | null;
    netProfit?: number | null;
  } | null;
} | null | undefined;

// ─────── 共用 Zod schema 块 ───────

const canonicalBSSchema = z.object({
  cash:               z.number().finite().describe("货币资金(元)"),
  receivables:        z.number().finite().describe("应收账款(元)"),
  inventory:          z.number().finite().describe("存货(元)"),
  currentAssets:      z.number().finite().describe("流动资产合计(元)"),
  totalAssets:        z.number().finite().describe("总资产(元)"),
  shortTermBorrowing: z.number().finite().describe("短期借款(元)"),
  payables:           z.number().finite().describe("应付账款(元)"),
  currentLiabilities: z.number().finite().describe("流动负债合计(元)"),
  totalLiabilities:   z.number().finite().describe("总负债(元)"),
  equity:             z.number().finite().describe("净资产/所有者权益合计(元)"),
  prior: z.object({
    cash:               z.number().finite(),
    receivables:        z.number().finite(),
    inventory:          z.number().finite(),
    currentAssets:      z.number().finite(),
    totalAssets:        z.number().finite(),
    currentLiabilities: z.number().finite(),
    totalLiabilities:   z.number().finite(),
    equity:             z.number().finite(),
  }).nullish().describe("期初数(用于计算平均值);无期初数则省略,工具将以期末数近似并在脚注标注"),
}).describe("资产负债表科目(已归一到元;T3敏感sheet不传)");

const canonicalISSchema = z.object({
  revenue:        z.number().finite().describe("营业收入(元)"),
  cost:           z.number().finite().describe("营业成本(元)"),
  sellingExpense: z.number().finite().describe("销售费用(元)"),
  adminExpense:   z.number().finite().describe("管理费用总额(元)，包含其下属的‘其中：研究费用’"),
  rdExpense:      z.number().finite().describe("独立列报的研发费用(元)；若只有管理费用下‘其中：研究费用’，必须传 0，禁止与管理费用重复计入"),
  financeExpense: z.number().finite().describe("财务费用(元)"),
  netProfit:      z.number().finite().describe("净利润(元)"),
  prior: z.object({
    revenue:        z.number().finite(),
    cost:           z.number().finite(),
    sellingExpense: z.number().finite(),
    adminExpense:   z.number().finite(),
    rdExpense:      z.number().finite(),
    financeExpense: z.number().finite(),
    netProfit:      z.number().finite(),
  }).nullish().describe("上年同期数(损益表内含时从该列读取);无则省略,工具标「无基准」"),
}).describe("利润表科目(已归一到元)");

const canonicalCashFlowSchema = z.object({
  operatingCashFlow: z.number().finite().describe("经营活动产生的现金流量净额(元)"),
  investingCashFlow: z.number().finite().describe("投资活动产生的现金流量净额(元)"),
  financingCashFlow: z.number().finite().describe("筹资活动产生的现金流量净额(元)"),
  netCashIncrease: z.number().finite().describe("现金及现金等价物净增加额(元)"),
}).nullish().describe("现金流量表核心净额；用于统一登记格子级事实，不改变经营指标计算口径");

const budgetSchema = z.object({
  revenue:     z.number().finite().nullish().describe("预算营收(元,已归一)"),
  cost:        z.number().finite().nullish().describe("预算营业成本(元)"),
  netProfit:   z.number().finite().nullish().describe("预算净利润(元)"),
  totalAssets: z.number().finite().nullish().describe("预算总资产(元)"),
  equity:      z.number().finite().nullish().describe("预算净资产(元)"),
}).nullish().describe("预算数(传入前必须归一到「元」;预算通常为「万元」时×10000再传)");

const sourceCellsSchema = z.record(
  z.string().min(1).max(100),
  z.object({
    sheet: z.string().trim().min(1).max(255),
    range: z.string().regex(/^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/i),
  }).strict(),
).nullish().describe(
  "工作簿字段来源，键使用 balanceSheet.totalAssets / incomeStatement.revenue / cashFlow.operatingCashFlow 等 canonical 字段；分析上传报表时必须传入，用于 Sheet+Cell 证据落账",
);

function inferPeriodMonths(input: {
  periodMonths?: number | null;
  asOf?: string | null;
  source?: string | null;
  caliber?: string | null;
}): number | undefined {
  if (input.periodMonths != null) return input.periodMonths;
  const context = `${input.source ?? ""} ${input.caliber ?? ""}`;
  if (/一季度|q1|第一季度/i.test(context)) return 3;
  if (/二季度|q2|第二季度|半年度|上半年/i.test(context)) return 6;
  if (/三季度|q3|第三季度|前三季度/i.test(context)) return 9;
  if (/年度|全年|q4|第四季度/i.test(context)) return 12;
  if (/本年累计|年初至今|ytd/i.test(context) && input.asOf) {
    const month = Number(input.asOf.match(/^\d{4}-(\d{2})/)?.[1]);
    if (Number.isInteger(month) && month >= 1 && month <= 12) return month;
  }
  return undefined;
}

/** 经营分析表生成工具:比率全部走确定性死公式,模型只负责提数+复述,不心算。 */
export function createBusinessAnalysisTool(sdk: Sdk) {
  return sdk.tool(
    "generate_business_analysis",
    [
      "根据资产负债表和利润表确定性计算偿债、盈利、营运、发展及杜邦指标，返回三基准分析表。",
      "调用前确认关键科目、截止日、单位和结算状态；金额统一为元，万元先乘 10000。",
      "来自上传工作簿时必须传 sourceCells；管理费用下‘其中：研究费用’已包含在管理费用中，rdExpense 必须传 0。",
      "不得传入客户实名等敏感明细。缺基准或不可计算时保留空缺状态，不编造。",
    ].join("\n"),
    {
      balanceSheet: jsonCoercible(canonicalBSSchema),
      incomeStatement: jsonCoercible(canonicalISSchema),
      cashFlow: jsonCoercible(canonicalCashFlowSchema),
      budget: jsonCoercible(budgetSchema),
      priorPeriod: jsonCoercible(z.object({
        bs: z.object({
          totalAssets:     z.number().finite().nullish(),
          equity:          z.number().finite().nullish(),
          currentAssets:   z.number().finite().nullish(),
          receivables:     z.number().finite().nullish(),
          inventory:       z.number().finite().nullish(),
        }).nullish(),
        is: z.object({
          revenue:   z.number().finite().nullish(),
          cost:      z.number().finite().nullish(),
          netProfit: z.number().finite().nullish(),
        }).nullish(),
      }).nullish().describe("上期快照(用于跨期同比;若已在 balanceSheet.prior/incomeStatement.prior 中提供则此处可省)")),
      periodMonths: z.number().int().min(1).max(12).nullish()
        .describe("损益表本年累计覆盖月数；一季度填3、半年填6、前三季度填9、全年填12。用于周转率和ROE年化"),
      sourceCells: sourceCellsSchema,
      asOf:    z.string().nullish().describe("数据截止日,如 2025-12-31"),
      source:  z.string().nullish().describe("数据来源,如「2025年12月资产负债表+利润表」"),
      caliber: z.string().nullish().describe("口径,如「期末数·未审计」"),
      status:  z.enum(["草稿", "已确认", "已锁定"]).nullish().describe("结算状态(红线3);默认「草稿」"),
    },
    async (args: {
      balanceSheet: z.infer<typeof canonicalBSSchema>;
      incomeStatement: z.infer<typeof canonicalISSchema>;
      cashFlow?: z.infer<typeof canonicalCashFlowSchema>;
      budget?: z.infer<typeof budgetSchema>;
      priorPeriod?: PriorPeriodArg;
      periodMonths?: number | null;
      sourceCells?: z.infer<typeof sourceCellsSchema>;
      asOf?: string | null;
      source?: string | null;
      caliber?: string | null;
      status?: "草稿" | "已确认" | "已锁定" | null;
    }) => {
      try {
        const workbookBacked = /\.(?:xlsx|xlsm|xls|csv|tsv)\b|工作簿|财务?报表/i.test(args.source ?? "");
        if (workbookBacked && Object.keys(args.sourceCells ?? {}).length === 0) {
          throw new Error("分析上传工作簿时必须传 sourceCells，以便为关键字段登记 Sheet+Cell 证据");
        }
        // 组装 canonical 类型(Zod infer 兼容)
        const bs: CanonicalBalanceSheet = {
          cash:               args.balanceSheet.cash,
          receivables:        args.balanceSheet.receivables,
          inventory:          args.balanceSheet.inventory,
          currentAssets:      args.balanceSheet.currentAssets,
          totalAssets:        args.balanceSheet.totalAssets,
          shortTermBorrowing: args.balanceSheet.shortTermBorrowing,
          payables:           args.balanceSheet.payables,
          currentLiabilities: args.balanceSheet.currentLiabilities,
          totalLiabilities:   args.balanceSheet.totalLiabilities,
          equity:             args.balanceSheet.equity,
          prior: args.balanceSheet.prior ? {
            cash:               args.balanceSheet.prior.cash,
            receivables:        args.balanceSheet.prior.receivables,
            inventory:          args.balanceSheet.prior.inventory,
            currentAssets:      args.balanceSheet.prior.currentAssets,
            totalAssets:        args.balanceSheet.prior.totalAssets,
            currentLiabilities: args.balanceSheet.prior.currentLiabilities,
            totalLiabilities:   args.balanceSheet.prior.totalLiabilities,
            equity:             args.balanceSheet.prior.equity,
          } : undefined,
        };

        const is: CanonicalIncomeStatement = {
          revenue:        args.incomeStatement.revenue,
          cost:           args.incomeStatement.cost,
          sellingExpense: args.incomeStatement.sellingExpense,
          adminExpense:   args.incomeStatement.adminExpense,
          rdExpense:      args.incomeStatement.rdExpense,
          financeExpense: args.incomeStatement.financeExpense,
          netProfit:      args.incomeStatement.netProfit,
          prior: args.incomeStatement.prior ? {
            revenue:        args.incomeStatement.prior.revenue,
            cost:           args.incomeStatement.prior.cost,
            sellingExpense: args.incomeStatement.prior.sellingExpense,
            adminExpense:   args.incomeStatement.prior.adminExpense,
            rdExpense:      args.incomeStatement.prior.rdExpense,
            financeExpense: args.incomeStatement.prior.financeExpense,
            netProfit:      args.incomeStatement.prior.netProfit,
          } : undefined,
        };

        const budget: BudgetData | undefined = args.budget ? {
          revenue:     args.budget.revenue ?? undefined,
          cost:        args.budget.cost ?? undefined,
          netProfit:   args.budget.netProfit ?? undefined,
          totalAssets: args.budget.totalAssets ?? undefined,
          equity:      args.budget.equity ?? undefined,
        } : undefined;

        const priorPeriod = args.priorPeriod ? {
          bs: args.priorPeriod.bs ? {
            totalAssets:   args.priorPeriod.bs.totalAssets ?? undefined,
            equity:        args.priorPeriod.bs.equity ?? undefined,
            currentAssets: args.priorPeriod.bs.currentAssets ?? undefined,
            receivables:   args.priorPeriod.bs.receivables ?? undefined,
            inventory:     args.priorPeriod.bs.inventory ?? undefined,
          } : undefined,
          is: args.priorPeriod.is ? {
            revenue:   args.priorPeriod.is.revenue ?? undefined,
            cost:      args.priorPeriod.is.cost ?? undefined,
            netProfit: args.priorPeriod.is.netProfit ?? undefined,
          } : undefined,
        } : undefined;

        const report = buildBusinessAnalysisV2({
          bs,
          is,
          budget,
          priorPeriod,
          periodMonths: inferPeriodMonths(args),
          meta: {
            asOf:    args.asOf ?? undefined,
            source:  args.source ?? undefined,
            caliber: args.caliber ?? undefined,
            status:  args.status ?? "草稿",
          },
        });

        const title = "经营分析表 v2";
        const md = renderAnalysisMarkdownV2(report, title);

        // WP4b: 在 handler 层用 getDb() 组装 provenance（buildBusinessAnalysisV2 是无 DB 纯函数，保持不动）
        const caliberVersion = args.caliber ?? "未审计草稿";
        const provenanceAsOf = args.asOf ?? report.asOf ?? new Date().toISOString().slice(0, 7);
        // 查询 fact_metrics 数据范围（有就记录，无则 recordCount=0）
        let metricsRecordCount = 0;
        let metricsMonths: string | undefined;
        try {
          const db = getDb();
          const metricsCount = db.prepare("SELECT COUNT(*) AS c FROM fact_metrics").get() as { c: number } | undefined;
          metricsRecordCount = metricsCount?.c ?? 0;
          if (metricsRecordCount > 0) {
            const range = db.prepare("SELECT MIN(year*100+month) AS mn, MAX(year*100+month) AS mx FROM fact_metrics").get() as { mn: number; mx: number } | undefined;
            if (range) {
              const mn = String(range.mn);
              const mx = String(range.mx);
              metricsMonths = `${mn.slice(0, 4)}-${mn.slice(4)}/至/${mx.slice(0, 4)}-${mx.slice(4)}`;
            }
          }
        } catch {
          // fact_metrics 不可达时降级，不阻断
        }
        const factValues: Record<string, number> = {
          ...flattenFinancialFacts("balanceSheet", bs),
          ...flattenFinancialFacts("incomeStatement", is),
          ...flattenFinancialFacts("cashFlow", args.cashFlow),
        };
        const workbookFacts = Object.entries(args.sourceCells ?? {}).flatMap(([field, locator]) => {
          const value = factValues[field];
          return locator && value !== undefined
            ? [{ field, value, locator: { kind: "sheet_range" as const, ...locator } }]
            : [];
        });
        const provenance = {
          sources: [
            ...(workbookFacts.length > 0
              ? [{ kind: "workbook" as const, logicalName: args.source ?? "上传工作簿", factCount: workbookFacts.length }]
              : []),
            ...(metricsRecordCount > 0
              ? [{ kind: "fact_metrics" as const, table: "fact_metrics", ...(metricsMonths ? { months: metricsMonths } : {}), recordCount: metricsRecordCount }]
              : []),
          ],
          workbookFacts,
          caliberVersion,
          asOf: provenanceAsOf,
        };
        // content 尾部加溯源说明（中文）
        const provenanceSource = workbookFacts.length > 0
          ? `工作簿 ${args.source ?? "上传工作簿"}，已登记 ${workbookFacts.length} 个单元格来源`
          : `事实库 fact_metrics 共 ${metricsRecordCount} 条记录`;
        const provenanceLine = `\n\n> 数据口径：${caliberVersion}；截至 ${provenanceAsOf}；来源：${provenanceSource}。`;

        return {
          content: [{ type: "text" as const, text: md + provenanceLine }],
          structuredContent: { report, title, version: "v2", provenance },
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `经营分析表生成失败:${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true as const,
        };
      }
    }
  );
}

function flattenFinancialFacts(prefix: string, value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, number> = {};
  for (const [key, nested] of Object.entries(value)) {
    const field = `${prefix}.${key}`;
    if (typeof nested === "number" && Number.isFinite(nested)) result[field] = nested;
    else if (nested && typeof nested === "object") Object.assign(result, flattenFinancialFacts(field, nested));
  }
  return result;
}
