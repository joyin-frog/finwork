import { z } from "zod/v4";
import {
  buildBusinessAnalysisV2,
  renderAnalysisMarkdownV2,
  type BudgetData,
} from "@/lib/domain/business-analysis";
import type { CanonicalBalanceSheet, CanonicalIncomeStatement } from "@/lib/domain/canonical-financials";
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
  adminExpense:   z.number().finite().describe("管理费用(元)"),
  rdExpense:      z.number().finite().describe("研发费用(元)"),
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

const budgetSchema = z.object({
  revenue:     z.number().finite().nullish().describe("预算营收(元,已归一)"),
  cost:        z.number().finite().nullish().describe("预算营业成本(元)"),
  netProfit:   z.number().finite().nullish().describe("预算净利润(元)"),
  totalAssets: z.number().finite().nullish().describe("预算总资产(元)"),
  equity:      z.number().finite().nullish().describe("预算净资产(元)"),
}).nullish().describe("预算数(传入前必须归一到「元」;预算通常为「万元」时×10000再传)");

/** 经营分析表生成工具:比率全部走确定性死公式,模型只负责提数+复述,不心算。 */
export function createBusinessAnalysisTool(sdk: Sdk) {
  return sdk.tool(
    "generate_business_analysis",
    [
      "根据资产负债表+利润表生成 v2 四能力×三基准经营分析表(偿债/盈利/营运/发展)。",
      "所有比率(资产负债率/流动比率/毛利率/净利率/ROE/杜邦/周转率/增长率)由确定性函数计算,禁止自己心算。",
      "数字从用户上传的财报里提取后填入;调用前先向用户复述提取的关键科目数,确认无误再调用。",
      "⚠️ 传入前单位必须统一到「元」:会小企财报单位「万元」时 ×10000;预算「万元」时同样 ×10000。",
      "🚨 T3敏感sheet(应收/进项客户实名明细)绝不传入工具——该类数据不进模型上下文(红线7)。",
      "同比基准:利润表上年同期列已内含时放入 incomeStatement.prior;资产负债表期初数放入 balanceSheet.prior。",
      "无基准数据时比率标「无基准」,不可算时标「不可算」,如实转述,不编造。",
      "返回 Markdown 三基准分析表 + 结构化数据。输出带 asOf + 结算状态(红线3)。",
      "先对话分析后生成报告:有疑问先问用户再调本工具(红线4/6)。",
    ].join("\n"),
    {
      balanceSheet: canonicalBSSchema,
      incomeStatement: canonicalISSchema,
      budget: budgetSchema,
      priorPeriod: z.object({
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
      }).nullish().describe("上期快照(用于跨期同比;若已在 balanceSheet.prior/incomeStatement.prior 中提供则此处可省)"),
      asOf:    z.string().nullish().describe("数据截止日,如 2025-12-31"),
      source:  z.string().nullish().describe("数据来源,如「2025年12月资产负债表+利润表」"),
      caliber: z.string().nullish().describe("口径,如「期末数·未审计」"),
      status:  z.enum(["草稿", "已确认", "已锁定"]).nullish().describe("结算状态(红线3);默认「草稿」"),
    },
    async (args: {
      balanceSheet: z.infer<typeof canonicalBSSchema>;
      incomeStatement: z.infer<typeof canonicalISSchema>;
      budget?: z.infer<typeof budgetSchema>;
      priorPeriod?: PriorPeriodArg;
      asOf?: string | null;
      source?: string | null;
      caliber?: string | null;
      status?: "草稿" | "已确认" | "已锁定" | null;
    }) => {
      try {
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
          meta: {
            asOf:    args.asOf ?? undefined,
            source:  args.source ?? undefined,
            caliber: args.caliber ?? undefined,
            status:  args.status ?? "草稿",
          },
        });

        const title = "经营分析表 v2";
        const md = renderAnalysisMarkdownV2(report, title);

        return {
          content: [{ type: "text" as const, text: md }],
          structuredContent: { report, title, version: "v2" },
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
