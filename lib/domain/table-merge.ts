/**
 * 多表合并汇总:按行标签对齐多个来源，产出「一行一科目、一列一来源 + 合计」。
 *
 * **不含抵消。** 内部往来抵消是合并报表的业务规则，属独立任务类型；
 * 混进通用汇总会让「汇总」这个动作的语义变得不可信——用户看到"合计"
 * 会以为是可直接对外的合并数，实际只是简单相加。
 */

export type LabeledRow = { label: string; value: number | null };
export type MergeSource = { name: string; rows: LabeledRow[] };

export type MergedTable = {
  /** 列顺序：标签列 + 各来源 + 合计 */
  columns: string[];
  /** 行顺序按首次出现，保留原表的科目排列 */
  rows: Array<{ label: string; values: Array<number | null>; total: number | null }>;
  /** 只在部分来源出现的标签——多为科目口径不一致，需人工确认 */
  partialLabels: string[];
  /** 各来源缺该标签时按 null 处理，不当 0 参与合计 */
  totalsRow: Array<number | null>;
};

export function mergeLabeledTables(sources: MergeSource[]): MergedTable {
  const order: string[] = [];
  const bySource = new Map<string, Map<string, number | null>>();
  for (const source of sources) {
    const map = new Map<string, number | null>();
    for (const row of source.rows) {
      const label = row.label.trim();
      if (!label) continue;
      if (!order.includes(label)) order.push(label);
      // 同名标签在同一来源内出现多次时相加(明细账常见)。
      const previous = map.get(label);
      map.set(
        label,
        previous == null || row.value == null ? (previous ?? row.value) : previous + row.value,
      );
    }
    bySource.set(source.name, map);
  }

  const names = sources.map((source) => source.name);
  const rows = order.map((label) => {
    const values = names.map((name) => bySource.get(name)!.get(label) ?? null);
    const present = values.filter((value): value is number => value != null);
    return {
      label,
      values,
      // 全部来源都缺该标签时合计为 null,而不是 0 —— 0 会被读成「金额为零」。
      total: present.length ? present.reduce((sum, value) => sum + value, 0) : null,
    };
  });

  const partialLabels = rows
    .filter((row) => row.values.some((value) => value == null) && row.values.some((value) => value != null))
    .map((row) => row.label);

  const totalsRow = names.map((_, index) => {
    const column = rows.map((row) => row.values[index]).filter((v): v is number => v != null);
    return column.length ? column.reduce((sum, value) => sum + value, 0) : null;
  });

  return { columns: ["科目", ...names, "合计"], rows, partialLabels, totalsRow };
}
