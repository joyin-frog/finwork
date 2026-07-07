import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
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
import { validateVoucherDimensions } from "@/lib/domain/voucher-dimension-validate";
import { buildVoucherSheet, type VoucherForSheet } from "@/lib/domain/voucher-sheet";
import { processVoucherBatch, type BatchSlip } from "@/lib/domain/voucher-batch";
import { getPythonPath, getProjectRoot, getAppDataDir } from "@/lib/runtime/paths";
import { pythonSpawnEnv } from "@/lib/runtime/python-env";

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

export function createKingdeeTools(sdk: Sdk, outputDir?: string) {
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

  // ── 批量:一次处理整批单据(勾稽+映射+分录+汇总+清单),把 40+ 次 LLM 往返压成 1 次 ──
  const batchSchema = {
    slips: z
      .array(
        z.object({
          file: z.string(),
          date: z.string().describe("凭证日期 yyyy-MM-dd"),
          lineItems: z.array(z.object({ summary: z.string(), amountYuan: z.number() })).describe("费用明细行"),
          totalYuan: z.number().optional().describe("合计(元)"),
          capitalText: z.string().optional().describe("大写金额文本"),
          advanceYuan: z.number().optional().describe("单据「原借款」栏金额,>0 走冲销"),
          payeeName: z.string().optional().describe("报销人(冲销行维度)"),
          departmentName: z.string().optional().describe("报销部门(费用行维度)"),
          direction: z.enum(["expense", "income"]).optional().describe("资金方向,从单据本身的收/支继承:支出(默认)或收入(如结息,明细行记贷方、银行行记借方)"),
          payerBankName: z.string().optional().describe("本张单据 OCR 出的付款银行/账户名,用作银行存款行的「银行账号」维度;识别不到就不传,严禁沿用其他单据的银行"),
        })
      )
      .describe("整批单据(每张:字段已由 read_document + 提取得到)"),
    mappings: z
      .array(z.object({ keyword: z.string(), code: z.string(), dimensionValue: z.string().optional() }))
      .default([])
      .describe("从知识库对照表查到的条目(没有则传空)"),
    paymentAccount: z.object({ code: z.string(), name: z.string().optional() }).optional().describe("付款科目,默认银行存款1002"),
    advanceAccount: z.object({ code: z.string(), name: z.string().optional() }).optional().describe("预借款科目,默认其他应收款-个人往来1221.03"),
  };
  const batchHandler = wrapToolHandler(batchSchema, async (args: Record<string, unknown>) => {
    const { slips, mappings, paymentAccount, advanceAccount } = args as {
      slips: BatchSlip[];
      mappings: Array<{ keyword: string; code: string; dimensionValue?: string }>;
      paymentAccount?: { code: string; name?: string };
      advanceAccount?: { code: string; name?: string };
    };
    const { accounts: chart, isExample } = loadChartOfAccounts();
    const out = processVoucherBatch({
      slips,
      mappings: mappings ?? [],
      chart,
      paymentAccount: paymentAccount ?? { code: "1002", name: "银行存款" },
      advanceAccount: advanceAccount ?? { code: "1221.03", name: "其他应收款-个人往来" },
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ...out, ...(isExample ? { notice: EXAMPLE_NOTICE } : {}) }, null, 2) }],
      structuredContent: out,
    };
  });

  // ── export_voucher_list:确定性出三 sheet xlsx,把最后一公里从 LLM 手里拿走 ──
  type VoucherLineInput = {
    summary: string;
    account: string;
    accountName?: string;
    dimensionType?: string;
    dimensionValue?: string;
    debitYuan?: number;
    creditYuan?: number;
  };
  type VoucherInput = {
    file: string;
    date: string;
    status: string;
    lines: VoucherLineInput[];
    issues?: string[];
    voucherWord?: string;
  };
  type SkippedInput = {
    file: string;
    reason: string;
    summary?: string;
    amountYuan?: number;
  };

  const exportVoucherListSchema = {
    vouchers: z
      .array(
        z.object({
          file: z.string(),
          date: z.string().describe("凭证日期 yyyy-MM-dd"),
          status: z.string().describe("auto / confirmed / needs_confirm"),
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
          issues: z.array(z.string()).optional(),
          voucherWord: z.string().optional(),
        })
      )
      .describe("已确认凭证列表(process_voucher_batch 输出结构)"),
    skipped: z
      .array(
        z.object({
          file: z.string(),
          reason: z.string(),
          summary: z.string().optional(),
          amountYuan: z.number().optional(),
        })
      )
      .optional()
      .describe("被跳过/排除的单据"),
    chart: z
      .array(
        z.object({
          code: z.string(),
          name: z.string(),
          type: z.string().optional(),
          balance: z.number().optional(),
          dimension: z.string().optional(),
        })
      )
      .optional()
      .describe("科目表条目,供维度合法性校验"),
    fileName: z.string().optional().describe("输出文件名,默认:金蝶对照手填清单.xlsx"),
  };

  const exportVoucherListHandler = wrapToolHandler(exportVoucherListSchema, async (args: Record<string, unknown>) => {
    const { vouchers, skipped, chart, fileName } = args as {
      vouchers: VoucherInput[];
      skipped?: SkippedInput[];
      chart?: KingdeeAccount[];
      fileName?: string;
    };

    // 阻断性校验只作用于将写入「对照清单」的确认凭证;needs_confirm 本就不完整,
    // 只进「待确认与跳过」sheet,不应阻断整批导出
    const confirmedVouchers = vouchers.filter((v) => v.status !== "needs_confirm");

    // ① 借贷平衡校验(整数分)
    const balanceErrors: string[] = [];
    for (const v of confirmedVouchers) {
      let debitFen = 0;
      let creditFen = 0;
      for (const l of v.lines) {
        debitFen += l.debitYuan != null ? yuanToFen(l.debitYuan) : 0;
        creditFen += l.creditYuan != null ? yuanToFen(l.creditYuan) : 0;
      }
      if (debitFen !== creditFen) {
        balanceErrors.push(
          `${v.file}(${v.date}): 借方 ${(debitFen / 100).toFixed(2)} ≠ 贷方 ${(creditFen / 100).toFixed(2)},不平衡`
        );
      }
    }
    if (balanceErrors.length > 0) {
      return {
        content: [{ type: "text" as const, text: `导出失败:以下凭证借贷不平衡,已拒绝落文件:\n${balanceErrors.join("\n")}` }],
        isError: true as const,
      };
    }

    // ② 维度合法性校验(有科目表时,同样只校验确认凭证)
    if (chart && chart.length > 0) {
      const dimErrors: string[] = [];
      for (const v of confirmedVouchers) {
        const result = validateVoucherDimensions(v.lines, chart);
        for (const err of result.errors) {
          dimErrors.push(`${v.file}: ${err}`);
        }
      }
      if (dimErrors.length > 0) {
        return {
          content: [{ type: "text" as const, text: `导出失败:以下凭证维度错误,已拒绝落文件:\n${dimErrors.join("\n")}` }],
          isError: true as const,
        };
      }
    }

    // ③ 确定输出目录和文件路径。fileName 取 basename 防路径穿越("../x"),并强制 .xlsx 后缀
    const outDir = outputDir ?? process.env.FINANCE_AGENT_OUTPUT_DIR ?? path.join(getAppDataDir(), "exports");
    mkdirSync(outDir, { recursive: true });
    let outFileName = path.basename(fileName ?? "金蝶对照手填清单.xlsx");
    if (!outFileName.toLowerCase().endsWith(".xlsx")) outFileName += ".xlsx";
    const outputPath = path.join(outDir, outFileName);

    // ④ 调用 Python worker 生成 xlsx
    const payload = JSON.stringify({ outputPath, vouchers, skipped: skipped ?? [] });
    const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
    try {
      const out = execFileSync(getPythonPath(), [workerPath, "export-voucher-xlsx"], {
        input: payload,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
        env: pythonSpawnEnv(),
      });
      const result = JSON.parse(out.trim()) as { filePath: string };
      // worker 侧防覆盖可能版本化为 _v2:回显真实落盘文件名,别让模型/附件流拿旧名找不到文件
      const savedName = path.basename(result.filePath);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              filePath: result.filePath,
              fileName: savedName,
              sheets: ["对照清单", "汇总", "待确认与跳过"],
              voucherCount: vouchers.length,
              skippedCount: (skipped ?? []).length,
            }, null, 2),
          },
        ],
        structuredContent: { filePath: result.filePath, fileName: savedName },
      };
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const hint = (e.stderr ?? "").toString().trim() || (e as { message?: string }).message || "未知错误";
      return {
        content: [{ type: "text" as const, text: `xlsx 生成失败:${hint.slice(0, 1000)}` }],
        isError: true as const,
      };
    }
  });

  return [
    sdk.tool("query_kingdee_accounts", "查询金蝶科目表(贵司导入的真表;未导入则用示例表并提示),支持按公司名、科目编码、科目名称过滤。返回科目列表含编码、名称、类型、余额。", queryAccountsSchema, queryAccountsHandler),
    sdk.tool("process_voucher_batch", "【批量·首选】一次处理整批单据:传所有单据的字段(每张:日期/费用明细/金额/大写/原借款/部门),内部逐张做金额勾稽+科目映射+分录构造(含预借款冲销)+汇总+出对照清单,一次返回。用它避免逐张逐工具几十次往返导致超时。科目表工具内部自动读。", batchSchema, batchHandler),
    sdk.tool("build_voucher_sheet", "把确认后的凭证整理成金蝶「对照手填清单」行数据(表头+行,列对齐录入界面:日期/凭证字/摘要/科目编码/科目全名/核算维度/借方/贷方,借贷分列)。拿到后用 run_python(openpyxl)写成 xlsx 交付。", buildSheetSchema, buildSheetHandler),
    sdk.tool("build_voucher_lines", "构造多行凭证分录:传费用明细(多借方)+付款科目,自动配平出贷方。单据「原借款」栏有金额时(advanceYuan>0)自动生成预借款冲销:贷其他应收款-个人往来(挂报销人)、差额进银行(应退借/应补贷)。返回多行借贷+是否平衡。", buildVoucherSchema, buildVoucherHandler),
    sdk.tool("check_voucher_amount", "金额勾稽校验:传明细行/合计/大写(元 + 大写文本),校验三者是否一致。一致→高置信度可自动用;不平→指出对不上处、列候选值,交人工。大写解析在工具内做,不要 LLM 心算。", checkAmountSchema, checkAmountHandler),
    sdk.tool("map_voucher_account", "科目映射:传摘要文本 + 从知识库查到的对照表条目,返回科目编码(经科目表验证存在才输出)、名称、维度类型。未命中/编码失效会明确告知,不编造科目码。", mapAccountSchema, mapAccountHandler),
    sdk.tool("summarize_vouchers", "汇总一批单据的处理结论为大表 + 统计(✅自动/⚠️待确认/❌失败)。用于汇总确认模式:全部识别完出大表,用户挑⚠️行集中确认。", summarizeSchema, summarizeHandler),
    sdk.tool("export_kingdee_draft", "导出一批记账凭证为金蝶K/3 Cloud格式草稿。当前为模拟模式生成JSON草稿供预览，不写入真实金蝶系统。", exportDraftSchema, withIdempotency("export_kingdee_draft", exportDraftHandler, { riskLevel: "high" })),
    sdk.tool("validate_kingdee_voucher", "校验金蝶凭证草稿的借贷平衡、科目有效性(对照贵司导入的科目表)、期间正确性。返回校验结果含错误列表和警告。", validateVoucherSchema, validateVoucherHandler),
    sdk.tool("import_kingdee_accounts", "导入贵司金蝶科目表(科目编码+名称+类别),覆盖此前导入。导入后查询/校验/凭证草稿都基于此表,不再用示例表。用户上传科目表后先调本工具。", importAccountsSchema, withIdempotency("import_kingdee_accounts", importAccountsHandler, { riskLevel: "medium" })),
    sdk.tool("export_voucher_list", "【最终交付】把确认好的凭证列表导出为三 sheet xlsx:①对照清单(每行:日期/凭证字/摘要/科目编码/科目全名/核算维度类型/核算维度值/借方/贷方)②汇总(按科目+按文件小计)③待确认与跳过。导出前自动做借贷平衡+维度合法性双校验,违规返回错误不落文件。禁止用 run_python+openpyxl 手拼凭证行——统一用本工具。", exportVoucherListSchema, exportVoucherListHandler),
  ];
}
