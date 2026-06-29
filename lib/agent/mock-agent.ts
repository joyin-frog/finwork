import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage, AgentRunEvent, ClaudeAgentRunOptions } from "./claude-adapter";

/**
 * 确定性模拟 Agent —— 给 e2e 用。
 *
 * 真 Agent 走 SDK + 真 LLM:非确定、要密钥、慢、易抖,没法当 CI 常态门。本模块在
 * `FINANCE_AGENT_MOCK_AGENT=1` 时接管 runClaudeAgent,按"用户最后一句话的关键词"
 * 挑一个脚本,沿真 Agent 同一套回调(onChunk / onAgentEvent / resolveUserQuestion)
 * 重放可预测的事件流,并把真实文件写进 outputDir —— 让"流式渲染 / 工具卡 / 生成文件
 * → 产物追踪 / 人机确认"这些 journey 能被确定性地 e2e。
 *
 * 不接触网络、不读 key。返回形状与无 key 兜底 mock 一致,下游 persist 逻辑不用改。
 */
export function isMockAgentEnabled(): boolean {
  const v = process.env.FINANCE_AGENT_MOCK_AGENT;
  return v === "1" || v === "true";
}

type MockResult = { mode: "mock"; claudeSessionId: string | null; content: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 每步小延时:让前端流式/工具卡有中间态可断言,又够快。可经 env 调(0 = 不延时)。 */
function stepDelay(): number {
  const n = Number(process.env.FINANCE_AGENT_MOCK_AGENT_DELAY);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

function lastUserText(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return (last?.content ?? "").toString();
}

export async function runMockAgent(
  messages: AgentMessage[],
  runOptions: ClaudeAgentRunOptions = {}
): Promise<MockResult> {
  const text = lastUserText(messages);
  const claudeSessionId = runOptions.claudeSessionId ?? "mock-session";
  const delay = stepDelay();
  const emitEvent = (e: AgentRunEvent) => runOptions.onAgentEvent?.(e);

  // 累计文本:既驱动实时流式,又作为最终落库 content,二者保持一致。
  let full = "";
  const say = async (t: string) => {
    full += t;
    runOptions.onChunk?.(t);
    await sleep(delay);
  };
  const done = (): MockResult => ({ mode: "mock", claudeSessionId, content: full });

  // ── journey: 生成文件(写真文件进 outputDir,供产物追踪 + 预览验证)──────────
  if (/生成|导出|excel|表格|报表|xlsx|文件/i.test(text)) {
    await say("好的,我来生成一个示例表格。");
    emitEvent({ type: "tool_use", id: "mock-gen-1", name: "run_python", input: { task: "build_xlsx" } });
    await sleep(delay);
    const fileName = "示例报表.xlsx";
    if (runOptions.outputDir) {
      mkdirSync(runOptions.outputDir, { recursive: true });
      // 只验证产物被追踪 + 可点开,不解析内容,故写占位字节即可;多类型便于看文件图标配色。
      for (const f of [fileName, "示例演示.pptx", "示例说明.docx"]) {
        writeFileSync(path.join(runOptions.outputDir, f), "mock-bytes");
      }
    }
    emitEvent({ type: "tool_result", toolUseId: "mock-gen-1", name: "run_python", content: `已生成 ${fileName}`, durationMs: 6 });
    await say(`已生成 ${fileName},可在下方查看。`);
    return done();
  }

  // ── journey: 人机确认(AskUserQuestion / ask_user 浮层)────────────────────
  if (/选|方案|哪个|确认一下|二选一/.test(text) && runOptions.resolveUserQuestion) {
    await say("这个需要你定一下口径。");
    const answer = await runOptions.resolveUserQuestion({
      question: "按哪种口径处理?",
      header: "处理口径",
      options: [
        { label: "方案甲", description: "金额按含税口径汇总" },
        { label: "方案乙", description: "金额按不含税口径汇总" },
      ],
    });
    await say(`好的,按「${answer}」口径处理。`);
    return done();
  }

  // ── journey: 计算回执卡(tax_calculator 返 CalcReceipt → 通用回执卡片下钻)──
  // 放在宽口径"报销|…|税"之前,让"增值税"专走带 structuredContent 的回执链路。
  if (/增值税|算税|税额/i.test(text)) {
    await say("我来算一下这笔增值税。");
    emitEvent({ type: "tool_use", id: "mock-tax-1", name: "tax_calculator", input: { type: "vat", amount: 100000 } });
    await sleep(delay);
    emitEvent({
      type: "tool_result",
      toolUseId: "mock-tax-1",
      name: "tax_calculator",
      content: "不含税价 100000.00 元，税率 13%，销项税额 13000.00 元。",
      durationMs: 8,
      structured: {
        value: 13000,
        unit: "CNY",
        rounding: "half_up",
        steps: [
          { label: "销项税额", expr: "100000.00 × 13% = 13000.00", inputs: {}, subtotal: 13000 },
        ],
        source: [],
        basis: { caliberVersion: "tax-config@2025.1", settlementStatus: "draft", asOf: "2025-06" },
        caveats: ["税率取自当期合法税率集，如政策调整请在设置中更新口径后重算。"],
      },
    });
    await say("销项税额 13000.00 元，明细见上方回执卡片。");
    return done();
  }

  // ── journey: 工具卡(确定性工具调用 + 结果渲染)──────────────────────────
  if (/报销|对账|核对|校验|薪|工资|税/i.test(text)) {
    await say("我来核对一下数据。");
    emitEvent({ type: "tool_use", id: "mock-tool-1", name: "validate_reimbursement", input: { rows: 2 } });
    await sleep(delay);
    emitEvent({
      type: "tool_result",
      toolUseId: "mock-tool-1",
      name: "validate_reimbursement",
      content: "校验 2 条:1 条发票号重复需注意",
      durationMs: 9,
    });
    await say("核对完成:共 2 条,其中 1 条发票号重复,建议人工复核。");
    return done();
  }

  // ── journey: 多工具流程演示(验证工具步骤时间线的类型图标 / 失败标红 / 折叠)──
  if (/工具演示|流程演示|步骤演示/.test(text)) {
    await say("我按几个步骤来处理。");
    const steps: Array<{ name: string; input: unknown; result: string; isError?: boolean }> = [
      { name: "Skill", input: { command: "finance-skills:finance-analysis" }, result: "已加载技能" },
      // mcp 工具带 mcp__<server>__ 前缀(贴近真实),验证图标/剥前缀的归一化
      { name: "mcp__finance__run_python", input: { code: "rev = Decimal('55379467.47')" }, result: "ok" },
      { name: "mcp__finance__search_knowledge", input: { query: "差旅住宿标准" }, result: "命中 3 篇" },
      { name: "WebSearch", input: { query: "增值税最新税率" }, result: "找到若干结果" },
      { name: "Edit", input: { file_path: "/Users/user/report.md" }, result: "已写入" },
      { name: "Bash", input: { command: "ls /nonexistent" }, result: "No such file or directory", isError: true },
    ];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      emitEvent({ type: "tool_use", id: `demo-${i}`, name: s.name, input: s.input });
      await sleep(delay);
      emitEvent({ type: "tool_result", toolUseId: `demo-${i}`, name: s.name, content: s.result, isError: s.isError, durationMs: 1000 + i * 300 });
      await sleep(delay);
    }
    await say("处理完成,以上是各步骤。");
    return done();
  }

  // ── journey: 富 markdown 排版样例(验证自管 .md-content 渲染:标题/列表/表格/代码/引用/外链)──
  if (/排版|样例|markdown|渲染/i.test(text)) {
    await say(
      [
        "# 一级标题",
        "## 二级标题",
        "### 三级标题",
        "",
        "这是一段**加粗**、*斜体*与 `行内代码` 的正文。",
        "",
        "- 无序项 A",
        "- 无序项 B",
        "  - 嵌套项",
        "",
        "1. 有序一",
        "2. 有序二",
        "",
        "> 这是一段引用。",
        "",
        "| 项目 | 金额 |",
        "| :--- | ---: |", // 金额列标了右对齐,验证 CSS 强制统一左对齐
        "| 收入 | 123 |",
        "| 支出 | 45 |",
        "",
        "```python",
        "def hello():",
        '    print("hi")',
        "```",
        "",
        "参考:https://openai.github.io/openai-agents-python/streaming/",
      ].join("\n")
    );
    return done();
  }

  // ── journey: 普通问答(流式文本)────────────────────────────────────────
  await say("你好,我是本地模拟 Agent(确定性 e2e 用)。");
  if (text.trim()) await say(`你刚才说的是:「${text.trim()}」。`);
  return done();
}
