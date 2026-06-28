import { reconcileBankStatement, type ReconInputRow } from "@/lib/domain/reconciliation";
import { z } from "zod/v4";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = { tool: (name: string, desc: string, schema: any, handler: (args: any) => any) => any };

const MAX_LIST = 15;

export function createReconciliationTools(sdk: Sdk) {
  const reconcile = sdk.tool(
    "reconcile_bank_statement",
    [
      "银行流水对账(只读,只核对差异,不涉及任何付款/转账):把银行流水与账面/台账两张表按方向+金额+日期容差勾对,输出已匹配、银行有账无、账有银行无,以及疑似拆分/合并的清单。",
      "【调用前置】各家银行流水格式不同,请先用 run_python(或 xlsx 技能)把两张表整理成结构化行(date/amount/direction)再调用本工具。",
      "【差异处理】所有差异项(银行有账无/账有银行无/疑似拆合并)均需人工逐笔确认后再处理,本工具不会自动修账。"
    ].join("\n"),
    {
      bankRows: z
        .array(
          z.object({
            date: z.string().describe("交易日期 YYYY-MM-DD"),
            amount: z.number().describe("金额(正数,元),方向由 direction 决定"),
            direction: z.enum(["in", "out"]).describe("in=收入/进账 | out=支出/出账"),
            description: z.string().nullish().describe("摘要(可选)"),
            counterparty: z.string().nullish().describe("对方户名(可选)")
          })
        )
        .describe("银行流水行"),
      bookRows: z
        .array(
          z.object({
            date: z.string().describe("入账日期 YYYY-MM-DD"),
            amount: z.number().describe("金额(正数,元)"),
            direction: z.enum(["in", "out"]).describe("in=收入 | out=支出"),
            description: z.string().nullish().describe("摘要(可选)"),
            counterparty: z.string().nullish().describe("对方/科目(可选)")
          })
        )
        .describe("账面/台账行"),
      dateWindowDays: z.number().int().nullish().describe("日期容差窗口(天),默认 0=要求同一天。银行入账与记账有时差时可放宽到 1-3 天")
    },
    async (args: { bankRows: ReconInputRow[]; bookRows: ReconInputRow[]; dateWindowDays?: number | null }) => {
      try {
        if (args.bankRows.length === 0 && args.bookRows.length === 0) {
          return {
            content: [{ type: "text" as const, text: "没有可对账的数据:银行流水与账面都为空。" }],
            isError: true as const
          };
        }

        const result = reconcileBankStatement(args.bankRows, args.bookRows, {
          dateWindowDays: args.dateWindowDays ?? 0
        });
        const s = result.summary;

        const lines: string[] = [
          s.balanced
            ? `✓ 账银两平:${s.matchedCount} 笔全部勾对,无差异(银行 ${s.bankCount} 笔 / 账面 ${s.bookCount} 笔)。`
            : `对账完成:已勾对 ${s.matchedCount} 笔;银行有账无 ${result.bankOnly.length} 笔(¥${s.bankOnlyTotal.toFixed(2)})、账有银行无 ${result.bookOnly.length} 笔(¥${s.bookOnlyTotal.toFixed(2)})、疑似拆分/合并 ${result.needsReview.length} 组,需人工核对。`
        ];

        if (result.needsReview.length > 0) {
          lines.push("【疑似拆分/合并,需人工(未自动匹配)】");
          for (const g of result.needsReview.slice(0, MAX_LIST)) lines.push(`- ${g.note}`);
        }
        if (result.bankOnly.length > 0) {
          lines.push("【银行有、账上无(按金额倒序,可能漏记账或未达账)】");
          for (const r of result.bankOnly.slice(0, MAX_LIST)) lines.push(fmtRow(r));
          if (result.bankOnly.length > MAX_LIST) lines.push(`  …还有 ${result.bankOnly.length - MAX_LIST} 笔,见结构化结果`);
        }
        if (result.bookOnly.length > 0) {
          lines.push("【账上有、银行无(按金额倒序,可能未达账或重复记账)】");
          for (const r of result.bookOnly.slice(0, MAX_LIST)) lines.push(fmtRow(r));
          if (result.bookOnly.length > MAX_LIST) lines.push(`  …还有 ${result.bookOnly.length - MAX_LIST} 笔,见结构化结果`);
        }
        lines.push("提示:本工具只做核对与提示,不涉及任何付款或转账;差异请人工确认后再处理。");

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: result
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `对账失败:${error instanceof Error ? error.message : String(error)}` }],
          isError: true as const
        };
      }
    }
  );

  return [reconcile];
}

function fmtRow(r: { date: string; amount: number; direction: "in" | "out"; description?: string | null; counterparty?: string | null }): string {
  const dir = r.direction === "in" ? "进" : "出";
  const extra = [r.counterparty, r.description].filter(Boolean).join(" / ");
  return `- ${r.date} | ${dir} | ¥${r.amount.toFixed(2)}${extra ? ` | ${extra}` : ""}`;
}
