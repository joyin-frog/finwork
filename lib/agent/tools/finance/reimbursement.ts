import { sortReimbursementsByRisk, validateReimbursements } from "@/lib/domain/reimbursement";
import { findInvoicesInLedger, loadReimbursementSingleLimit, recordInvoices } from "@/lib/db/finance-store";
import { saveCalcReceiptSafe } from "@/lib/db/receipt-store";
import { getDb } from "@/lib/db/sqlite";
import type { ReimbursementItem } from "@/lib/types";
import { z } from "zod/v4";
import { withIdempotency } from "@/lib/agent/tools/idempotency";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = { tool: (name: string, desc: string, schema: any, handler: (args: any) => any) => any };

export function createReimbursementTools(sdk: Sdk) {
  const check = sdk.tool(
    "check_reimbursement_batch",
    "校验报销单批次(只读,不改任何数据):缺字段、金额异常、单笔超标、批内发票号重复,并对照发票台账检出跨月历史重复报销。输出按风险排序的异常清单。生成报销汇总或确认报销通过前必须先调用。",
    {
      items: z
        .array(
          z.object({
            employeeName: z.string().describe("员工姓名"),
            expenseDate: z.string().describe("报销日期,格式 YYYY-MM-DD"),
            invoiceNo: z.string().describe("发票号码"),
            category: z.string().describe("费用类目,如:差旅、餐饮、招待"),
            amount: z.number().describe("报销金额(元)")
          })
        )
        .describe("报销条目列表"),
      singleLimit: z.number().nullish().describe("单笔上限(元),不传则用设置中的公司单笔上限(默认 1500)")
    },
    async (args: { items: Omit<ReimbursementItem, "warnings">[]; singleLimit?: number | null }) => {
      try {
        const singleLimit = args.singleLimit ?? loadReimbursementSingleLimit();
        const history = findInvoicesInLedger(args.items.map((i) => i.invoiceNo));
        const results = sortReimbursementsByRisk(
          validateReimbursements(args.items, { singleLimit }, history)
        );
        // WP4b: 落库每条报销 receipt，wrapper 增 receiptId（降级不阻断）
        const db = getDb();
        const resultsWithReceiptId = results.map((r) => {
          const receiptId = r.receipt
            ? saveCalcReceiptSafe(db, { toolName: "check_reimbursement_batch", receipt: r.receipt }, `reimbursement(${r.invoiceNo})`)
            : undefined;
          return receiptId !== undefined ? { ...r, receiptId } : r;
        });
        const abnormalCount = resultsWithReceiptId.filter((r) => r.warnings.length > 0).length;
        const summary =
          abnormalCount > 0
            ? `共 ${resultsWithReceiptId.length} 条,${abnormalCount} 条有异常(已按风险排序,历史重复最优先)`
            : `共 ${resultsWithReceiptId.length} 条,全部通过校验(含发票台账跨月查重)`;

        const lines = [
          summary,
          ...resultsWithReceiptId.map((r) =>
            r.warnings.length
              ? `- ${r.employeeName} | ${r.expenseDate} | ${r.category} | ¥${r.amount} | ${r.invoiceNo} → ⚠ ${r.warnings.join("；")}`
              : `- ${r.employeeName} | ${r.expenseDate} | ${r.category} | ¥${r.amount} | ${r.invoiceNo} → ✓`
          )
        ];
        if (resultsWithReceiptId.length > 0) {
          lines.push("提醒:财务确认通过后,请让我把通过的发票登记台账(record_reimbursement_invoices),否则下月跨月查重会漏掉这批发票。");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: { results: resultsWithReceiptId, summary, abnormalCount }
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `报销校验失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }
  );

  const record = sdk.tool(
    "record_reimbursement_invoices",
    "把财务确认通过的报销发票登记进发票台账(今后跨月重复报销可被检出),写审计日志。必须在财务明确确认报销通过后调用;已在台账的发票会显式报告且不会重复登记。",
    {
      items: z
        .array(
          z.object({
            invoiceNo: z.string().describe("发票号码"),
            amount: z.number().describe("发票金额(元)"),
            invoiceDate: z.string().nullish().describe("开票日期 YYYY-MM-DD"),
            category: z.string().nullish().describe("费用类目"),
            taxRate: z.string().nullish().describe("适用税率(小数形式,如 '0.09'),可选;须满足 0 < rate < 1"),
            taxAmountYuan: z.number().nullish().describe("税额(元),可选;入库自动转换为分"),
            counterparty: z.string().nullish().describe("开票方名称(供应商/客户),可选")
          })
        )
        .describe("要登记的发票列表"),
      conversationId: z.number().nullish().describe("当前会话 ID,用于溯源")
    },
    withIdempotency("record_reimbursement_invoices", async (args: {
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
      // 校验并转换 taxRate（数字字符串，0 < rate < 1）
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
            direction: "in" as const,
            certificationStatus: null,
          };
        })
      );
      const lines = [`已登记 ${inserted.length} 张发票进台账(已写审计日志)`];
      if (duplicates.length > 0) {
        lines.push(
          `⚠ ${duplicates.length} 张发票已在台账中,未重复登记——请人工核实是否重复报销:`,
          ...duplicates.map((d) => `  - ${d.invoiceNo}(${d.recordedAt.slice(0, 7)} 已登记)`)
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { inserted, duplicates }
      };
    }, { riskLevel: "medium" })
  );

  return [check, record];
}
