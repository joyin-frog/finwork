/**
 * 科目映射:关键词 → 科目编码 → 维度类型带出。
 *
 * 对照表(知识库,用户维护,从零沉淀)命中即取编码,但编码必须在科目表存在才输出;
 * 不存在→清除+⚠️+最近匹配建议。不由 LLM 硬猜三级明细(费用科目极细,靠对照表)。
 */

import type { KingdeeAccount } from "@/lib/db/finance-store";

/** 对照表条目:关键词 → 科目码 → 维度值(哪个部门/供应商,可空)。 */
export type MappingEntry = { keyword: string; code: string; dimensionValue?: string };

export type AccountResolution =
  | { ok: true; confidence: "high"; code: string; name: string; dimensionType?: string; dimensionValue?: string }
  | { ok: false; reason: "code_not_in_chart"; matchedKeyword: string; staleCode: string; suggestedCode?: string; suggestedName?: string }
  | { ok: false; reason: "no_match" };

/** 失效明细码 → 逐级找存在的父级科目作为建议(6602.99 不存在→建议父级 6602)。 */
function suggestParent(staleCode: string, chart: KingdeeAccount[]): { code: string; name: string } | undefined {
  let parent = staleCode;
  while (parent.includes(".")) {
    parent = parent.slice(0, parent.lastIndexOf("."));
    const found = chart.find((a) => a.code === parent);
    if (found) return { code: found.code, name: found.name };
  }
  return undefined;
}

/** 用对照表 + 科目表解析摘要文本的科目;命中且编码存在→高置信度并带出维度类型。 */
export function resolveAccount(
  text: string,
  mappings: MappingEntry[],
  chart: KingdeeAccount[]
): AccountResolution {
  const matched = mappings.find((m) => m.keyword && text.includes(m.keyword));
  if (!matched) return { ok: false, reason: "no_match" };

  const account = chart.find((a) => a.code === matched.code);
  if (!account) {
    const suggestion = suggestParent(matched.code, chart);
    return {
      ok: false,
      reason: "code_not_in_chart",
      matchedKeyword: matched.keyword,
      staleCode: matched.code,
      ...(suggestion ? { suggestedCode: suggestion.code, suggestedName: suggestion.name } : {}),
    };
  }

  return {
    ok: true,
    confidence: "high",
    code: account.code,
    name: account.name,
    ...(account.dimension ? { dimensionType: account.dimension } : {}),
    ...(matched.dimensionValue ? { dimensionValue: matched.dimensionValue } : {}),
  };
}
