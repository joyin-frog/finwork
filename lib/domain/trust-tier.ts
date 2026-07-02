export type TrustTier = "verified" | "pending" | "inferred" | "unverified";
export type TrustSource = "engine_calc" | "file_parse" | "user_dictated" | "llm_inferred";
export type TrustStatus = "confirmed" | "draft" | "none";

/**
 * 推导信任级别（spec §2.1 矩阵）
 *
 * 特殊规则：
 *  ★  user_dictated + confirmed → verified（口述经确认升已核实）
 *  ★★ llm_inferred 永远封顶 inferred（确认动作只是"已阅"，不等于"为真"）
 */
export function deriveTrustTier(source: TrustSource, status: TrustStatus): TrustTier {
  // ★★ LLM 结论永远封顶「推测」
  if (source === "llm_inferred") return "inferred";

  // 已确认 → 已核实（engine_calc / file_parse / user_dictated 均适用）
  if (status === "confirmed") return "verified";

  // user_dictated 未确认 → 未核实
  if (source === "user_dictated") return "unverified";

  // engine_calc / file_parse，draft 或 none → 待确认
  return "pending";
}
