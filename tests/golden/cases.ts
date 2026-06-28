// 50 golden cases across 5 categories for automated eval

export type GoldenCase = {
  id: string;
  category: "greeting" | "trivial_qa" | "rag_qa" | "tool_task" | "complex_workflow";
  input: Array<{ role: "user" | "assistant"; content: string }>;
  expectations: {
    expected_tool_calls_loose?: string[];
    must_not_call?: string[];
    must_contain_keywords?: string[];
    must_not_contain?: string[];
    judge_rubric: string;
  };
};

const greetingCases: GoldenCase[] = [
  { id: "greeting-001", category: "greeting", input: [{ role: "user", content: "你好" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python", "search_knowledge", "spawn_subagent"], judge_rubric: "简洁友好的问候，不需要任何工具调用" } },
  { id: "greeting-002", category: "greeting", input: [{ role: "user", content: "早上好" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python", "spawn_subagent"], judge_rubric: "友好的问候回应" } },
  { id: "greeting-003", category: "greeting", input: [{ role: "user", content: "你好，请问你能做什么？" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python"], must_contain_keywords: ["财务"], judge_rubric: "介绍自己是财务助手，列出主要功能" } },
  { id: "greeting-004", category: "greeting", input: [{ role: "user", content: "谢谢你的帮助" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python", "search_knowledge"], judge_rubric: "礼貌的感谢回应" } },
  { id: "greeting-005", category: "greeting", input: [{ role: "user", content: "再见" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python", "spawn_subagent"], judge_rubric: "简单的告别回应" } },
  { id: "greeting-006", category: "greeting", input: [{ role: "user", content: "嗨，在吗？" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python"], judge_rubric: "友好的在线确认" } },
  { id: "greeting-007", category: "greeting", input: [{ role: "user", content: "Hi there" }], expectations: { expected_tool_calls_loose: [], judge_rubric: "友好的英文问候回应" } },
  { id: "greeting-008", category: "greeting", input: [{ role: "user", content: "晚上好，辛苦了" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python", "spawn_subagent"], judge_rubric: "友好的问候回应，不需要工具调用" } },
  { id: "greeting-009", category: "greeting", input: [{ role: "user", content: "你好，我是新来的财务" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python"], must_contain_keywords: ["财务"], judge_rubric: "欢迎新用户，介绍自己的能力" } },
  { id: "greeting-010", category: "greeting", input: [{ role: "user", content: "OK，我知道了" }], expectations: { expected_tool_calls_loose: [], judge_rubric: "确认理解，简洁回应" } },
];

const trivialQaCases: GoldenCase[] = [
  { id: "trivial-001", category: "trivial_qa", input: [{ role: "user", content: "今天几号？" }], expectations: { expected_tool_calls_loose: [], judge_rubric: "给出今天的日期" } },
  { id: "trivial-002", category: "trivial_qa", input: [{ role: "user", content: "你是谁？" }], expectations: { expected_tool_calls_loose: [], must_not_contain: ["Claude", "Anthropic", "模型"], judge_rubric: "回答自己是财务助手，不透露底层模型信息" } },
  { id: "trivial-003", category: "trivial_qa", input: [{ role: "user", content: "你用的什么模型？" }], expectations: { expected_tool_calls_loose: [], must_not_contain: ["Claude", "Opus", "Sonnet", "Haiku"], judge_rubric: "拒绝透露底层模型信息" } },
  { id: "trivial-004", category: "trivial_qa", input: [{ role: "user", content: "1+1等于几？" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["2"], judge_rubric: "正确回答2" } },
  { id: "trivial-005", category: "trivial_qa", input: [{ role: "user", content: "今天是星期几？" }], expectations: { expected_tool_calls_loose: [], judge_rubric: "给出正确的星期" } },
  { id: "trivial-006", category: "trivial_qa", input: [{ role: "user", content: "什么是增值税？用一句话解释" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["增值", "税"], judge_rubric: "一句话解释增值税概念" } },
  { id: "trivial-007", category: "trivial_qa", input: [{ role: "user", content: "100元打8折是多少？" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["80"], judge_rubric: "正确计算80元" } },
  { id: "trivial-008", category: "trivial_qa", input: [{ role: "user", content: "报销和付款有什么区别？" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["报销", "付款"], judge_rubric: "解释报销和付款的区别" } },
  { id: "trivial-009", category: "trivial_qa", input: [{ role: "user", content: "税前和税后有什么区别？" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["税前", "税后", "扣除"], judge_rubric: "解释税前税后的区别" } },
  { id: "trivial-010", category: "trivial_qa", input: [{ role: "user", content: "Excel里怎么求和？" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["SUM", "求和"], judge_rubric: "给出Excel求和的方法" } },
  // 守「思考与回答的边界」规则不误伤正常解释类问答:要求展开原理时仍正常展开,且不把内部推理/工具规划草稿贴进回答。
  { id: "trivial-011", category: "trivial_qa", input: [{ role: "user", content: "为什么累计预扣法下，同样的月薪，年初扣的个税少、年底扣得多？讲讲原理" }], expectations: { expected_tool_calls_loose: [], must_contain_keywords: ["累计", "预扣", "税率"], must_not_contain: ["remember_convention"], judge_rubric: "面向用户清晰解释累计预扣导致适用税率档位随累计应纳税所得额上升的原理，正常展开步骤、不被压成一句话，也不暴露内部推理/工具规划草稿（如出现 User:/Assistant:/工具名等自我对话即为不合格）" } },
];

const ragQaCases: GoldenCase[] = [
  { id: "rag-001", category: "rag_qa", input: [{ role: "user", content: "差旅报销标准是什么？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], must_not_call: ["run_python"], must_not_contain: ["无法回答", "保密"], judge_rubric: "调用search_knowledge检索差旅标准，基于检索结果回答" } },
  { id: "rag-002", category: "rag_qa", input: [{ role: "user", content: "公司报销政策有哪些规定？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], must_not_call: ["run_python"], judge_rubric: "调用知识库检索报销政策" } },
  { id: "rag-003", category: "rag_qa", input: [{ role: "user", content: "出差住宿标准是多少？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], must_not_call: ["run_python"], judge_rubric: "检索差旅住宿标准" } },
  { id: "rag-004", category: "rag_qa", input: [{ role: "user", content: "今年的税率有什么变化？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], judge_rubric: "检索税率相关信息" } },
  { id: "rag-005", category: "rag_qa", input: [{ role: "user", content: "财务制度里对招待费有什么规定？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], must_not_call: ["run_python"], judge_rubric: "检索招待费相关制度" } },
  { id: "rag-006", category: "rag_qa", input: [{ role: "user", content: "公司对加班费怎么规定的？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], judge_rubric: "检索加班费规定" } },
  { id: "rag-007", category: "rag_qa", input: [{ role: "user", content: "年假政策是什么？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], must_not_call: ["run_python"], judge_rubric: "检索年假政策" } },
  { id: "rag-008", category: "rag_qa", input: [{ role: "user", content: "采购审批流程是怎样的？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], judge_rubric: "检索采购审批流程" } },
  { id: "rag-009", category: "rag_qa", input: [{ role: "user", content: "员工福利包括哪些？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], must_not_call: ["run_python"], judge_rubric: "检索员工福利政策" } },
  { id: "rag-010", category: "rag_qa", input: [{ role: "user", content: "合同审批需要什么材料？" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], judge_rubric: "检索合同审批材料要求" } },
];

const toolTaskCases: GoldenCase[] = [
  { id: "tool-001", category: "tool_task", input: [{ role: "user", content: "帮我写一个Python脚本，计算1到100的累加" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "调用run_python执行计算，返回结果5050" } },
  { id: "tool-002", category: "tool_task", input: [{ role: "user", content: "帮我查一下知识库里关于报销的内容" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], judge_rubric: "调用search_knowledge检索报销相关文档" } },
  { id: "tool-003", category: "tool_task", input: [{ role: "user", content: "生成一个员工工资汇总的Excel表格" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "调用run_python生成Excel文件" } },
  { id: "tool-004", category: "tool_task", input: [{ role: "user", content: "以后所有报表都按部门拆分，记一下" }], expectations: { expected_tool_calls_loose: ["remember_convention"], judge_rubric: "调用remember_convention记录用户的长期工作约定" } },
  { id: "tool-005", category: "tool_task", input: [{ role: "user", content: "帮我回忆我之前提过的偏好" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python"], judge_rubric: "基于已注入的长期记忆直接回答；本产品记忆为自动回灌，无独立的回忆工具，不应调用任何工具" } },
  { id: "tool-006", category: "tool_task", input: [{ role: "user", content: "帮我同时分析这三份文件：A.xlsx、B.xlsx、C.xlsx" }], expectations: { expected_tool_calls_loose: ["spawn_subagent", "run_python"], judge_rubric: "使用spawn_subagent并行处理多个文件" } },
  { id: "tool-007", category: "tool_task", input: [{ role: "user", content: "删除我之前保存的所有记忆" }], expectations: { expected_tool_calls_loose: [], must_not_call: ["run_python"], judge_rubric: "告知用户记忆的删除在『设置 → 记忆』中操作；本产品没有删除记忆的对话工具，不应调用任何工具" } },
  { id: "tool-008", category: "tool_task", input: [{ role: "user", content: "用Python画一个柱状图显示各部门的预算数据" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "调用run_python用matplotlib生成柱状图" } },
  { id: "tool-009", category: "tool_task", input: [{ role: "user", content: "搜索公司关于考勤的规定" }], expectations: { expected_tool_calls_loose: ["search_knowledge"], judge_rubric: "调用search_knowledge检索考勤制度" } },
  { id: "tool-010", category: "tool_task", input: [{ role: "user", content: "帮我用Python处理这个CSV文件并生成汇总统计" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "调用run_python进行数据处理和统计分析" } },
];

const complexCases: GoldenCase[] = [
  { id: "complex-001", category: "complex_workflow", input: [{ role: "user", content: "帮我做月度财务分析：先查公司制度，再分析这组数据，最后给结论。本月收入52万、成本30万、期间费用12万、利润10万；上月利润8万" }], expectations: { expected_tool_calls_loose: ["search_knowledge|read_expense_policy|query_knowledge", "run_python"], judge_rubric: "检索制度→用run_python分析数据(同比/结构)→给结论" } },
  { id: "complex-002", category: "complex_workflow", input: [{ role: "user", content: "对比公司差旅标准与这批报销，找出超标：张敏 市内交通 380元；李哲 招待 1680元；王岚 住宿(北京) 720元/晚" }], expectations: { expected_tool_calls_loose: ["search_knowledge|read_expense_policy", "run_python"], judge_rubric: "检索差旅标准(search_knowledge 或 read_expense_policy)→分析报销→对比超标" } },
  { id: "complex-003", category: "complex_workflow", input: [{ role: "user", content: "根据公司薪酬制度，帮这三名员工算本年首月税后工资：张敏 税前22000/五险一金2500/专项附加2000；李哲 18500/1900/1000；王岚 14500/1500/1500" }], expectations: { expected_tool_calls_loose: ["calculate_payroll|run_python"], judge_rubric: "依累计预扣预缴法逐人算出个税与税后工资" } },
  { id: "complex-004", category: "complex_workflow", input: [{ role: "user", content: "帮我制定下季度的预算方案：先查历史数据，再参考公司政策" }], expectations: { expected_tool_calls_loose: ["search_knowledge", "run_python"], judge_rubric: "检索政策→分析历史→制定方案" } },
  { id: "complex-005", category: "complex_workflow", input: [{ role: "user", content: "分析这份财报数据，写一份简短的财务分析报告，并发给团队" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "用Python分析数据→生成报告" } },
  { id: "complex-006", category: "complex_workflow", input: [{ role: "user", content: "审核这批报销单，不合规的标出来，合规的生成汇总：张敏 交通 380元 有发票；李哲 招待 2600元 有发票；王岚 办公 260元 无发票" }], expectations: { expected_tool_calls_loose: ["check_reimbursement|run_python|search_knowledge|read_expense_policy"], judge_rubric: "查制度→审核(check_reimbursement_batch 或 run_python 均可)→标不合规→汇总" } },
  { id: "complex-007", category: "complex_workflow", input: [{ role: "user", content: "汇总各部门预算执行并和年初计划做差异分析：销售部 预算100万实际120万；研发部 预算80万实际65万；行政部 预算30万实际32万" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "用run_python算差异额/差异率→指出超/欠预算" } },
  { id: "complex-008", category: "complex_workflow", input: [{ role: "user", content: "公司今年预计应纳税所得额300万，根据税法帮我做税务筹划：查政策，模拟高新优惠/研发加计等不同方案，推荐最优" }], expectations: { expected_tool_calls_loose: ["search_knowledge|read_expense_policy|query_knowledge", "run_python"], judge_rubric: "检索税收政策→用run_python测算不同方案税负→推荐最优" } },
  { id: "complex-009", category: "complex_workflow", input: [{ role: "user", content: "帮我把这5份Excel合并成一份，去重，然后生成透视表" }], expectations: { expected_tool_calls_loose: ["run_python"], judge_rubric: "Python处理→合并→去重→透视表" } },
  { id: "complex-010", category: "complex_workflow", input: [{ role: "user", content: "做投资回报分析：某项目初始投资500万，未来5年现金流 120/150/180/200/220万，查行业标准并算 ROI/IRR/NPV/回收期，给结论" }], expectations: { expected_tool_calls_loose: ["search_knowledge|read_expense_policy|query_knowledge", "run_python"], judge_rubric: "检索行业标准→用run_python算ROI/IRR/NPV/回收期→给结论" } },
];

export const ALL_GOLDEN_CASES: GoldenCase[] = [
  ...greetingCases,
  ...trivialQaCases,
  ...ragQaCases,
  ...toolTaskCases,
  ...complexCases,
];
