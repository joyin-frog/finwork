export type HistoricalFinanceCase = {
  id: string;
  sourceSessionId: string;
  title: string;
  input: string;
  realInput?: string;
  fixtureFiles?: string[];
  historicalToolCalls: number;
  expectedToolCalls?: string[];
  mustNotCall?: string[];
  mustContainKeywords: string[];
  judgeRubric: string;
};

// 输入为等价合成数据；原始会话中的公司名、员工名、文件和金额均不进入仓库。
export const HISTORICAL_FINANCE_CASES: HistoricalFinanceCase[] = [
  {
    id: "HISTORY-001",
    sourceSessionId: "019f883f-5291-7813-be9e-a639c9b10a60",
    title: "Q2 报表誊抄与列保护",
    realInput: "把合并报表的第二季度数据誊抄到数据包报表的 2026Q2 列，其他列不要改；检查准确性，并计算 2026Q2 列的数据分析。",
    fixtureFiles: ["dusen20260721/合并模版.xlsx", "dusen20260721/母公司第二季度季报.xlsx", "dusen20260721/子公司第二季度报表.xlsx"],
    input: "把下面视为已经从目标财务报表和 Q2 数据包读取出的结构化数据。请说明如何把 Q2 数据誊抄到目标表的 2026Q2 列，只修改该列；其他期间、公式和格式保持不变，并计算该列的数据分析。完成后说明修改范围和校验结果。合成约束：目标表有 2025Q4、2026Q1、2026Q2 三列，Q2 数据包含收入 120000、成本 70000、费用 18000、利润 32000。",
    historicalToolCalls: 78,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["2026Q2", "只修改", "32000"],
    judgeRubric: "明确只改 Q2 列，保留其他列/公式/格式，计算利润并说明校验，不声称改动不存在的原始文件。",
  },
  {
    id: "HISTORY-002",
    sourceSessionId: "019f832e-76ef-7573-9645-502499650c2c",
    title: "母子公司合并报表与现金流抵消",
    realInput: "以上为母子公司合并报表的数据源，请按照调整及抵消数据点要求编制合并报表。现金流还要抵消：母公司支付采购商品款与子公司销售收款的内部交易，以及母公司收到其他经营现金与子公司支付其他经营现金的内部交易。请重新生成并核对借贷、现金流和公式。",
    fixtureFiles: ["dusen20260721/合并模版.xlsx", "dusen20260721/母公司最新科目余额表.xlsx", "dusen20260721/子公司最新科目余额表.xlsx", "dusen20260721/母公司第二季度季报.xlsx", "dusen20260721/子公司第二季度报表.xlsx", "dusen20260721/调整及抵消数据点.docx"],
    input: "请根据以下合成数据编制母子公司合并报表：母公司实收资本 1000000、长期股权投资 300000；子公司实收资本 300000、母子公司内部应收应付 180000；母公司支付采购款 381122.95、子公司收到销售款 381122.95；母公司收到其他经营现金 3925000、子公司支付其他经营现金 3925000。要求列示长投权益、内部往来和两组现金流抵消分录，说明合并净额不因内部抵消改变，并保留数据推导链。",
    historicalToolCalls: 85,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["381122.95", "3925000", "抵消", "借贷平衡"],
    judgeRubric: "四类抵消均覆盖，借贷方向和金额正确；区分列报抵消与合并净额；说明来源、勾稽和待复核项。",
  },
  {
    id: "HISTORY-003",
    sourceSessionId: "019e4850-1c1d-7f40-b7c1-ffd0e5d1739e",
    title: "个人所得税计算与公式",
    realInput: "根据个人所得税税率表和 Excel 数据，把表中的个税算出来，并在表中列出计算公式。",
    fixtureFiles: ["个税/微信图片_20260521101029_8856_16.png", "个税/新建 XLSX 工作表.xlsx"],
    input: "请按综合所得年度税率表计算三名员工的月度个税，并在结果中列出可复核公式。合成数据：A 税前月薪 22000、个人社保公积金 2500、专项附加扣除 2000；B 为 18500、1900、1000；C 为 14500、1500、1500。口径：全年应纳税所得额=月薪×12-个人扣除×12-专项附加-60000，月度个税=MAX(全年应纳税所得额×税率-速算扣除数,0)/12。",
    historicalToolCalls: 34,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["全年应纳税所得额", "速算扣除数", "月度个税", "公式"],
    judgeRubric: "逐人给出税率档位、速算扣除数、全年应纳税所得额和月度个税；公式与口径一致，结果可在 Excel 中复核。",
  },
  {
    id: "HISTORY-004",
    sourceSessionId: "019e76f5-2151-7322-9da2-3ba9e5b2858f",
    title: "费用限额公式",
    realInput: "根据文件通知，把需做表格的事务费、工资费、管理费的限额公式列示出来。把公式写到 Excel 里，用户填 B 列金额后可以自动计算限额；补充制度中遗漏的科目，并确保 WPS 能看到公式。",
    fixtureFiles: ["dusen20260530/文件通知.pdf", "dusen20260530/需做表格.xlsx"],
    input: "根据以下已读取的制度规则，设计一个 Excel 公式方案：用户只填写 B 列金额，就能自动计算所有限额；覆盖事务费、工资费、管理费和固定资产折旧费，公式必须是真正可计算的 Excel 公式，而不是中文说明，并兼容常见办公软件。合成规则：事务费限额=收入×1%，工资费限额=收入×20%，管理费限额=收入×10%，折旧费限额=固定资产原值×5%。请同时说明各公式的依据。",
    historicalToolCalls: 44,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["公式", "B列", "折旧", "限额"],
    judgeRubric: "先识别制度科目和公式依据，再输出可直接填入表格的公式；不遗漏制度明确科目，不把公式写成自然语言。",
  },
  {
    id: "HISTORY-005",
    sourceSessionId: "019e06da-e2c6-7fa1-930e-4f89b811f615",
    title: "Excel 数据转正式业务回复",
    realInput: "根据这个目录下的四个 Excel，回答钧石回复文档里的问题；整理成一版更正式的给钧石回复话术，并写回文档。",
    fixtureFiles: ["dusen20260508/都森电子_Datapack有修改.xlsx", "dusen20260508/2026年第一季度科目余额表.xlsx", "dusen20260508/2025年第一季度科目余额表.xlsx", "dusen20260508/2026年预算表.xlsx", "dusen20260508/钧石回复.docx"],
    input: "根据下面已整理的四张合成 Excel 表数据和问题文档，回答对方提出的财务问题，并整理成正式、可直接发送的回复话术：收入 520、成本 300、研发费用 120、期末现金 80；对方问题是‘请说明本期经营情况、研发投入和现金情况，并指出还需确认什么’。要求每个结论能追溯到字段，区分事实、计算和待确认事项，最后给出正式版文本。",
    historicalToolCalls: 24,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["正式", "依据", "待确认"],
    judgeRubric: "先完成数据问答，再输出语气正式、可直接发送的回复；结论有数据依据，未知事项明确标注。",
  },
  {
    id: "HISTORY-006",
    sourceSessionId: "019d666a-7c74-75c3-87bc-a4a2a43abdff",
    title: "多 Sheet 财务报表分析",
    realInput: "文件夹下有母公司和全资子公司的第一季度财务报表、科目余额表和合并模板。请编制合并报表，列示内部抵消分录，并展示每个合并数的来源和推导过程；不要修改原始文件。",
    fixtureFiles: ["dusen/合并模板.xlsx", "dusen/都森2026年第一季度科目余额表.xlsx", "dusen/都森（江西）第一季度科目余额表.xlsx", "dusen/都森第一季度财务报表.xlsx", "dusen/都森（江西）第一季度财务报表.xlsx"],
    input: "把下面视为已经读取的多 Sheet 财务工作簿摘要，分析资产负债表、利润表、现金流量表和科目余额表：资产 1000、负债 600、权益 400、收入 520、成本 300、期间费用 120、利润 100、期末现金 80，科目余额表借贷合计均为 1600。要求给出资产、负债、权益、收入、利润、现金和关键变动的结论，展示核心数字如何从各 Sheet 得到，并指出公式错误、勾稽不平或需要人工复核的项目。",
    historicalToolCalls: 101,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["资产负债表", "利润表", "现金流量表", "复核"],
    judgeRubric: "覆盖多 Sheet 关系，结论和数字可追溯；不只给泛泛分析，能指出异常和复核边界。",
  },
  {
    id: "HISTORY-007",
    sourceSessionId: "019db84a-fc41-7be2-948d-29cbff3c5022",
    title: "子公司经营预测",
    realInput: "根据子公司落地协议、关键点 Excel 和母公司预测表，为子公司出具 2026—2028 年研发费用、固定资产、营收预测数据，并出具数据依据和计算过程。",
    fixtureFiles: ["dusen2/子公司落地协议.docx", "dusen2/子公司落地协议关键点.xlsx", "dusen2/都森2026-2030年预测表.xlsx"],
    input: "根据一份落地协议摘要和母公司预测表，为新成立子公司编制 2026—2028 年研发费用、固定资产和营业收入预测，并给出数据依据、年度假设、计算过程和需要管理层确认的前提。合成母公司基准为：2026 收入 1000、研发 120、固定资产净增 80；2027 收入 1300、研发 160、固定资产净增 100；2028 收入 1700、研发 220、固定资产净增 130。",
    historicalToolCalls: 41,
    expectedToolCalls: ["analyze_tabular"],
    mustNotCall: ["run_python"],
    mustContainKeywords: ["2026", "2027", "2028", "依据", "假设"],
    judgeRubric: "逐年给出三项预测，说明从母公司数据到子公司的分配/增长假设，区分已知数据和管理层待确认事项。",
  },
];
