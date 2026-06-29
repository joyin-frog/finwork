// 报销校验:逻辑已迁到 reimbursement-check skill 的固定脚本
// agent-skills/skills/reimbursement-check/scripts/reimbursement.py(可直接调;parity 见 selftest_reimbursement.py)。
// 本文件只留类型 + 同步 shell 包装,签名不变,消费方(工具/demo)零改动。
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ReimbursementItem, RuleHit } from "@/lib/types";
import { getPythonPath, getBundledPluginRoot } from "@/lib/runtime/paths";
import { makeCalcReceipt, type CalcStep } from "./receipt";

export type ReimbursementPolicy = {
  singleLimit: number;
};

/** 台账历史:发票号 → 首次登记时间(跨月重复报销查重依据) */
export type InvoiceHistory = Map<string, { recordedAt: string }>;

const SCRIPT = path.join(getBundledPluginRoot(), "skills", "reimbursement-check", "scripts", "reimbursement.py");

function runScript(payload: unknown): ReimbursementItem[] {
  let out: string;
  try {
    out = execFileSync(getPythonPath(), [SCRIPT], { input: JSON.stringify(payload), encoding: "utf-8" });
  } catch (e) {
    throw new Error(`报销脚本执行失败:${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = JSON.parse(out) as { results?: ReimbursementItem[]; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed.results ?? [];
}

/**
 * 功能2: 把 Python 脚本返回的 warnings 字符串映射为结构化 RuleHit。
 * 纯函数，可单独测试；policy 可选——有时（如 sort 场景）调用方无口径上下文。
 */
export function mapWarningsToRuleHits(
  warnings: string[],
  item: { amount: number },
  policy?: { singleLimit: number }
): RuleHit[] {
  return warnings.map((w) => {
    if (w === "超过单笔标准") {
      return {
        rule: "single_limit_exceeded",
        message: w,
        ...(policy !== undefined ? { threshold: policy.singleLimit } : {}),
        actual: item.amount,
      };
    }
    if (w === "发票号重复") return { rule: "duplicate_invoice", message: w };
    if (w.startsWith("历史重复")) return { rule: "history_duplicate", message: w };
    if (w === "缺少类目") return { rule: "missing_category", message: w };
    if (w === "缺少日期") return { rule: "missing_date", message: w };
    if (w === "金额异常") return { rule: "invalid_amount", message: w };
    return { rule: "unknown", message: w };
  });
}

/**
 * 功能2: 从单条报销明细 + ruleHits 构造 CalcReceipt。
 * - steps: 每条规则命中对应一步（命中哪条标准 + 阈值 + 实际值）。
 * - source: 发票号（ref）+ 记录数 1。
 * - caliberVersion: 含 singleLimit，口径变更可追溯。
 * - settlementStatus 固定 "draft"（报销单提交阶段，未审批不是终值）。
 */
function buildReimbursementReceipt(
  item: Pick<ReimbursementItem, "amount" | "invoiceNo" | "expenseDate">,
  ruleHits: RuleHit[],
  policy?: { singleLimit: number }
): import("./receipt").CalcReceipt {
  const steps: CalcStep[] = ruleHits.map((hit) => ({
    label: hit.message,
    expr:
      hit.rule === "single_limit_exceeded"
        ? `${hit.actual ?? item.amount} > ${hit.threshold ?? policy?.singleLimit ?? "?"}`
        : hit.rule,
    inputs: {
      ...(hit.threshold !== undefined ? { threshold: hit.threshold } : {}),
      ...(hit.actual !== undefined ? { actual: hit.actual } : {}),
    },
    subtotal: item.amount,
  }));

  const caliberVersion = policy
    ? `reimbursement-limit-${policy.singleLimit}`
    : "reimbursement-v1";

  const asOf =
    item.expenseDate && /^\d{4}-\d{2}/.test(item.expenseDate)
      ? item.expenseDate.slice(0, 7)
      : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  return makeCalcReceipt({
    value: item.amount,
    steps,
    source: [{ ref: item.invoiceNo, recordCount: 1 }],
    basis: {
      caliberVersion,
      settlementStatus: "draft",
      asOf,
    },
    rounding: "half_up",
    ...(ruleHits.length > 0 ? { caveats: [`${ruleHits.length} 条规则命中，需人工审核`] } : {}),
  });
}

export function validateReimbursements(
  items: Omit<ReimbursementItem, "warnings">[],
  policy: ReimbursementPolicy,
  history?: InvoiceHistory
): ReimbursementItem[] {
  const raw = runScript({ op: "validate", items, policy, history: history ? Object.fromEntries(history) : {} });
  // 功能2: Python 脚本只产出 warnings；TS 层补充结构化 ruleHits + CalcReceipt
  return raw.map((item) => {
    const ruleHits = mapWarningsToRuleHits(item.warnings, item, policy);
    const receipt = buildReimbursementReceipt(item, ruleHits, policy);
    return { ...item, ruleHits, receipt };
  });
}

/** 异常按风险排序:历史重复 > 批内重复 > 超标 > 金额/缺字段;无异常的排最后 */
export function sortReimbursementsByRisk(items: ReimbursementItem[]): ReimbursementItem[] {
  const raw = runScript({ op: "sort", items });
  // 功能2: Python 排序后通过 JSON 回传，ruleHits/receipt 若已存在则保留；
  // 否则（调用方直接传入无 ruleHits 的原始 item）从 warnings 重新派生（无 policy 上下文）。
  return raw.map((item) => {
    if (item.ruleHits !== undefined && item.receipt !== undefined) {
      return item;
    }
    const ruleHits = mapWarningsToRuleHits(item.warnings, item);
    const receipt = buildReimbursementReceipt(item, ruleHits);
    return { ...item, ruleHits, receipt };
  });
}
