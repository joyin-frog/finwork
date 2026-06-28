import { sortReimbursementsByRisk, validateReimbursements } from "@/lib/domain/reimbursement";
import { findInvoicesInLedger, loadReimbursementSingleLimit, recordInvoices } from "@/lib/db/finance-store";
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
        const abnormalCount = results.filter((r) => r.warnings.length > 0).length;
        const summary =
          abnormalCount > 0
            ? `共 ${results.length} 条,${abnormalCount} 条有异常(已按风险排序,历史重复最优先)`
            : `共 ${results.length} 条,全部通过校验(含发票台账跨月查重)`;

        const lines = [
          summary,
          ...results.map((r) =>
            r.warnings.length
              ? `- ${r.employeeName} | ${r.expenseDate} | ${r.category} | ¥${r.amount} | ${r.invoiceNo} → ⚠ ${r.warnings.join("；")}`
              : `- ${r.employeeName} | ${r.expenseDate} | ${r.category} | ¥${r.amount} | ${r.invoiceNo} → ✓`
          )
        ];
        if (results.length > 0) {
          lines.push("提醒:财务确认通过后,请让我把通过的发票登记台账(record_reimbursement_invoices),否则下月跨月查重会漏掉这批发票。");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: { results, summary, abnormalCount }
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
            category: z.string().nullish().describe("费用类目")
          })
        )
        .describe("要登记的发票列表"),
      conversationId: z.number().nullish().describe("当前会话 ID,用于溯源")
    },
    withIdempotency("record_reimbursement_invoices", async (args: {
      items: Array<{ invoiceNo: string; amount: number; invoiceDate?: string | null; category?: string | null }>;
      conversationId?: number | null;
    }) => {
      const { inserted, duplicates } = recordInvoices(
        args.items.map((i) => ({
          invoiceNo: i.invoiceNo,
          amount: i.amount,
          invoiceDate: i.invoiceDate ?? undefined,
          category: i.category ?? undefined,
          conversationId: args.conversationId ?? undefined
        }))
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
