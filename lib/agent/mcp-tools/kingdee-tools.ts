import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";
import { wrapToolHandler } from "./sdk-types";
import { withIdempotency } from "@/lib/agent/tools/idempotency";
import { loadChartOfAccounts, saveChartOfAccounts, type KingdeeAccount } from "@/lib/db/finance-store";
import { parseChineseAmount, reconcileAmount } from "@/lib/domain/voucher-reconcile";
import { yuanToFen } from "@/lib/domain/money";
import { resolveAccount } from "@/lib/domain/account-mapping";
import { summarizeVouchers, type SlipResult } from "@/lib/domain/voucher-summary";
import { buildVoucherLines, type BuildVoucherInput } from "@/lib/domain/voucher-build";
import { buildVoucherSheet, type VoucherForSheet } from "@/lib/domain/voucher-sheet";

type Sdk = SdkLike;

// 科目表不再写死:由 loadChartOfAccounts() 读公司导入的真表,未导入时回落示例并提示。
const EXAMPLE_NOTICE =
  "⚠ 当前用的是「示例科目表」,科目码/余额非贵司实际。请先用 import_kingdee_accounts 导入贵司金蝶科目表,否则凭证草稿里的科目码导不进你们的金蝶、校验也会拒掉你们的真实科目。";

function getAccountName(code: string, accounts: KingdeeAccount[]): string {
  return accounts.find((a) => a.code === code)?.name ?? code;
}

const queryAccountsSchema = {
  company: z.string().optional().describe("公司名称"),
  accountCode: z.string().optional().describe("科目编码模糊匹配，如6602"),
  accountName: z.string().optional().describe("科目名称模糊匹配，如差旅费"),
  limit: z.number().int().min(1).max(50).default(20).describe("返回条数"),
};

const exportDraftEntrySchema = z.object({
  date: z.string().describe("凭证日期,yyyy-MM-dd"),
  summary: z.string().describe("摘要"),
  debitAccount: z.string().describe("借方科目编码"),
  debitAmount: z.number().positive().describe("借方金额"),
  creditAccount: z.string().describe("贷方科目编码"),
  creditAmount: z.number().positive().describe("贷方金额"),
  attachmentCount: z.number().int().min(0).default(0).describe("附件张数"),
});

const exportDraftSchema = {
  company: z.string().describe("公司名称"),
  period: z.string().describe("会计期间,yyyy-MM"),
  entries: z.array(exportDraftEntrySchema).describe("凭证分录列表"),
  idempotency_key: z.string().optional().describe("幂等键"),
};

const validateVoucherSchema = {
  voucherJson: z.string().describe("JSON格式的凭证草稿"),
};

const importAccountsSchema = {
  accounts: z
    .array(
      z.object({
        code: z.string().describe("科目编码,如6602.01"),
        name: z.string().describe("科目名称"),
        type: z.string().optional().describe("科目类别(资产/负债/权益/收入/费用),拿不准留空"),
        balance: z.number().optional().describe("余额(元),可空"),
      })
    )
    .describe("贵司金蝶导出的科目表(逐条:科目编码 + 名称 + 类别)"),
};

export function createKingdeeTools(sdk: Sdk) {
  const queryAccountsHandler = wrapToolHandler(queryAccountsSchema, async (args: Record<string, unknown>) => {
    const { accountCode, accountName, company, limit } = args as {
      accountCode?: string;
      accountName?: string;
      company?: string;
      limit: number;
    };

    const { accounts: chart, isExample } = loadChartOfAccounts();
    let filtered = [...chart];
    if (accountCode) filtered = filtered.filter((a) => a.code.startsWith(accountCode));
    if (accountName) filtered = filtered.filter((a) => a.name.includes(accountName));
    const accounts = filtered.slice(0, limit);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { accounts, totalCount: filtered.length, company: company ?? "", ...(isExample ? { notice: EXAMPLE_NOTICE } : {}) },
            null,
            2
          ),
        },
      ],
    };
  });

  const exportDraftHandler = wrapToolHandler(exportDraftSchema, async (args: Record<string, unknown>) => {
    const { company, period, entries } = args as {
      company: string;
      period: string;
      entries: Array<{
        date: string;
        summary: string;
        debitAccount: string;
        debitAmount: number;
        creditAccount: string;
        creditAmount: number;
        attachmentCount: number;
      }>;
    };

    if (entries.length === 0) {
      return {
        content: [{ type: "text" as const, text: "凭证分录不能为空，请添加至少一条分录。" }],
        isError: true,
      };
    }

    const { accounts: chart, isExample } = loadChartOfAccounts();
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const randomDigits = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    const draftId = `KD-DRAFT-${dateStr}-${randomDigits}`;

    const totalDebit = entries.reduce((sum, e) => sum + e.debitAmount, 0);
    const totalCredit = entries.reduce((sum, e) => sum + e.creditAmount, 0);
    const balanced = Math.abs(totalDebit - totalCredit) < 0.001;

    const enrichedEntries = entries.map((e, i) => ({
      lineNumber: i + 1,
      date: e.date,
      summary: e.summary,
      debitAccount: e.debitAccount,
      debitAccountName: getAccountName(e.debitAccount, chart),
      debitAmount: e.debitAmount,
      creditAccount: e.creditAccount,
      creditAccountName: getAccountName(e.creditAccount, chart),
      creditAmount: e.creditAmount,
      attachmentCount: e.attachmentCount,
    }));

    const warnings = ["当前为模拟模式，未写入金蝶系统。正式环境需配置金蝶API密钥。"];
    if (isExample) warnings.push(EXAMPLE_NOTICE);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              voucherDraft: {
                id: draftId,
                company,
                period,
                status: "draft",
                preparedBy: "Finance Agent",
                preparedAt: now.toISOString(),
                entries: enrichedEntries,
                totalDebit,
                totalCredit,
                balanced,
                warnings,
              },
              simulated: true,
            },
            null,
            2
          ),
        },
      ],
      structuredContent: {
        id: draftId,
        company,
        period,
        entries: enrichedEntries,
        totalDebit,
        totalCredit,
        balanced,
        simulated: true,
      },
    };
  });

  const validateVoucherHandler = wrapToolHandler(validateVoucherSchema, async (args: Record<string, unknown>) => {
    const { voucherJson } = args as { voucherJson: string };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(voucherJson) as Record<string, unknown>;
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `凭证JSON解析失败：${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }

    const draft = ((parsed.voucherDraft as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
    const entries = (Array.isArray(draft.entries) ? draft.entries : []) as Array<{
      debitAccount?: string;
      debitAmount?: number;
      creditAccount?: string;
      creditAmount?: number;
    }>;
    const totalDebit = (draft.totalDebit as number) ?? 0;
    const totalCredit = (draft.totalCredit as number) ?? 0;

    const { accounts: chart, isExample } = loadChartOfAccounts();
    const errors: string[] = [];
    const warnings: string[] = [];

    if (totalDebit <= 0) errors.push("借方总金额必须大于0");
    if (Math.abs(totalDebit - totalCredit) >= 0.001) {
      errors.push(`借贷不平衡：借方 ${totalDebit.toFixed(2)}，贷方 ${totalCredit.toFixed(2)}`);
    }

    for (const entry of entries) {
      if (entry.debitAccount && !chart.find((a) => a.code === entry.debitAccount)) {
        errors.push(`借方科目编码不存在：${entry.debitAccount}`);
      }
      if (entry.creditAccount && !chart.find((a) => a.code === entry.creditAccount)) {
        errors.push(`贷方科目编码不存在：${entry.creditAccount}`);
      }
    }

    if (entries.length === 0) warnings.push("凭证分录为空");
    if (!draft.company) warnings.push("公司名称未填写");
    if (isExample) warnings.push(EXAMPLE_NOTICE);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ valid: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString() }, null, 2),
        },
      ],
      structuredContent: { valid: errors.length === 0, errors, warnings },
    };
  });

  const importAccountsHandler = wrapToolHandler(importAccountsSchema, async (args: Record<string, unknown>) => {
    const { accounts } = args as { accounts: KingdeeAccount[] };
    const n = saveChartOfAccounts(accounts);
    return {
      content: [
        {
          type: "text" as const,
          text:
            n > 0
              ? `已导入贵司科目表 ${n} 个科目;后续查询/校验/凭证草稿都将基于此表,不再用示例表。`
              : "未导入任何有效科目(每条至少需含 code 与 name)。",
        },
      ],
      structuredContent: { imported: n },
      ...(n === 0 ? { isError: true as const } : {}),
    };
  });

  // ── 金额勾稽:明细Σ/合计/大写三来源交叉验证,不靠 LLM 心算(确定性关键)──
  const checkAmountSchema = {
    lineItemsYuan: z.array(z.number()).optional().describe("各明细行金额(元),如[1377,2323]"),
    totalYuan: z.number().optional().describe("合计金额(元)"),
    capitalText: z.string().optional().describe("大写金额文本,如「叁仟柒佰元整」"),
  };
  const checkAmountHandler = wrapToolHandler(checkAmountSchema, async (args: Record<string, unknown>) => {
    const { lineItemsYuan, totalYuan, capitalText } = args as {
      lineItemsYuan?: number[];
      totalYuan?: number;
      capitalText?: string;
    };
    const capitalFen = capitalText ? parseChineseAmount(capitalText) : null;
    const input: { lineItemsFen?: number[]; totalFen?: number; capitalFen?: number } = {};
    if (lineItemsYuan?.length) input.lineItemsFen = lineItemsYuan.map(yuanToFen);
    if (totalYuan !== undefined) input.totalFen = yuanToFen(totalYuan);
    if (capitalFen != null) input.capitalFen = capitalFen;
    try {
      const result = reconcileAmount(input);
      const note = capitalText && capitalFen == null ? "⚠ 大写金额未能可靠解析,已排除出勾稽,请人工核对大写。" : undefined;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...result, ...(note ? { note } : {}) }, null, 2) }],
        structuredContent: result,
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `金额勾稽失败:${e instanceof Error ? e.message : String(e)}` }],
        isError: true as const,
      };
    }
  });

  // ── 科目映射:对照表命中→科目表验证→维度类型带出(编码必须存在才输出)──
  const mapAccountSchema = {
    text: z.string().describe("摘要/收款方文本,如「付杰强劳务费」"),
    mappings: z
      .array(z.object({ keyword: z.string(), code: z.string(), dimensionValue: z.string().optional() }))
      .describe("从知识库对照表(search_knowledge)查到的条目:关键词→科目码→维度值"),
  };
  const mapAccountHandler = wrapToolHandler(mapAccountSchema, async (args: Record<string, unknown>) => {
    const { text, mappings } = args as {
      text: string;
      mappings: Array<{ keyword: string; code: string; dimensionValue?: string }>;
    };
    const { accounts: chart, isExample } = loadChartOfAccounts();
    const result = resolveAccount(text, mappings, chart);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ...result, ...(isExample ? { notice: EXAMPLE_NOTICE } : {}) }, null, 2) }],
      structuredContent: result,
    };
  });

  // ── 汇总:聚合每张单据的金额/科目结论为大表 + 统计(失败行跳过不干扰)──
  const summarizeSchema = {
    results: z
      .array(
        z.object({
          file: z.string(),
          ocrOk: z.boolean(),
          amountOk: z.boolean().optional(),
          amountIssue: z.string().optional(),
          accountOk: z.boolean().optional(),
          accountIssue: z.string().optional(),
        })
      )
      .describe("每张单据的处理结论"),
  };
  const summarizeHandler = wrapToolHandler(summarizeSchema, async (args: Record<string, unknown>) => {
    const { results } = args as { results: SlipResult[] };
    const summary = summarizeVouchers(results);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  });

  // ── 多行凭证构造 + 预借款冲销:费用明细→多借方行;「原借款」有金额→冲销分录 ──
  const buildVoucherSchema = {
    expenses: z
      .array(
        z.object({
          summary: z.string(),
          account: z.string(),
          accountName: z.string().optional(),
          dimensionValue: z.string().optional(),
          amountYuan: z.number(),
        })
      )
      .describe("费用明细借方行(每行一个科目)"),
    paymentAccount: z.object({ code: z.string(), name: z.string().optional() }).describe("付款科目(银行/现金)"),
    departmentName: z.string().optional().describe("报销部门(费用行默认核算维度值)"),
    advanceYuan: z.number().optional().describe("单据「原借款」栏金额;>0 走冲销分录,空/0 走普通"),
    advanceAccount: z.object({ code: z.string(), name: z.string().optional() }).optional().describe("预借款科目,默认其他应收款-个人往来 1221.03"),
    payeeName: z.string().optional().describe("报销人(冲销行核算维度=员工)"),
  };
  const buildVoucherHandler = wrapToolHandler(buildVoucherSchema, async (args: Record<string, unknown>) => {
    const built = buildVoucherLines(args as unknown as BuildVoucherInput);
    const warn = built.balanced ? "" : "\n⚠ 借贷不平衡,请检查明细。";
    return {
      content: [{ type: "text" as const, text: JSON.stringify(built, null, 2) + warn }],
      structuredContent: built,
    };
  });

  // ── 凭证 → 金蝶对照手填清单(行数据,列对齐录入界面);实际 xlsx 由 run_python 写 ──
  const buildSheetSchema = {
    vouchers: z
      .array(
        z.object({
          date: z.string(),
          voucherWord: z.string().optional(),
          lines: z.array(
            z.object({
              summary: z.string(),
              account: z.string(),
              accountName: z.string().optional(),
              dimensionType: z.string().optional(),
              dimensionValue: z.string().optional(),
              debitYuan: z.number().optional(),
              creditYuan: z.number().optional(),
            })
          ),
        })
      )
      .describe("确认后的凭证列表(每张含日期+多行分录)"),
  };
  const buildSheetHandler = wrapToolHandler(buildSheetSchema, async (args: Record<string, unknown>) => {
    const { vouchers } = args as { vouchers: VoucherForSheet[] };
    const sheet = buildVoucherSheet(vouchers);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(sheet, null, 2) }],
      structuredContent: sheet,
    };
  });

  return [
    sdk.tool("query_kingdee_accounts", "查询金蝶科目表(贵司导入的真表;未导入则用示例表并提示),支持按公司名、科目编码、科目名称过滤。返回科目列表含编码、名称、类型、余额。", queryAccountsSchema, queryAccountsHandler),
    sdk.tool("build_voucher_sheet", "把确认后的凭证整理成金蝶「对照手填清单」行数据(表头+行,列对齐录入界面:日期/凭证字/摘要/科目编码/科目全名/核算维度/借方/贷方,借贷分列)。拿到后用 run_python(openpyxl)写成 xlsx 交付。", buildSheetSchema, buildSheetHandler),
    sdk.tool("build_voucher_lines", "构造多行凭证分录:传费用明细(多借方)+付款科目,自动配平出贷方。单据「原借款」栏有金额时(advanceYuan>0)自动生成预借款冲销:贷其他应收款-个人往来(挂报销人)、差额进银行(应退借/应补贷)。返回多行借贷+是否平衡。", buildVoucherSchema, buildVoucherHandler),
    sdk.tool("check_voucher_amount", "金额勾稽校验:传明细行/合计/大写(元 + 大写文本),校验三者是否一致。一致→高置信度可自动用;不平→指出对不上处、列候选值,交人工。大写解析在工具内做,不要 LLM 心算。", checkAmountSchema, checkAmountHandler),
    sdk.tool("map_voucher_account", "科目映射:传摘要文本 + 从知识库查到的对照表条目,返回科目编码(经科目表验证存在才输出)、名称、维度类型。未命中/编码失效会明确告知,不编造科目码。", mapAccountSchema, mapAccountHandler),
    sdk.tool("summarize_vouchers", "汇总一批单据的处理结论为大表 + 统计(✅自动/⚠️待确认/❌失败)。用于汇总确认模式:全部识别完出大表,用户挑⚠️行集中确认。", summarizeSchema, summarizeHandler),
    sdk.tool("export_kingdee_draft", "导出一批记账凭证为金蝶K/3 Cloud格式草稿。当前为模拟模式生成JSON草稿供预览，不写入真实金蝶系统。", exportDraftSchema, withIdempotency("export_kingdee_draft", exportDraftHandler, { riskLevel: "high" })),
    sdk.tool("validate_kingdee_voucher", "校验金蝶凭证草稿的借贷平衡、科目有效性(对照贵司导入的科目表)、期间正确性。返回校验结果含错误列表和警告。", validateVoucherSchema, validateVoucherHandler),
    sdk.tool("import_kingdee_accounts", "导入贵司金蝶科目表(科目编码+名称+类别),覆盖此前导入。导入后查询/校验/凭证草稿都基于此表,不再用示例表。用户上传科目表后先调本工具。", importAccountsSchema, withIdempotency("import_kingdee_accounts", importAccountsHandler, { riskLevel: "medium" })),
  ];
}
