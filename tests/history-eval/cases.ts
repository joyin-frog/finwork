import type { TaskContract } from "@/lib/agent/run-contract";

export type HistoricalArtifactAssertion = {
  id: string;
  description: string;
  deliverableId: string;
  kind:
    | "contains_all"
    | "contains_any"
    | "xlsx_min_sheets"
    | "xlsx_min_formulas"
    | "xlsx_cells_equal"
    | "xlsx_formulas_equal"
    | "xlsx_only_allowed_cells_changed"
    | "docx_min_chars";
  values?: string[];
  minimum?: number;
  /** Sheet-qualified addresses, e.g. `Sheet1!H5`, mapped to expected cached values. */
  cells?: Record<string, string | number>;
  realCells?: Record<string, string | number>;
  /** Sheet-qualified addresses mapped to literal formulas, including the leading `=`. */
  formulas?: Record<string, string>;
  realFormulas?: Record<string, string>;
  referenceFixture?: string;
  allowedSheet?: string;
  allowedColumns?: string[];
  appliesTo?: "all" | "real" | "synthetic";
  critical?: boolean;
  weight?: number;
  /** 真实附件模式和合成输入可使用不同的冻结事实。 */
  realValues?: string[];
};

export type HistoricalFinanceCase = {
  id: string;
  sourceSessionId: string;
  title: string;
  input: string;
  realInput?: string;
  fixtureFiles?: string[];
  historicalToolCalls: number;
  taskContract: TaskContract;
  artifactAssertions: HistoricalArtifactAssertion[];
  judgeRubric: string;
};

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * 冻结原始附件，避免曾被历史会话原地写回的文件混入能力评测。
 * 这些 hash 对应上传前/写入前版本；真实模式启动时必须逐个匹配。
 */
export const HISTORICAL_FIXTURE_SHA256: Record<string, string> = {
  "dusen/合并模板.xlsx": "fcc07d365fcd4d5867addda8e1e867e5d0bf17742626e7074fc3731fbf8523f5",
  "dusen/都森2026年第一季度科目余额表.xlsx": "0816d5eee73836fc09e75eba23998426050c422e216c34335c937883e88d3fcd",
  "dusen/都森第一季度财务报表.xlsx": "773e942f0ba23e7c79e4ab62f5d2413501e9c5ba4bd3161f7fdc06100655b366",
  "dusen/都森（江西）第一季度科目余额表.xlsx": "3c168afa13752040cc615ea2bc77dc3091dbdf519d531cad1aafd0a8dd747e20",
  "dusen/都森（江西）第一季度财务报表.xlsx": "ee18b61d0aa45ff747db26624ceb172a485be2e071296978b491ba1c97028809",
  "dusen2/子公司落地协议.docx": "064494fd208424ad595b2b673e4f21277f4e0d4a6529715baddd93459bf32510",
  "dusen2/子公司落地协议关键点.xlsx": "c36d73bdd0a7fb3a635f2ceda72d4c70f011fcbc6a98f40ee5f493c612be314c",
  "dusen2/都森2026-2030年预测表.xlsx": "227d340b4b5475519e90820af12443c945f92e74d75ab510c2ca8f04669d7a93",
  "dusen20260508/2025年第一季度科目余额表.xlsx": "2e5aee3bf30f6178812b9db8ef28036b4c567f8d94f2be3289d229e4dc8aa369",
  "dusen20260508/2026年第一季度科目余额表.xlsx": "3a6dc828bdfc360489e6b7f3266a4dc7bb0f9a2ef49ce211f54511d855dd0a5c",
  "dusen20260508/2026年预算表.xlsx": "81fd80a98fc95bd0905704a0e844937e4f6875bcf8a04ba5e2dd187d02c70f1e",
  "dusen20260508/都森电子_Datapack有修改.xlsx": "857bd4ecbc7afb3c2664be529bce8a83c81ce3589ae218e5b56b3662d558adec",
  "dusen20260508/钧石回复.docx": "a281f2aca8c4b01d7835fdbf0667207db2c65e90dbdcc850e32f21c856a34e86",
  "dusen20260530/文件通知.pdf": "ef8c712ecaca8001f23263bc4ec9d53cd7661d09ab0b7a06483a2790b1d86810",
  "dusen20260530/需做表格.xlsx": "3991198d11ffbc9f84809125290a4133909ae3fea066e8a1934d273a69c1c08e",
  "dusen20260721/合并模版.xlsx": "fcc07d365fcd4d5867addda8e1e867e5d0bf17742626e7074fc3731fbf8523f5",
  "dusen20260721/子公司最新科目余额表.xlsx": "8c407d9ff62c7ec3478f8ab5b02bf9fe379f8692a62cd16e2b4c2e2d7d69d824",
  "dusen20260721/子公司第二季度报表.xlsx": "2c2ee5785c425b2d2b8c87fa27a4adb95bb735d3166d4181c937de9937c5169f",
  "dusen20260721/母公司最新科目余额表.xlsx": "2182e8c8ba0e595541fd4fa3956b9abc597331e1f347f51c3f07116203f156a3",
  "dusen20260721/母公司第二季度季报.xlsx": "900f2f276080652485080bfcf6f9fb2a0c66ebf485cd5e828198379a38742bf9",
  "dusen20260721/调整及抵消数据点.docx": "fc93aeae24fa19fcda69c1bd6314b9706e195bacbea5f2e453abf7436568895b",
  "个税/微信图片_20260521101029_8856_16.png": "a54a3ed16a3dd6dbe346c1e9519703e99e82f9fe9dbb84fff487c29d651ad9b8",
  "个税/新建 XLSX 工作表.backup-20260521-个税写入前.xlsx": "63f2727cab4320fda978fce78d2a75c447691be2d0c9dbe4613ae7bd0b9ff02d",
  "history001/合并报表-第二季度.xlsx": "9a458ebf21171fae374c0dfe0d3a4b17492ee579c7bcffc0caeebc6ed0be038e",
  "history001/都森电子Q2_Datapack.xlsx": "93a28af9c18c51597c18027ab18a6e29b76daa05e0ec9a503acca7fe57e8757d",
};

function workbookContract(
  qualityProfile: "generic" | "financial_consolidation" = "generic",
  options: { needsRecalc?: boolean; needsRender?: boolean } = {},
): TaskContract {
  const consolidation = qualityProfile === "financial_consolidation";
  return {
    version: 1,
    taskKind: consolidation ? "financial_consolidation" : "spreadsheet",
    spreadsheetRequirement: {
      needsLegacyXlsRead: false,
      needsWrite: true,
      needsRecalc: options.needsRecalc ?? consolidation,
      needsRender: options.needsRender ?? consolidation,
      needsMacroPreservation: false,
    },
    requiredDeliverables: [
      { id: "workbook", mime: XLSX_MIME, count: 1, qualityProfile },
    ],
    expectationSnapshot: {},
  };
}

function documentContract(): TaskContract {
  return {
    version: 1,
    taskKind: "text",
    requiredDeliverables: [
      { id: "document", mime: DOCX_MIME, count: 1, qualityProfile: "generic" },
    ],
    expectationSnapshot: {},
  };
}

function forecastContract(): TaskContract {
  return {
    version: 1,
    taskKind: "spreadsheet",
    spreadsheetRequirement: {
      needsLegacyXlsRead: false,
      needsWrite: true,
      needsRecalc: true,
      needsRender: true,
      needsMacroPreservation: false,
    },
    requiredDeliverables: [
      { id: "workbook", mime: XLSX_MIME, count: 1, qualityProfile: "generic" },
      { id: "document", mime: DOCX_MIME, count: 1, qualityProfile: "generic" },
    ],
    expectationSnapshot: {},
  };
}

// 输入为等价合成数据；原始会话中的公司名、员工名、文件和金额均不进入仓库。
export const HISTORICAL_FINANCE_CASES: HistoricalFinanceCase[] = [
  {
    id: "HISTORY-001",
    sourceSessionId: "019f883f-5291-7813-be9e-a639c9b10a60",
    title: "Q2 报表誊抄与列保护",
    realInput: "把“合并报表-第二季度.xlsx”的第二季度累计数据誊抄到“都森电子Q2_Datapack.xlsx”中 `1>财务报表` 的 2026Q2（P列），并计算同一列数据分析区域的指标。只允许修改该工作表 P 列；其他列、工作表、公式和格式保持不变。资产负债表用期末数，利润表和现金流量表用本期累计数；按模板既有 365 天、2025Q2 同比、ROE/ROA 平均余额口径计算并检查资产配平、利润和期末现金。",
    fixtureFiles: ["history001/合并报表-第二季度.xlsx", "history001/都森电子Q2_Datapack.xlsx"],
    input: "把下面视为已经从目标财务报表和 Q2 数据包读取出的结构化数据。请说明如何把 Q2 数据誊抄到目标表的 2026Q2 列，只修改该列；其他期间、公式和格式保持不变，并计算该列的数据分析。完成后说明修改范围和校验结果。合成约束：目标表有 2025Q4、2026Q1、2026Q2 三列，Q2 数据包含收入 120000、成本 70000、费用 18000、利润 32000。",
    historicalToolCalls: 78,
    taskContract: workbookContract("generic", {
      // 该任务的首要约束是除 P 列外字节/语义不漂移；全簿重算会改写
      // 外部链接公式缓存，因此只渲染候选，确定性断言单独检查 P 列结果。
      needsRecalc: false,
      needsRender: true,
    }),
    artifactAssertions: [
      { id: "q2-column", description: "产物包含 2026Q2 列", deliverableId: "workbook", kind: "contains_all", values: ["2026Q2"], critical: true },
      { id: "q2-values", description: "合成产物包含关键 Q2 数字", deliverableId: "workbook", kind: "contains_all", values: ["120000", "70000", "18000", "32000"], appliesTo: "synthetic", critical: true, weight: 2 },
      {
        id: "q2-key-cells",
        description: "真实数据包关键报表数与分析指标匹配历史确认结果",
        deliverableId: "workbook",
        kind: "xlsx_cells_equal",
        appliesTo: "real",
        realCells: {
          "1>财务报表!P7": 96034826.92,
          "1>财务报表!P35": 133213633.47,
          "1>财务报表!P74": 19950304.53,
          "1>财务报表!P96": -17422900.91,
          "1>财务报表!P139": 1430.2817510474442,
          "1>财务报表!P159": 0.5768770175261853,
          "1>财务报表!P181": -0.42712101667324764,
          "1>财务报表!P182": -0.14440703153564866,
        },
        critical: true,
        weight: 4,
      },
      {
        id: "q2-column-protection",
        description: "真实数据包除 1>财务报表 P 列外没有单元格值或公式变化",
        deliverableId: "workbook",
        kind: "xlsx_only_allowed_cells_changed",
        appliesTo: "real",
        referenceFixture: "history001/都森电子Q2_Datapack.xlsx",
        allowedSheet: "1>财务报表",
        allowedColumns: ["P"],
        minimum: 1,
        critical: true,
        weight: 4,
      },
      { id: "workbook-structure", description: "产物至少包含一个工作表", deliverableId: "workbook", kind: "xlsx_min_sheets", minimum: 1, critical: true },
    ],
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
    taskContract: workbookContract("financial_consolidation"),
    artifactAssertions: [
      { id: "eliminations", description: "包含两组现金流金额和抵消说明", deliverableId: "workbook", kind: "contains_all", values: ["381122.95", "3925000", "抵消"], realValues: ["3811229.5", "39250000", "抵消"], critical: true, weight: 3 },
      { id: "consolidation-trace", description: "包含长投、内部往来或补充分录推导", deliverableId: "workbook", kind: "contains_any", values: ["长期股权投资", "内部往来", "补充分录", "调整分录"], critical: true },
      { id: "consolidation-sheets", description: "合并底稿至少包含四个工作表", deliverableId: "workbook", kind: "xlsx_min_sheets", minimum: 4, critical: true },
      {
        id: "consolidation-golden-cells",
        description: "真实合并报表与 Codex 参考产物的配平、利润和现金流关键单元格一致",
        deliverableId: "workbook",
        kind: "xlsx_cells_equal",
        appliesTo: "real",
        realCells: {
          "资产负债表!C59": 133213633.47,
          "资产负债表!H59": 133213633.47,
          "利润表!C42": -17422900.91,
          "现金流量表!C60": 16402865.54,
          "现金流量表!C61": 1896577.01,
          "现金流量表!C62": 18299442.55,
          "TB表!N25": 96034826.92,
          "TB表!N34": 444189.83,
          "TB表!N92": 0,
          "TB表!N168": 3012718.26,
        },
        critical: true,
        weight: 5,
      },
    ],
    judgeRubric: "四类抵消均覆盖，借贷方向和金额正确；区分列报抵消与合并净额；说明来源、勾稽和待复核项。",
  },
  {
    id: "HISTORY-003",
    sourceSessionId: "019e4850-1c1d-7f40-b7c1-ffd0e5d1739e",
    title: "个人所得税计算与公式",
    realInput: "根据个人所得税税率表和 Excel 数据，把表中的个税算出来，并在表中列出计算公式。已确认口径：C 列税前工资和 F 列个人社保公积金均为月度数，G 列专项附加扣除为全年数；全年应纳税所得额=C×12-F×12-G-60000，H 列填 MAX(全年应纳税所得额×税率-速算扣除数,0)/12 的月度个税，并在右侧列出全年应纳税所得额、税率、速算扣除数、全年个税和可见公式说明。源表 A:G 是只读输入，禁止修改、清空、重排或把结果写回 G 列；只能在 H:M 写结果。请在工作簿中保留完整综合所得税率依据表：3%、10%、20%、25%、30%、35%、45%及对应速算扣除数（含 181920），不要只把税率和速算扣除硬编码在结果行。",
    fixtureFiles: ["个税/微信图片_20260521101029_8856_16.png", "个税/新建 XLSX 工作表.backup-20260521-个税写入前.xlsx"],
    input: "请按综合所得年度税率表计算三名员工的月度个税，并在结果中列出可复核公式。合成数据：A 税前月薪 22000、个人社保公积金 2500、专项附加扣除 2000；B 为 18500、1900、1000；C 为 14500、1500、1500。口径：全年应纳税所得额=月薪×12-个人扣除×12-专项附加-60000，月度个税=MAX(全年应纳税所得额×税率-速算扣除数,0)/12。",
    historicalToolCalls: 34,
    taskContract: workbookContract("generic", {
      needsRecalc: true,
      needsRender: true,
    }),
    artifactAssertions: [
      { id: "tax-columns", description: "包含税基、税率、速算扣除和月度个税", deliverableId: "workbook", kind: "contains_all", values: ["全年应纳税所得额", "适用税率", "速算扣除", "月度个税"], realValues: ["全年应纳税所得额", "适用税率", "速算扣除"], critical: true, weight: 2 },
      { id: "tax-formulas", description: "至少三个人员结果使用可复核公式", deliverableId: "workbook", kind: "xlsx_min_formulas", minimum: 3, critical: true, weight: 2 },
      {
        id: "tax-real-values",
        description: "真实附件按冻结年度扣除口径算出关键人员月度个税",
        deliverableId: "workbook",
        kind: "xlsx_cells_equal",
        appliesTo: "real",
        realCells: {
          "Sheet1!H5": 940,
          "Sheet1!H10": 140,
          "Sheet1!H18": 340,
        },
        critical: true,
        weight: 3,
      },
      {
        id: "tax-source-preservation",
        description: "真实附件只允许在结果列 H:M 写入，原始 189 行与 A:G 数据不得丢失或改写",
        deliverableId: "workbook",
        kind: "xlsx_only_allowed_cells_changed",
        appliesTo: "real",
        referenceFixture: "个税/新建 XLSX 工作表.backup-20260521-个税写入前.xlsx",
        allowedSheet: "Sheet1",
        allowedColumns: ["H", "I", "J", "K", "L", "M"],
        minimum: 1,
        critical: true,
        weight: 4,
      },
      {
        id: "tax-bracket-table",
        description: "工作簿保留完整综合所得税率档和速算扣除依据",
        deliverableId: "workbook",
        kind: "contains_all",
        appliesTo: "real",
        realValues: ["3%", "10%", "20%", "25%", "30%", "35%", "45%", "181920"],
        critical: true,
        weight: 2,
      },
    ],
    judgeRubric: "逐人给出税率档位、速算扣除数、全年应纳税所得额和月度个税；真实附件 G 列是全年专项附加扣除，口径必须为月薪×12-月社保公积金×12-G列-60000，不能把 G 列先按月扣除再乘 12；结果可在 Excel 中复核。",
  },
  {
    id: "HISTORY-004",
    sourceSessionId: "019e76f5-2151-7322-9da2-3ba9e5b2858f",
    title: "费用限额公式",
    realInput: "根据文件通知，把需做表格的事务费、工资费、管理费的限额公式列示出来。把公式写到 Excel 里，用户填 B 列金额后可以自动计算限额；补充制度中遗漏的科目，并确保 WPS 能看到公式。",
    fixtureFiles: ["dusen20260530/文件通知.pdf", "dusen20260530/需做表格.xlsx"],
    input: "根据以下已读取的制度规则，设计一个 Excel 公式方案：用户只填写 B 列金额，就能自动计算所有限额；覆盖事务费、工资费、管理费和固定资产折旧费，公式必须是真正可计算的 Excel 公式，而不是中文说明，并兼容常见办公软件。合成规则：事务费限额=收入×1%，工资费限额=收入×20%，管理费限额=收入×10%，折旧费限额=固定资产原值×5%。请同时说明各公式的依据。",
    historicalToolCalls: 44,
    taskContract: workbookContract(),
    artifactAssertions: [
      {
        id: "fee-items",
        description: "包含事务费、工资及劳务费、管理费和折旧费",
        deliverableId: "workbook",
        kind: "contains_all",
        values: ["事务费", "工资费", "管理费", "折旧"],
        realValues: ["事务费", "工资", "管理费", "折旧"],
        critical: true,
        weight: 2,
      },
      { id: "fee-formulas", description: "限额为真正 Excel 公式", deliverableId: "workbook", kind: "xlsx_min_formulas", minimum: 4, critical: true, weight: 2 },
      {
        id: "fee-golden-formulas",
        description: "真实附件的事务费分档、管理费及工资费公式与历史确认口径一致",
        deliverableId: "workbook",
        kind: "xlsx_formulas_equal",
        appliesTo: "real",
        realFormulas: {
          "Sheet1!C7": '=IF(COUNTA($B$3:$B$5)=0,"",SUMPRODUCT((($B$3+$B$4+0.5*$B$5)>超额累退比例表!$F$2:$F$9)*(IF(($B$3+$B$4+0.5*$B$5)<超额累退比例表!$G$2:$G$9,($B$3+$B$4+0.5*$B$5),超额累退比例表!$G$2:$G$9)-超额累退比例表!$F$2:$F$9),超额累退比例表!$H$2:$H$9))',
          "Sheet1!D7": '=IF(COUNTA($B$3:$B$5)=0,"",SUMPRODUCT((($B$3+$B$4+0.5*$B$5)>超额累退比例表!$F$2:$F$9)*(IF(($B$3+$B$4+0.5*$B$5)<超额累退比例表!$G$2:$G$9,($B$3+$B$4+0.5*$B$5),超额累退比例表!$G$2:$G$9)-超额累退比例表!$F$2:$F$9),超额累退比例表!$I$2:$I$9))',
          "Sheet1!C10": '=IF(OR(参数输入!$F$2="",参数输入!$F$2>=0.95),"需按研究类测算",IFERROR((SUM($B$3:$B$9)-$B$10)*1.05*参数输入!$F$2/(1-1.05*参数输入!$F$2),""))',
          "Sheet1!D10": '=IF(OR(参数输入!$F$2="",参数输入!$F$2>=0.95),"需按研究类测算",IFERROR((SUM($B$3:$B$9)-$B$10)*1.05*参数输入!$F$2/(1-1.05*参数输入!$F$2),""))',
          "Sheet1!E10": "=参数输入!$F$4",
        },
        critical: true,
        weight: 5,
      },
    ],
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
    taskContract: documentContract(),
    artifactAssertions: [
      { id: "reply-topics", description: "正式回复覆盖经营、研发、现金和待确认事项", deliverableId: "document", kind: "contains_all", values: ["经营", "研发", "现金", "确认"], critical: true, weight: 3 },
      { id: "reply-facts", description: "合成回复引用关键数据", deliverableId: "document", kind: "contains_all", values: ["520", "300", "120", "80"], realValues: ["2026", "研发"], critical: true, weight: 2 },
      {
        id: "reply-real-frozen-facts",
        description: "真实回复覆盖历史会话确认的融资、南昌进度及全年预测口径",
        deliverableId: "document",
        kind: "contains_all",
        appliesTo: "real",
        values: ["4,857.14", "34,857.14", "60%", "13,943.64", "2,066.39", "2,066.77"],
        critical: true,
        weight: 4,
      },
      { id: "reply-length", description: "文档具备可发送的完整正文", deliverableId: "document", kind: "docx_min_chars", minimum: 300, critical: true },
    ],
    judgeRubric: "先完成数据问答，再输出语气正式、可直接发送的回复；结论有数据依据，未知事项明确标注。若同一指标出现互相冲突的数值却未解释、时间线把 Q1 之后事项写成 Q1 事实、占比超过 100% 却未澄清分母，或编造来源表无法支持的精确数字，均属于 blocking。",
  },
  {
    id: "HISTORY-006",
    sourceSessionId: "019d666a-7c74-75c3-87bc-a4a2a43abdff",
    title: "多 Sheet 财务报表分析",
    realInput: "文件夹下有母公司和全资子公司的第一季度财务报表、科目余额表和合并模板。请生成新的合并报表，列示内部抵消分录，并展示每个合并数的来源和推导过程；不要修改原始文件。三张主表都要完整：合并资产负债表期初数取母公司期初、子公司因 2026 年 2 月成立期初为 0；利润表和现金流量表第二数值列为母公司本期累计数；现金流量表要列出期初/期末现金，并在补充分录与 cftb 中反映 2700 万和 1870 万内部借款现金流抵消，最终重新核对借贷、资产配平、现金流和公式。",
    fixtureFiles: ["dusen/合并模板.xlsx", "dusen/都森2026年第一季度科目余额表.xlsx", "dusen/都森（江西）第一季度科目余额表.xlsx", "dusen/都森第一季度财务报表.xlsx", "dusen/都森（江西）第一季度财务报表.xlsx"],
    input: "把下面视为已经读取的多 Sheet 财务工作簿摘要，分析资产负债表、利润表、现金流量表和科目余额表：资产 1000、负债 600、权益 400、收入 520、成本 300、期间费用 120、利润 100、期末现金 80，科目余额表借贷合计均为 1600。要求给出资产、负债、权益、收入、利润、现金和关键变动的结论，展示核心数字如何从各 Sheet 得到，并指出公式错误、勾稽不平或需要人工复核的项目。",
    historicalToolCalls: 101,
    taskContract: workbookContract("financial_consolidation"),
    artifactAssertions: [
      { id: "multi-sheet", description: "产物覆盖资产负债表、利润表和现金流", deliverableId: "workbook", kind: "contains_all", values: ["资产负债表", "利润表", "现金流"], critical: true, weight: 2 },
      { id: "traceability", description: "产物包含抵消、调整或来源说明", deliverableId: "workbook", kind: "contains_any", values: ["抵消", "调整分录", "补充分录", "合并说明"], critical: true },
      { id: "cashflow-repair", description: "真实产物覆盖历史确认的内部借款现金流和期初现金修复", deliverableId: "workbook", kind: "contains_all", values: ["18700000", "27000000", "期初现金"], appliesTo: "real", critical: true, weight: 3 },
      { id: "multi-sheet-count", description: "产物至少包含四个工作表", deliverableId: "workbook", kind: "xlsx_min_sheets", minimum: 4, critical: true },
      {
        id: "multi-sheet-golden-cells",
        description: "真实合并报表与 Codex 参考产物的内部借款抵消、配平、利润和现金流一致",
        deliverableId: "workbook",
        kind: "xlsx_cells_equal",
        appliesTo: "real",
        realCells: {
          "资产负债表!C59": 139155047.58,
          "资产负债表!H59": 139155047.58,
          "利润表!C42": -8556313.77,
          "现金流量表!C60": 26503027.07,
          "现金流量表!C61": 1896577.01,
          "现金流量表!C62": 28399604.08,
          "TB表!N34": 2734921.13,
          "TB表!N92": 0,
          "TB表!N168": 2683230.1,
        },
        critical: true,
        weight: 5,
      },
    ],
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
    taskContract: forecastContract(),
    artifactAssertions: [
      { id: "forecast-years", description: "工作簿覆盖 2026—2028", deliverableId: "workbook", kind: "contains_all", values: ["2026", "2027", "2028"], critical: true },
      { id: "forecast-metrics", description: "工作簿覆盖营收、研发和固定资产", deliverableId: "workbook", kind: "contains_all", values: ["营收", "研发", "固定资产"], critical: true, weight: 2 },
      { id: "forecast-formulas", description: "工作簿保留计算公式", deliverableId: "workbook", kind: "xlsx_min_formulas", minimum: 3, critical: true },
      { id: "forecast-document", description: "说明文档包含依据、假设和管理层确认事项", deliverableId: "document", kind: "contains_all", values: ["依据", "假设", "确认"], realValues: ["依据", "确认"], critical: true, weight: 2 },
    ],
    judgeRubric: "逐年给出三项预测，说明从母公司数据到子公司的分配/增长假设，区分已知数据和管理层待确认事项。生产线必须在集团年度营业收入实际达到 2 亿元后才能启动、启动次年建成；预测若在 2026/2027 未达门槛时写成已触发或已启动，属于 blocking，不能用“保守”解释规避协议字面条件。",
  },
];
