import { recordInvoices, settleInvoice, listSalesInvoices, type RecordInvoicesAuditHint } from "@/lib/db/finance-store";
import { z } from "zod/v4";
import { withIdempotency } from "@/lib/agent/tools/idempotency";

type Sdk = { tool: (name: string, desc: string, schema: any, handler: (args: any) => any) => any };

export function createSalesInvoiceTools(sdk: Sdk) {
  const recordSales = sdk.tool(
    "record_sales_invoices",
    "登记销项发票进台账（direction='out'），写审计日志，支持撤销。必须在确认开票后调用；重复发票号会显式报告且不重复登记。",
    {
      items: z
        .array(
          z.object({
            invoiceNo: z.string().describe("发票号码"),
            amount: z.number().describe("发票金额（元）"),
            invoiceDate: z.string().nullish().describe("开票日期 YYYY-MM-DD"),
            category: z.string().nullish().describe("发票类目，如：技术服务、销售商品"),
            taxRate: z.string().nullish().describe("适用税率（小数形式，如 '0.09'），可选；须满足 0 < rate < 1"),
            taxAmountYuan: z.number().nullish().describe("税额（元），可选；入库自动转换为分"),
            counterparty: z.string().nullish().describe("客户名称")
          })
        )
        .describe("要登记的销项发票列表"),
      conversationId: z.number().nullish().describe("当前会话 ID，用于溯源")
    },
    withIdempotency("record_sales_invoices", async (args: {
      items: Array<{
        invoiceNo: string;
        amount: number;
        invoiceDate?: string | null;
        category?: string | null;
        taxRate?: string | null;
        taxAmountYuan?: number | null;
        counterparty?: string | null;
      }>;
      conversationId?: number | null;
    }) => {
      // 校验 taxRate（0 < rate < 1）
      for (const item of args.items) {
        if (item.taxRate != null) {
          const rate = parseFloat(item.taxRate);
          if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) {
            return {
              content: [{ type: "text" as const, text: `发票 ${item.invoiceNo} 的税率 "${item.taxRate}" 非法：须为 0 < rate < 1 的数字字符串（如 "0.09"）` }],
              isError: true as const
            };
          }
        }
      }

      const salesAuditHint: RecordInvoicesAuditHint = {
        eventType: "sales_invoice_record",
        toolName: "record_sales_invoices",
      };
      const { inserted, duplicates } = recordInvoices(
        args.items.map((i) => {
          const taxRate = i.taxRate != null ? parseFloat(i.taxRate) : undefined;
          const ctx = `fact_invoices.${i.invoiceNo}`;
          const taxAmountCents = i.taxAmountYuan != null
            ? (() => {
                const raw = i.taxAmountYuan * 100;
                const rounded = Math.round(raw);
                if (Math.abs(raw - rounded) >= 0.005) {
                  throw new Error(`精度超差: ${ctx} 税额 ${i.taxAmountYuan} 元，|${raw} - ${rounded}| = ${Math.abs(raw - rounded).toFixed(6)} >= 0.005 分`);
                }
                return rounded;
              })()
            : undefined;
          return {
            invoiceNo: i.invoiceNo,
            amount: i.amount,
            invoiceDate: i.invoiceDate ?? undefined,
            category: i.category ?? undefined,
            conversationId: args.conversationId ?? undefined,
            taxRate: taxRate ?? null,
            taxAmountCents: taxAmountCents ?? null,
            counterparty: i.counterparty ?? null,
            direction: "out" as const,
            certificationStatus: null,
          };
        }),
        undefined, // db — use default
        salesAuditHint
      );
      const lines = [`已登记 ${inserted.length} 张销项发票进台账（已写审计日志，可撤销）`];
      if (duplicates.length > 0) {
        lines.push(
          `⚠ ${duplicates.length} 张发票已在台账中，未重复登记——请人工核实是否系不同业务同一发票号：`,
          ...duplicates.map((d) => `  - ${d.invoiceNo}（${d.recordedAt.slice(0, 7)} 已登记）`)
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { inserted, duplicates }
      };
    }, { riskLevel: "medium" })
  );

  const settle = sdk.tool(
    "record_invoice_settlement",
    "登记销项发票回款（settlement_status→'settled'，写实收金额/日期/备注），写审计日志，支持撤销。仅限 direction='out' 的销项发票；已回款发票再次调用会拒绝并回显首次回款信息。",
    {
      invoiceNo: z.string().describe("发票号码"),
      settledAmountYuan: z.number().positive().describe("实收金额（元），须为正数；可与发票额不同（差额不做科目处理，仅记录）"),
      settledAt: z.string().nullish().describe("实收日期 YYYY-MM-DD，缺省当日"),
      note: z.string().nullish().describe("回款备注（可选）"),
      conversationId: z.number().nullish().describe("当前会话 ID，用于溯源")
    },
    withIdempotency("record_invoice_settlement", async (args: {
      invoiceNo: string;
      settledAmountYuan: number;
      settledAt?: string | null;
      note?: string | null;
      conversationId?: number | null;
    }) => {
      // 负数/零回款守卫（Zod schema 层已有 .positive()，此处提供处理器层防御纵深）
      if (args.settledAmountYuan <= 0) {
        return {
          content: [{ type: "text" as const, text: `实收金额 ${args.settledAmountYuan} 元非法：须为正数（不含零）` }],
          isError: true as const
        };
      }
      try {
        const result = settleInvoice({
          invoiceNo: args.invoiceNo,
          settledAmountYuan: args.settledAmountYuan,
          settledAt: args.settledAt ?? undefined,
          note: args.note ?? undefined,
          conversationId: args.conversationId ?? undefined,
        });

        if (result.success) {
          return {
            content: [{ type: "text" as const, text: `发票 ${args.invoiceNo} 回款已登记：实收 ${args.settledAmountYuan} 元，日期 ${args.settledAt ?? new Date().toISOString().slice(0, 10)}（已写审计日志，可撤销）` }],
            structuredContent: { invoiceNo: args.invoiceNo, auditId: result.auditId }
          };
        }

        if ("notFound" in result) {
          return {
            content: [{ type: "text" as const, text: `发票 ${args.invoiceNo} 不存在于台账，请先用 record_sales_invoices 登记销项发票` }],
            isError: true as const
          };
        }

        if ("directionUnknown" in result) {
          return {
            content: [{ type: "text" as const, text: `发票 ${args.invoiceNo} 为历史发票未标注方向，请先确认为销项后重录方向，再进行回款登记` }],
            isError: true as const
          };
        }

        if ("wrongDirection" in result) {
          return {
            content: [{ type: "text" as const, text: `发票 ${args.invoiceNo} 为进项发票（direction='in'），本工具仅用于销项发票回款；进项付款请使用其他工具` }],
            isError: true as const
          };
        }

        if ("alreadySettled" in result) {
          const settledDate = result.settledAt ?? "（日期未知）";
          const settledAmt = result.settledAmountCents != null ? `${result.settledAmountCents / 100} 元` : "（金额未知）";
          return {
            content: [{ type: "text" as const, text: `发票 ${args.invoiceNo} 已于 ${settledDate} 完成回款（实收 ${settledAmt}），不可重复登记。如需修正，请先撤销原回款记录` }],
            isError: true as const
          };
        }

        return {
          content: [{ type: "text" as const, text: `发票 ${args.invoiceNo} 回款登记失败（未知状态）` }],
          isError: true as const
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `回款登记失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }, { riskLevel: "medium" })
  );

  const query = sdk.tool(
    "query_sales_invoices",
    "查询销项发票清单，含发票级账龄分箱（已开票 0-30/31-60/61-90/90+ 天）与回款状态。账龄自开票日起算（正值=已开票天数），与合同层应收账龄（自约定回款日起算）口径不同。",
    {
      asOf: z.string().nullish().describe("查询基准日 YYYY-MM-DD，缺省今日"),
      includeSettled: z.boolean().nullish().describe("是否包含已回款发票，默认 false")
    },
    async (args: { asOf?: string | null; includeSettled?: boolean | null }) => {
      try {
        const rows = listSalesInvoices({
          asOf: args.asOf ?? undefined,
          includeSettled: args.includeSettled ?? false,
        });

        const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);

        // 发票层专属分箱（已开票 0-30 / 31-60 / 61-90 / 90+ 天）
        // B1 符号约定：正值=已开票天数；不复用合同层分箱逻辑
        // WP-D #4: 增加未来日期分箱（agingDays < 0，开票日在基准日之后）
        const futureDated = rows.filter((r) => r.agingDays != null && r.agingDays < 0);
        const bucket0_30 = rows.filter((r) => r.agingDays != null && r.agingDays >= 0 && r.agingDays <= 30);
        const bucket31_60 = rows.filter((r) => r.agingDays != null && r.agingDays >= 31 && r.agingDays <= 60);
        const bucket61_90 = rows.filter((r) => r.agingDays != null && r.agingDays >= 61 && r.agingDays <= 90);
        const bucket90plus = rows.filter((r) => r.agingDays != null && r.agingDays > 90);
        const nullDate = rows.filter((r) => r.agingDays === null && r.settlementStatus !== "settled");

        const sumCents = (arr: typeof rows) => arr.reduce((s, r) => s + r.amountCents, 0);

        const agingSummary = {
          futureDateCount: futureDated.length,
          bucket0_30: { count: bucket0_30.length, amountCents: sumCents(bucket0_30) },
          bucket31_60: { count: bucket31_60.length, amountCents: sumCents(bucket31_60) },
          bucket61_90: { count: bucket61_90.length, amountCents: sumCents(bucket61_90) },
          bucket90plus: { count: bucket90plus.length, amountCents: sumCents(bucket90plus) },
          nullDateCount: nullDate.length,
        };

        const totalUnsettled = rows.filter((r) => r.settlementStatus !== "settled");
        const lines = [
          `销项发票清单（截至 ${asOf}，共 ${rows.length} 张）`,
          `未回款：${totalUnsettled.length} 张`,
          `账龄分箱（已开票天数，正值）：`,
          agingSummary.futureDateCount > 0 ? `  另有 ${agingSummary.futureDateCount} 张开票日期在基准日之后（未来日期），未纳入账龄分箱` : "",
          `  0-30 天: ${agingSummary.bucket0_30.count} 张 / ${(agingSummary.bucket0_30.amountCents / 100).toFixed(2)} 元`,
          `  31-60 天: ${agingSummary.bucket31_60.count} 张 / ${(agingSummary.bucket31_60.amountCents / 100).toFixed(2)} 元`,
          `  61-90 天: ${agingSummary.bucket61_90.count} 张 / ${(agingSummary.bucket61_90.amountCents / 100).toFixed(2)} 元`,
          `  90+ 天: ${agingSummary.bucket90plus.count} 张 / ${(agingSummary.bucket90plus.amountCents / 100).toFixed(2)} 元`,
          agingSummary.nullDateCount > 0 ? `  另有 ${agingSummary.nullDateCount} 张开票日期未知，无法分箱` : "",
          "（账龄口径说明：自开票日起算，与合同层应收账龄方向相反——合同层以约定回款日为基准，负值=逾期）",
        ].filter((l) => l !== "");

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: {
            items: rows,
            agingSummary,
            totalCount: rows.length,
            asOf,
          }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `查询销项发票失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }
  );

  return [recordSales, settle, query];
}
