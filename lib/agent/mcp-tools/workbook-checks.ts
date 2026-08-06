import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { z } from "zod/v4";
import { spreadsheetInspectCells } from "@/lib/runtime/spreadsheet-runtime";
import { checkWorkbookTies, type TieCheck } from "@/lib/domain/workbook-ties";
import { detectDataIssues, type DataRow } from "@/lib/domain/data-quality";
import { mergeLabeledTables, type MergeSource } from "@/lib/domain/table-merge";
import type { SdkLike } from "./sdk-types";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

function resolveInRoots(filePath: string, roots: string[]): string | null {
  if (!filePath || !existsSync(filePath)) return null;
  const resolved = realpathSync(path.resolve(filePath));
  const allowed = roots.flatMap((root) => {
    try {
      return [realpathSync(path.resolve(root))];
    } catch {
      return [];
    }
  });
  return allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    ? resolved
    : null;
}

/** 跨表勾稽:声明式核对「一组单元格之和 = 另一组之和」。 */
export function createCheckWorkbookTiesTool(
  sdk: SdkLike,
  options: { outputDir: string; allowedReadRoots?: string[] },
) {
  return sdk.tool(
    "check_workbook_ties",
    [
      "跨表/跨 sheet 勾稽核对：确定性验证「一组单元格之和 = 另一组之和」。",
      "用于资产=负债+所有者权益、分季合计=全年、现金流量表期末现金=资产负债表货币资金等核对。",
      "**不要心算或用脚本比对金额**——本工具读取真实缓存值并按容差判定，结果可复现。",
      "读不到值（公式无缓存等）会判「未验证」而不是「不平」，不会冤枉数据。",
    ].join("\n"),
    {
      filePath: z.string().describe("工作簿绝对路径"),
      checks: z.array(z.object({
        label: z.string().describe("这条勾稽的名称，如「资产=负债+权益」"),
        left: z.array(z.string()).min(1).describe("等式左边地址，如 [\"资产负债表!C59\"]；多个求和"),
        right: z.array(z.string()).min(1).describe("等式右边地址；多个求和"),
        tolerance: z.number().optional().describe("绝对容差，默认 0.01"),
        relativeTolerance: z.number().optional().describe("相对容差（占左值比例）"),
      })).min(1).max(200),
    },
    async (args: { filePath: string; checks: TieCheck[] }) => {
      const resolved = resolveInRoots(args.filePath, [
        options.outputDir,
        ...(options.allowedReadRoots ?? []),
      ]);
      if (!resolved) {
        return {
          content: [{ type: "text" as const, text: `文件不存在或不在允许目录内：${args.filePath}` }],
          isError: true as const,
        };
      }
      const addresses = [...new Set(args.checks.flatMap((check) => [...check.left, ...check.right]))];
      const read = await spreadsheetInspectCells(resolved, addresses);
      if (!read.ok || !read.data) {
        return {
          content: [{ type: "text" as const, text: `读取单元格失败：${read.detail ?? read.errorCode}` }],
          isError: true as const,
        };
      }
      const results = checkWorkbookTies(read.data.values, args.checks);
      const counts = {
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status === "failed").length,
        unverifiable: results.filter((r) => r.status === "unverifiable").length,
      };
      const lines = [
        `勾稽核对：通过 ${counts.passed}、不平 ${counts.failed}、未验证 ${counts.unverifiable}`,
        ...results.map((r) => `${r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⚠️"} ${r.label}：${r.detail}`),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

/** 数据质量检测:重复、缺失、离群、负数。检查项必须声明,不猜。 */
export function createDetectDataIssuesTool(sdk: SdkLike) {
  return sdk.tool(
    "detect_data_issues",
    [
      "对结构化数据行做确定性质量检测：重复键、必填缺失、离群值（IQR）、不应为负的负数。",
      "**要检查什么必须显式声明**——本工具不猜测哪列是主键、哪列必填。",
      "离群值用箱线图 1.5×IQR 口径；样本少于 8 条时不给判定，避免不可靠结论。",
      "用于「找出金额异常」「查重复凭证」「检查必填项」这类要求；不要用脚本自行判断。",
    ].join("\n"),
    {
      rows: z.array(z.record(z.string(), scalar)).min(1).max(5000).describe("结构化数据行"),
      keyFields: z.array(z.string()).optional().describe("组成唯一键的字段，用于查重"),
      requiredFields: z.array(z.string()).optional().describe("必须有值的字段"),
      numericFields: z.array(z.string()).optional().describe("参与离群检测的数值字段"),
      nonNegativeFields: z.array(z.string()).optional().describe("不允许为负的字段"),
    },
    async (args: {
      rows: DataRow[];
      keyFields?: string[];
      requiredFields?: string[];
      numericFields?: string[];
      nonNegativeFields?: string[];
    }) => {
      const issues = detectDataIssues(args.rows, args);
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: `检测 ${args.rows.length} 行，未发现声明范围内的问题。` }] };
      }
      const lines = [
        `检测 ${args.rows.length} 行，发现 ${issues.length} 类问题：`,
        ...issues.map((issue) =>
          `- [${issue.kind}] ${issue.detail}；行号（0 起）：${issue.rows.slice(0, 30).join(", ")}` +
          (issue.rows.length > 30 ? ` …另 ${issue.rows.length - 30} 行` : ""),
        ),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

/** 多来源按行标签合并汇总。不含抵消。 */
export function createMergeTablesTool(sdk: SdkLike) {
  return sdk.tool(
    "merge_labeled_tables",
    [
      "把多个来源（多公司/多期间）的「科目-金额」表按标签对齐，产出一行一科目、一列一来源、末列合计的矩阵。",
      "**不做任何抵消**：结果是简单相加，不能直接当合并报表对外使用。",
      "只在部分来源出现的科目会单独列出（口径不一致信号）；某来源缺该科目时记 null 而非 0。",
      "用于「把各公司利润表汇总成一个 sheet」这类需求；随后可用 patch_workbook 写入新建的 sheet。",
    ].join("\n"),
    {
      sources: z.array(z.object({
        name: z.string().describe("来源名称，会成为列名"),
        rows: z.array(z.object({
          label: z.string().describe("科目名"),
          value: z.number().nullable().describe("金额；缺失传 null"),
        })).min(1),
      })).min(1).max(50),
    },
    async (args: { sources: MergeSource[] }) => {
      const merged = mergeLabeledTables(args.sources);
      const header = merged.columns.join(" | ");
      const body = merged.rows
        .slice(0, 300)
        .map((row) => [row.label, ...row.values.map((v) => (v == null ? "—" : v)), row.total ?? "—"].join(" | "));
      const lines = [
        header,
        ...body,
        merged.rows.length > 300 ? `…共 ${merged.rows.length} 行` : "",
        `各来源列合计：${merged.totalsRow.map((v) => (v == null ? "—" : v)).join(" | ")}`,
        merged.partialLabels.length
          ? `⚠️ 仅部分来源出现的科目（口径可能不一致，需确认）：${merged.partialLabels.slice(0, 30).join("、")}`
          : "",
      ].filter(Boolean);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
