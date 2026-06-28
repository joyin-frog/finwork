// 报销溯源(C3 机械层):只从工具调用时间线里能"机械证实"的事实构造,
// 不依赖模型自述——这些事实带"系统核验"语义,不可能被模型编造。
// 口径/假设叙述仍由模型写在答案正文里(AI 说明层),与本块视觉分开。
//
// 仅当出现报销相关工具(读报销制度 / 核对报销 / 登记发票)时返回非空,
// 借此把这套 C3 样板限定在"报销"这条流程上。

import type { AgentEvent } from "@/app/chat/chat-types";

type TimelineLike = { event: AgentEvent };

export type ReimbursementProvenance = {
  /** 数据来源:读取的文件 / 检索的知识库等(机械记录)。 */
  sources: string[];
  /** 报销制度口径:用的是示例制度(isExample)还是贵司真制度。null = 本回合未读制度。 */
  policyBasis: { text: string; isExample: boolean } | null;
  /** 核对 / 登记笔数等可计数事实。 */
  counts: string[];
};

function bareName(name: string | undefined): string {
  return (name ?? "").replace(/^mcp__\w+__/, "");
}

function str(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

function arrayLen(input: unknown, key: string): number {
  if (!input || typeof input !== "object") return 0;
  const v = (input as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.length : 0;
}

/** 从一轮助手回合的时间线里,机械提取报销相关的数据来源/口径/笔数。无报销动作时返回 null。 */
export function buildReimbursementProvenance(timeline: TimelineLike[]): ReimbursementProvenance | null {
  const sources: string[] = [];
  const counts: string[] = [];
  let policyBasis: ReimbursementProvenance["policyBasis"] = null;
  let touchedReimbursement = false;

  // tool_result 按 name 归集,便于 read_expense_policy 判断示例/真制度。
  const resultsByName = new Map<string, string>();
  for (const item of timeline) {
    if (item.event.type === "tool_result" && !item.event.isError) {
      const name = bareName(item.event.name);
      if (name && !resultsByName.has(name)) resultsByName.set(name, item.event.content ?? "");
    }
  }

  for (const item of timeline) {
    if (item.event.type !== "tool_use") continue;
    const name = bareName(item.event.name);
    const input = item.event.input;

    switch (name) {
      case "read_expense_policy": {
        touchedReimbursement = true;
        const result = resultsByName.get("read_expense_policy") ?? "";
        const isExample = result.includes("示例报销制度");
        policyBasis = {
          text: isExample
            ? "报销制度:示例制度(尚未导入贵司制度,结论可能与实际标准不符)"
            : "报销制度:贵司已导入的制度文件",
          isExample,
        };
        break;
      }
      case "check_reimbursement_batch": {
        touchedReimbursement = true;
        const n = arrayLen(input, "items");
        if (n) counts.push(`核对报销单 ${n} 条`);
        break;
      }
      case "record_reimbursement_invoices": {
        touchedReimbursement = true;
        const n = arrayLen(input, "items");
        if (n) counts.push(`登记发票 ${n} 张进台账`);
        break;
      }
      case "read_file": {
        const f = str(input, "fileName");
        if (f) sources.push(`知识库文件《${f}》`);
        break;
      }
      case "search_knowledge":
      case "query_knowledge": {
        const q = str(input, "query") || str(input, "command");
        if (q) sources.push(`知识库检索「${q.slice(0, 30)}」`);
        break;
      }
      default:
        break;
    }
  }

  if (!touchedReimbursement) return null;

  // 去重(同一文件/检索可能被多次调用)
  return {
    sources: [...new Set(sources)],
    policyBasis,
    counts: [...new Set(counts)],
  };
}
