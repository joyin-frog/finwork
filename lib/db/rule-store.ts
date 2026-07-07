/**
 * rule-store.ts — policy_rule_sets 应用层 CRUD（WP5a）
 *
 * 规则：
 * - 同类型区间不允许重叠（INSERT 前同事务 SELECT 校验，命中即抛）
 * - payload 必须是合法 JSON（写入时验证，而非读取时回落）
 * - 查询结果为 null 时语义"无当期规则"（调用方决定是否抛错）
 * - 唯一约束 (rule_type, version)：相同组合写入 → SQLite UNIQUE 错误透传
 */

import type { DatabaseSync } from "node:sqlite";

export type RuleType =
  | "iit_cumulative"
  | "vat_rates"
  | "cit_rates"
  | "social_base"
  | (string & {});

export type RuleSource = "builtin_seed" | "user_override" | "user_dictated" | (string & {});

export type PolicyRuleRow = {
  id: number;
  rule_type: string;
  version: string;
  effective_from: string;
  effective_to: string | null;
  payload: string;
  source: string;
  created_at: string;
};

export type InsertPolicyRuleInput = {
  rule_type: RuleType;
  version: string;
  effective_from: string;
  effective_to: string | null;
  payload: string;
  source: RuleSource;
};

/**
 * 插入一条策略规则（含区间重叠校验 + payload JSON 校验）。
 *
 * 在同一事务内执行：
 * 1. 校验 payload 合法 JSON
 * 2. SELECT 同 rule_type 的重叠区间（若命中即抛）
 * 3. INSERT
 */
export function insertPolicyRule(db: DatabaseSync, input: InsertPolicyRuleInput): void {
  // 1. payload 必须是合法 JSON
  try {
    JSON.parse(input.payload);
  } catch {
    throw new Error(
      `insertPolicyRule: payload 必须是合法 JSON，当前值无效（rule_type=${input.rule_type}, version=${input.version}）`
    );
  }

  // 2. 区间重叠检查（同一 rule_type 下，[effective_from, effective_to) 不得与已有区间相交）
  // 区间语义：effective_to IS NULL 表示开放区间（无终止）。
  // 两区间 A=[a_from, a_to) 与 B=[b_from, b_to) 重叠：a_from < b_to AND b_from < a_to
  //   特殊：某端为 NULL 时视作无穷大，即 NULL > 任意日期
  //
  // 等价 SQL：
  //   existing.effective_from < input.effective_to (or input.effective_to IS NULL)
  //   AND (existing.effective_to IS NULL OR existing.effective_to > input.effective_from)
  //   AND existing.rule_type = input.rule_type
  //   AND existing.version != input.version（防止幂等重插时自我报错，但 UNIQUE 约束已阻止）

  db.exec("BEGIN");
  try {
    let overlapRow: unknown;
    if (input.effective_to === null) {
      // 新区间终止 = NULL (开放)：只要同类型的任何现有区间在 effective_from 之后开始，都可能重叠
      overlapRow = db.prepare(`
        SELECT version FROM policy_rule_sets
        WHERE rule_type = ?
          AND version != ?
          AND (effective_to IS NULL OR effective_to > ?)
        LIMIT 1
      `).get(input.rule_type, input.version, input.effective_from);
    } else {
      // 新区间有终止 effective_to：
      overlapRow = db.prepare(`
        SELECT version FROM policy_rule_sets
        WHERE rule_type = ?
          AND version != ?
          AND effective_from < ?
          AND (effective_to IS NULL OR effective_to > ?)
        LIMIT 1
      `).get(input.rule_type, input.version, input.effective_to, input.effective_from);
    }

    if (overlapRow) {
      const conflictVersion = (overlapRow as { version: string }).version;
      throw new Error(
        `insertPolicyRule 区间重叠: rule_type=${input.rule_type} 的新规则 ` +
          `[${input.effective_from}, ${input.effective_to ?? "∞"}) ` +
          `与已有版本 "${conflictVersion}" 的区间重叠，请先关闭现有区间（设置 effective_to）`
      );
    }

    db.prepare(`
      INSERT INTO policy_rule_sets
        (rule_type, version, effective_from, effective_to, payload, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.rule_type,
      input.version,
      input.effective_from,
      input.effective_to,
      input.payload,
      input.source
    );

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * as-of 查询：给定 rule_type 和 asOf 日期字符串（YYYY-MM-DD），返回生效的规则行。
 *
 * 条件：effective_from <= asOf AND (effective_to IS NULL OR effective_to > asOf)
 * 若无命中，返回 null（不抛错——让调用方决定语义）。
 * 若有多行命中（不应发生，区间重叠校验保证），取 effective_from 最新的一条。
 */
export function queryPolicyRule(
  db: DatabaseSync,
  ruleType: RuleType,
  asOf: string
): PolicyRuleRow | null {
  const row = db.prepare(`
    SELECT * FROM policy_rule_sets
    WHERE rule_type = ?
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to > ?)
    ORDER BY effective_from DESC
    LIMIT 1
  `).get(ruleType, asOf, asOf) as PolicyRuleRow | undefined;

  return row ?? null;
}
