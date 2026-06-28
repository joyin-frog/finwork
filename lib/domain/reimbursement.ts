// 报销校验:逻辑已迁到 reimbursement-check skill 的固定脚本
// agent-skills/skills/reimbursement-check/scripts/reimbursement.py(可直接调;parity 见 selftest_reimbursement.py)。
// 本文件只留类型 + 同步 shell 包装,签名不变,消费方(工具/demo)零改动。
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ReimbursementItem } from "@/lib/types";
import { getPythonPath, getBundledPluginRoot } from "@/lib/runtime/paths";

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

export function validateReimbursements(
  items: Omit<ReimbursementItem, "warnings">[],
  policy: ReimbursementPolicy,
  history?: InvoiceHistory
): ReimbursementItem[] {
  return runScript({ op: "validate", items, policy, history: history ? Object.fromEntries(history) : {} });
}

/** 异常按风险排序:历史重复 > 批内重复 > 超标 > 金额/缺字段;无异常的排最后 */
export function sortReimbursementsByRisk(items: ReimbursementItem[]): ReimbursementItem[] {
  return runScript({ op: "sort", items });
}
