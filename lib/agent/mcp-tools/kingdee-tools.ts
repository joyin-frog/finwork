import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";
import { wrapToolHandler } from "./sdk-types";
import { withIdempotency } from "@/lib/agent/tools/idempotency";
import { loadChartOfAccounts, saveChartOfAccounts, type KingdeeAccount } from "@/lib/db/finance-store";

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

  return [
    sdk.tool("query_kingdee_accounts", "查询金蝶科目表(贵司导入的真表;未导入则用示例表并提示),支持按公司名、科目编码、科目名称过滤。返回科目列表含编码、名称、类型、余额。", queryAccountsSchema, queryAccountsHandler),
    sdk.tool("export_kingdee_draft", "导出一批记账凭证为金蝶K/3 Cloud格式草稿。当前为模拟模式生成JSON草稿供预览，不写入真实金蝶系统。", exportDraftSchema, withIdempotency("export_kingdee_draft", exportDraftHandler, { riskLevel: "high" })),
    sdk.tool("validate_kingdee_voucher", "校验金蝶凭证草稿的借贷平衡、科目有效性(对照贵司导入的科目表)、期间正确性。返回校验结果含错误列表和警告。", validateVoucherSchema, validateVoucherHandler),
    sdk.tool("import_kingdee_accounts", "导入贵司金蝶科目表(科目编码+名称+类别),覆盖此前导入。导入后查询/校验/凭证草稿都基于此表,不再用示例表。用户上传科目表后先调本工具。", importAccountsSchema, withIdempotency("import_kingdee_accounts", importAccountsHandler, { riskLevel: "medium" })),
  ];
}
