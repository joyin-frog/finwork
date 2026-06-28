// 银行流水对账:逻辑已迁到固定脚本 agent-skills/skills/finance-analysis/scripts/reconciliation.py
// (可直接调;parity 见 selftest_reconciliation.py)。本文件只留类型 + 同步 shell 包装,签名不变,工具零改动。
// 信任级别 = 复核者:只核对、只提示,绝不触发任何付款/转账。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { getPythonPath, getBundledPluginRoot } from "@/lib/runtime/paths";

export type ReconDirection = "in" | "out";

export type ReconInputRow = {
  date: string; // YYYY-MM-DD(或任何 Date 可解析格式)
  amount: number; // 正数金额(元),方向由 direction 决定
  direction: ReconDirection;
  description?: string | null;
  counterparty?: string | null;
};

export type ReconRow = ReconInputRow & {
  /** 在各自源数组(bank/book)中的原始下标,用于溯源 */
  index: number;
  cents: number;
  time: number; // 解析后的毫秒时间戳
};

export type ReconMatch = {
  bank: ReconRow;
  book: ReconRow;
  dateDiffDays: number;
};

export type ReconSplitMergeGroup = {
  /** "bank" = 1 条银行流水 对 多条账面;"book" = 1 条账面 对 多条银行流水 */
  side: "bank" | "book";
  one: ReconRow;
  many: ReconRow[];
  note: string;
};

export type ReconResult = {
  matched: ReconMatch[];
  /** 银行有、账上无(按金额倒序=风险排序) */
  bankOnly: ReconRow[];
  /** 账上有、银行无(按金额倒序) */
  bookOnly: ReconRow[];
  /** 疑似拆分/合并:金额能凑但笔数不一致,需人工核对(不自动匹配) */
  needsReview: ReconSplitMergeGroup[];
  summary: {
    bankCount: number;
    bookCount: number;
    matchedCount: number;
    bankOnlyTotal: number;
    bookOnlyTotal: number;
    matchedTotal: number;
    /** 三类未达项全空才算账银两平 */
    balanced: boolean;
  };
};

export type ReconOptions = {
  /** 日期容差窗口(天),默认 0=要求同一天 */
  dateWindowDays?: number;
};

const SCRIPT = path.join(getBundledPluginRoot(), "skills", "finance-analysis", "scripts", "reconciliation.py");

export function reconcileBankStatement(
  bankInput: ReconInputRow[],
  bookInput: ReconInputRow[],
  options: ReconOptions = {}
): ReconResult {
  let out: string;
  try {
    out = execFileSync(getPythonPath(), [SCRIPT], {
      input: JSON.stringify({ bank: bankInput, book: bookInput, options }),
      encoding: "utf-8"
    });
  } catch (e) {
    throw new Error(`对账脚本执行失败:${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = JSON.parse(out) as { result?: ReconResult; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.result) throw new Error("对账脚本无输出");
  return parsed.result;
}
