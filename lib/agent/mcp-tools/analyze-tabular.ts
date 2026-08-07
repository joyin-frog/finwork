import { z } from "zod/v4";
import type { SdkLike } from "./sdk-types";

const MAX_ROWS = 500;
const MAX_COLUMNS = 40;
const MAX_GROUPS = 200;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const operation = z.object({
  field: z.string().min(1).describe("参与聚合的数值列；count 可省略含义由实现固定为行数"),
  op: z.enum(["count", "sum", "avg", "min", "max"]),
});

/**
 * Declarative tabular analysis. This deliberately accepts data, not code or
 * file paths: parsing stays in read_document and business decisions stay in
 * domain tools.
 */
export function createAnalyzeTabularTool(sdk: SdkLike) {
  return sdk.tool(
    "analyze_tabular",
    [
      "对已经提取成结构化行的数据做确定性统计，不执行代码、不读取任意路径、不生成文件。",
      "用户已给出数字行并要求合计、平均、最大最小、分组或预算差异时必须调用本工具；不要心算，也不要调用 Bash/Read 代替。",
      "调用时必须提供 operations，例如 [{field:\"amount\",op:\"sum\"}]；不要传 code、脚本或文件路径。",
      "支持 count/sum/avg/min/max，可选 groupBy；Excel/PDF/CSV 先用 read_document 或对应领域工具取数。",
      `最多 ${MAX_ROWS} 行、${MAX_COLUMNS} 列、${MAX_GROUPS} 个分组；金额请传数字，无法解析的值会明确报错。`,
    ].join("\n"),
    {
      rows: z.array(z.record(z.string(), scalar)).min(1).max(MAX_ROWS).describe("结构化数据行"),
      groupBy: z.array(z.string()).max(5).optional().describe("分组列，可不传"),
      operations: z.array(operation).min(1).max(20).describe("声明式聚合操作"),
    },
    async (args: {
      rows: Array<Record<string, string | number | boolean | null>>;
      groupBy?: string[];
      operations: Array<{ field: string; op: "count" | "sum" | "avg" | "min" | "max" }>;
    }) => {
      try {
        const columns = new Set(args.rows.flatMap((row) => Object.keys(row)));
        if (columns.size > MAX_COLUMNS) throw new Error(`列数超过上限 ${MAX_COLUMNS}`);
        for (const field of args.groupBy ?? []) {
          if (!columns.has(field)) throw new Error(`分组列不存在：${field}`);
        }
        for (const item of args.operations) {
          if (item.op !== "count" && !columns.has(item.field)) throw new Error(`统计列不存在：${item.field}`);
        }

        const groups = new Map<string, Array<Record<string, string | number | boolean | null>>>();
        for (const row of args.rows) {
          const keyValues = (args.groupBy ?? []).map((field) => row[field] ?? null);
          const key = JSON.stringify(keyValues);
          const group = groups.get(key) ?? [];
          group.push(row);
          groups.set(key, group);
          if (groups.size > MAX_GROUPS) throw new Error(`分组数超过上限 ${MAX_GROUPS}`);
        }

        const results = [...groups.entries()].map(([key, rows]) => {
          const output: Record<string, unknown> = {};
          const keyValues = JSON.parse(key) as unknown[];
          (args.groupBy ?? []).forEach((field, index) => { output[field] = keyValues[index]; });
          for (const item of args.operations) {
            const name = `${item.op}_${item.field}`;
            if (item.op === "count") { output[name] = rows.length; continue; }
            const values = rows.map((row) => toNumber(row[item.field], item.field)).filter((v): v is number => v != null);
            if (values.length === 0) throw new Error(`统计列 ${item.field} 没有可用数字`);
            const total = values.reduce((sum, value) => sum + value, 0);
            output[name] = round(item.op === "sum" ? total : item.op === "avg" ? total / values.length : item.op === "min" ? Math.min(...values) : Math.max(...values));
          }
          return output;
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ rowCount: args.rows.length, groups: results }, null, 2) }],
          structuredContent: { rowCount: args.rows.length, groups: results },
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `结构化统计失败：${error instanceof Error ? error.message : String(error)}` }], isError: true as const };
      }
    },
  );
}

function toNumber(value: string | number | boolean | null, field: string): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") throw new Error(`统计列 ${field} 包含布尔值`);
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[,，￥¥\s]/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`统计列 ${field} 包含非数字值：${String(value).slice(0, 80)}`);
  return parsed;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
