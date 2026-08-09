import type { Message } from "@/app/chat/chat-types";
import type { AgentEvent } from "@/app/chat/chat-types";
import type { StoredAgentEvent } from "@/lib/db/sqlite";

const now = Date.now();

function event(id: number, payload: AgentEvent): StoredAgentEvent {
  return {
    id,
    messageId: 0,
    eventType: payload.type,
    payload,
    createdAt: new Date(now + id * 1000).toISOString(),
    traceId: "mock-chat-demo",
  };
}

const demoFiles = [
  { id: "demo-xlsx", name: "合并报表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 248_320, storagePath: "generate/合并报表.xlsx" },
  { id: "demo-md", name: "处理说明.md", mimeType: "text/markdown", sizeBytes: 4_096, storagePath: "generate/处理说明.md", text: "# 处理说明\n\n这是一份用于预览样式的演示文档。" },
];

// 一个回答内覆盖工具注册表，专门用于视觉调试：连续调用、重复调用、失败重试和结构化结果都放在同一条时间线上。
const MOCK_ALL_TOOL_NAMES = [
  "Read", "Glob", "Grep", "AskUserQuestion", "WebSearch", "WebFetch", "Monitor", "Write", "Edit", "MultiEdit", "Bash",
  "mcp__finance_worker__run_python", "mcp__finance_worker__spawn_subagent", "mcp__finance_worker__search_knowledge", "mcp__finance_worker__query_knowledge",
  "mcp__finance_worker__read_file", "mcp__finance_worker__read_document", "mcp__finance_worker__scan_slip_folder", "mcp__finance_worker__remember_convention",
  "mcp__finance_worker__remember_role_convention", "mcp__finance_worker__record_business_metrics", "mcp__finance_worker__generate_business_analysis",
  "mcp__finance_worker__calculate_payroll_batch", "mcp__finance_worker__confirm_payroll_period", "mcp__finance_worker__query_payroll_status",
  "mcp__finance_worker__diff_payroll_period", "mcp__finance_worker__export_payslips", "mcp__finance_worker__check_reimbursement_batch",
  "mcp__finance_worker__record_reimbursement_invoices", "mcp__finance_worker__reconcile_bank_statement", "mcp__finance_worker__read_expense_policy",
  "mcp__finance_worker__tax_calculator", "mcp__finance_worker__query_invoice_ledger", "mcp__finance_worker__query_receivables",
  "mcp__finance_worker__record_sales_invoices", "mcp__finance_worker__record_invoice_settlement", "mcp__finance_worker__query_sales_invoices",
  "mcp__kingdee_worker__query_kingdee_accounts", "mcp__kingdee_worker__export_kingdee_draft", "mcp__kingdee_worker__validate_kingdee_voucher",
  "mcp__kingdee_worker__import_kingdee_accounts", "mcp__kingdee_worker__check_voucher_amount", "mcp__kingdee_worker__map_voucher_account",
  "mcp__kingdee_worker__summarize_vouchers", "mcp__kingdee_worker__build_voucher_lines", "mcp__kingdee_worker__build_voucher_sheet",
  "mcp__kingdee_worker__process_voucher_batch", "mcp__finance_worker__record_document_metadata", "mcp__finance_worker__update_company_profile",
  "mcp__finance_worker__finalize_deliverable", "mcp__finance_worker__emit_checklist", "mcp__finance_worker__run_filing_precheck_batch",
  "mcp__finance_worker__run_bank_recon_batch", "mcp__finance_worker__undo_last_write", "mcp__finance_worker__propose_transfer",
  // 重复调用用于观察聚合、重试和同类步骤的视觉表现。
  "mcp__finance_worker__search_knowledge", "mcp__finance_worker__search_knowledge", "mcp__finance_worker__run_python",
];

function buildAllToolTimeline(): StoredAgentEvent[] {
  let id = 100;
  const events: StoredAgentEvent[] = [event(id++, { type: "thinking", content: "先读取文件和制度，再核对财务数据，最后生成并校验交付物。" })];
  for (const [index, name] of MOCK_ALL_TOOL_NAMES.entries()) {
    const toolId = `all-tools-${index + 1}`;
    const isRetry = index === MOCK_ALL_TOOL_NAMES.length - 3;
    const isError = index === 10 || index === 40;
    events.push(event(id++, { type: "tool_use", id: toolId, name, input: { demo: true, step: index + 1, retry: isRetry } }));
    events.push(event(id++, {
      type: "tool_result",
      toolUseId: toolId,
      name,
      content: isError ? "服务暂时不可用，已保留上下文并准备重试。" : `${name} 返回演示结果。`,
      isError,
      durationMs: 900 + (index % 7) * 700,
      structured: index === 31 ? { value: 13000, unit: "CNY", basis: { caliberVersion: "mock@2025.1" }, steps: [{ label: "税额", expr: "100000 × 13%", subtotal: 13000 }] } : undefined,
    }));
    if (index === 20 || index === 37) events.push(event(id++, { type: "text", content: index === 20 ? "工资和报销数据已汇总，继续核对金蝶凭证。" : "金蝶凭证校验完成，开始整理交付物。" }));
  }
  events.push(event(id++, { type: "system", subtype: "compact_boundary", message: "上下文已压缩：64000 → 16000 tokens" }));
  events.push(event(id++, { type: "system", subtype: "turn_duration", message: "48600" }));
  events.push(event(id++, { type: "text", content: "全部工具调用演示完成：包含重复检索、失败重试、结构化结果和最终交付。" }));
  return events;
}

/** 仅用于 /chat/*?mock=all 的视觉演示，不写入数据库，也不参与真实会话。 */
export const MOCK_CHAT_MESSAGES: Message[] = [
  {
    id: 9001,
    role: "user",
    content: "请帮我检查这份合并报表，顺便看看附件。",
    createdAt: new Date(now - 12 * 60_000).toISOString(),
    displayFiles: [
      { id: "source-xlsx", name: "2025年度合并报表.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 1_572_864, storagePath: "input/2025年度合并报表.xlsx" },
      { id: "source-png", name: "报表截图.png", mimeType: "image/png", sizeBytes: 82_944, dataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='64'%3E%3Crect width='96' height='64' fill='%23e8eefc'/%3E%3Cpath d='M12 48 35 25l12 12 10-9 27 20' fill='none' stroke='%234b6bdb' stroke-width='4'/%3E%3C/svg%3E" },
    ],
  },
  {
    id: 9002,
    role: "assistant",
    content: "我先快速看了一遍。整体结构正常，但有 **3 个地方** 值得复核：\n\n1. 子公司内部往来抵消金额与明细不一致；\n2. 少数股东权益的期末余额需要重新确认；\n3. 附件中的税率口径来自上一期模板。\n\n下面保留了处理过程，方便查看不同状态的视觉层级。",
    createdAt: new Date(now - 11 * 60_000).toISOString(),
    agentEvents: [
      event(1, { type: "thinking", content: "先读取报表，再核对抵消分录和税率口径。" }),
      event(2, { type: "text", content: "正在读取附件并建立检查清单。" }),
      event(3, { type: "tool_use", id: "read-1", name: "read_document", input: { filePath: "input/2025年度合并报表.xlsx" } }),
      event(4, { type: "tool_result", toolUseId: "read-1", name: "read_document", content: "已读取 6 个工作表，发现 2 个待核对区域。", durationMs: 4200 }),
      event(5, { type: "tool_use", id: "search-1", name: "search_knowledge", input: { query: "少数股东权益 合并报表" } }),
      event(6, { type: "tool_result", toolUseId: "search-1", name: "search_knowledge", content: "命中 3 篇制度文档。", durationMs: 1800 }),
      event(7, { type: "ask_user", questionId: "demo-ask-answered", question: { header: "处理口径", question: "少数股东权益按哪种口径处理？", options: [{ label: "按期末余额", description: "以本期审定余额为准" }, { label: "按模板口径", description: "沿用上一期模板" }] } }),
      event(8, { type: "ask_user_answered", questionId: "demo-ask-answered", answer: "按期末余额" }),
      event(9, { type: "subagent", label: "税务专员", roleId: "tax", phase: "start", summary: "开始检查税率" }),
      event(10, { type: "subagent", label: "税务专员", roleId: "tax", phase: "tool", toolName: "search_knowledge", summary: "命中当期税率" }),
      event(11, { type: "subagent", label: "税务专员", roleId: "tax", phase: "done", summary: "检查完成", success: true, durationMs: 5600 }),
      event(12, { type: "system", subtype: "compact_boundary", message: "上下文已压缩：48000 → 12000 tokens" }),
      event(13, { type: "text", content: "检查完成，建议先修正内部往来抵消，再重新生成汇总表。" }),
    ],
  },
  {
    id: 9003,
    role: "user",
    content: "请生成一份修正后的汇总表。",
    createdAt: new Date(now - 8 * 60_000).toISOString(),
  },
  {
    id: 9004,
    role: "assistant",
    content: "修正后的文件已经准备好了，下面可以直接打开预览。",
    createdAt: new Date(now - 7 * 60_000).toISOString(),
    displayFiles: demoFiles,
    agentEvents: [
      event(20, { type: "text", content: "我正在生成修正后的文件。" }),
      event(21, { type: "tool_use", id: "python-1", name: "run_python", input: { code: "build_consolidated_report()" } }),
      event(22, { type: "tool_result", toolUseId: "python-1", name: "run_python", content: "已生成 2 个文件。", durationMs: 7_800, structured: { value: 2, unit: "files", basis: { settlementStatus: "draft" } } }),
      event(23, { type: "text", content: "修正后的文件已经准备好了。" }),
    ],
  },
  {
    id: 9005,
    role: "user",
    content: "再帮我导出一份凭证清单。",
    createdAt: new Date(now - 5 * 60_000).toISOString(),
  },
  {
    id: 9006,
    role: "assistant",
    content: "导出过程中遇到一个暂时性问题，前面的检查结果已经保留。你可以点击“继续”重试。",
    createdAt: new Date(now - 4 * 60_000).toISOString(),
    agentEvents: [
      event(30, { type: "tool_use", id: "export-1", name: "export_voucher_list", input: { fileName: "凭证清单.xlsx" } }),
      event(31, { type: "tool_result", toolUseId: "export-1", name: "export_voucher_list", content: "服务暂时不可用：导出任务超时。", isError: true, durationMs: 12_400 }),
      event(32, { type: "system", subtype: "turn_incomplete", message: "导出任务超时" }),
    ],
  },
  {
    id: 9007,
    role: "assistant",
    content: "本次用量已达到演示上限，请稍后再试。",
    createdAt: new Date(now - 2 * 60_000).toISOString(),
    agentEvents: [
      event(40, { type: "system", subtype: "usage_blocked", message: "本次用量已达到演示上限，请稍后再试。" }),
    ],
  },
  {
    id: 9008,
    role: "user",
    content: "帮我总结本季度的经营情况。",
    createdAt: new Date(now - 90 * 60_000).toISOString(),
  },
  {
    id: 9009,
    role: "assistant",
    content: "本季度经营整体稳中有升，收入增长主要来自重点客户续约和新业务转化。建议继续关注回款周期与毛利率变化。",
    createdAt: new Date(now - 89 * 60_000).toISOString(),
    agentEvents: [
      event(50, { type: "thinking", content: "先梳理收入、成本、回款三组指标，再给出结论。" }),
      event(51, { type: "system", subtype: "thinking_duration", message: "3400" }),
      event(52, { type: "text", content: "正在整理本季度经营指标。" }),
      event(53, { type: "system", subtype: "turn_duration", message: "7600" }),
      event(54, { type: "text", content: "本季度经营整体稳中有升，收入增长主要来自重点客户续约和新业务转化。建议继续关注回款周期与毛利率变化。" }),
    ],
  },
  {
    id: 9010,
    role: "user",
    content: "把收入和成本按月份列出来。",
    createdAt: new Date(now - 82 * 60_000).toISOString(),
  },
  {
    id: 9011,
    role: "assistant",
    content: [
      "## 月度经营概览",
      "",
      "| 月份 | 收入 | 成本 | 毛利率 |",
      "| --- | ---: | ---: | ---: |",
      "| 1 月 | ¥1,280,000 | ¥760,000 | 40.6% |",
      "| 2 月 | ¥1,460,000 | ¥812,000 | 44.4% |",
      "| 3 月 | ¥1,610,000 | ¥870,000 | 45.9% |",
      "| 合计 | ¥4,350,000 | ¥2,442,000 | 43.9% |",
      "",
      "> 结论：3 月收入和毛利率均为本季度最高，建议拆分查看新客户与续约客户贡献。",
      "",
      "```text",
      "收入增长率 = (本月收入 - 上月收入) / 上月收入",
      "```",
    ].join("\n"),
    createdAt: new Date(now - 81 * 60_000).toISOString(),
    agentEvents: [
      event(55, { type: "tool_use", id: "table-1", name: "query_finance_data", input: { period: "2025-Q1", dimensions: ["month"] } }),
      event(56, { type: "tool_result", toolUseId: "table-1", name: "query_finance_data", content: "返回 3 个月、4 个指标。", durationMs: 2100 }),
    ],
  },
  {
    id: 9012,
    role: "assistant",
    content: "已按你的选择继续处理。这里保留一条已完成的多选问答，便于检查答案摘要和多选态。",
    createdAt: new Date(now - 70 * 60_000).toISOString(),
    agentEvents: [
      event(57, { type: "text", content: "需要确认报表输出范围。" }),
      event(58, {
        type: "ask_user",
        questionId: "demo-multi-answered",
        question: {
          header: "输出范围",
          question: "需要包含哪些附表？",
          multiSelect: true,
          options: [
            { label: "资产负债表", description: "输出期末余额和同比变化" },
            { label: "利润表", description: "输出本期和累计数据" },
            { label: "现金流量表", description: "输出经营、投资、筹资现金流" },
          ],
        },
      }),
      event(59, { type: "ask_user_answered", questionId: "demo-multi-answered", answer: "[\"资产负债表\",\"利润表\"]" }),
      event(60, { type: "text", content: "已按你的选择继续处理。这里保留一条已完成的多选问答，便于检查答案摘要和多选态。" }),
    ],
  },
  {
    id: 9013,
    role: "user",
    content: "请生成一份带校验结果的交付包。",
    createdAt: new Date(now - 60 * 60_000).toISOString(),
  },
  {
    id: 9014,
    role: "assistant",
    content: "交付包已生成，但有一项校验需要人工确认。",
    createdAt: new Date(now - 59 * 60_000).toISOString(),
    displayFiles: [
      { id: "demo-csv", name: "校验明细.csv", mimeType: "text/csv", sizeBytes: 18_432, storagePath: "generate/校验明细.csv", text: "项目,状态\n收入,通过\n成本,需复核" },
      { id: "demo-pdf", name: "交付说明.pdf", mimeType: "application/pdf", sizeBytes: 96_256, storagePath: "generate/交付说明.pdf" },
      { id: "demo-json", name: "校验结果.json", mimeType: "application/json", sizeBytes: 2_048, storagePath: "generate/校验结果.json", text: "{\"status\":\"review\"}" },
    ],
    agentEvents: [
      event(61, { type: "tool_use", id: "package-1", name: "run_python", input: { code: "build_delivery_package()" } }),
      event(62, { type: "tool_result", toolUseId: "package-1", name: "run_python", content: "已生成交付包。", durationMs: 3400, structured: { value: 3, unit: "files", basis: { settlementStatus: "draft" }, caveats: ["成本明细存在 1 项待复核。"] } }),
      event(63, { type: "text", content: "交付包已生成，但有一项校验需要人工确认。" }),
    ],
  },
  {
    id: 9015,
    role: "assistant",
    content: "这条用于展示没有正文、只有工具失败信息的情况。",
    createdAt: new Date(now - 52 * 60_000).toISOString(),
    agentEvents: [
      event(64, { type: "tool_use", id: "retry-1", name: "search_knowledge", input: { query: "最新会计准则" } }),
      event(65, { type: "tool_result", toolUseId: "retry-1", name: "search_knowledge", content: "知识库暂时不可用，请稍后重试。", isError: true, durationMs: 980 }),
      event(66, { type: "system", subtype: "turn_incomplete", message: "知识库暂时不可用" }),
    ],
  },
  {
    id: 9016,
    role: "assistant",
    content: "### 纯文本问答\n\n不经过工具调用时，回答会直接以正文呈现。\n\n- 支持多段落\n- 支持链接：https://example.com\n- 支持行内代码：`SUM(A1:A3)`",
    createdAt: new Date(now - 45 * 60_000).toISOString(),
  },
  {
    id: 9017,
    role: "user",
    content: "请把这次任务涉及的所有工具调用完整展开给我看。",
    createdAt: new Date(now - 38 * 60_000).toISOString(),
  },
  {
    id: 9018,
    role: "assistant",
    content: "全部工具调用演示完成：包含重复检索、失败重试、结构化结果和最终交付。",
    createdAt: new Date(now - 37 * 60_000).toISOString(),
    agentEvents: buildAllToolTimeline(),
  },
];

export const MOCK_PENDING_QUESTION = {
  questionId: "mock-pending-question",
  question: {
    header: "需要确认",
    question: "发现 2 个金额口径不一致，是否按本期审定数据继续生成？",
    kind: "question" as const,
    multiSelect: false,
    options: [
      { label: "按本期审定数据", description: "使用最新核对结果" },
      { label: "先保留原口径", description: "只生成检查报告，不改动数据" },
    ],
  },
};
