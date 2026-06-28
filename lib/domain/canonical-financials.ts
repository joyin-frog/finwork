/**
 * 会小企财报三表的 canonical 科目类型(经营分析引擎/工具的统一口径)。
 *
 * 历史:这些类型原属 `kuaixiaoqi-parser.ts`(TS 行次解析器)。该解析器从未真正进入 agent
 * 路径(agent 跑不了 TS lib 函数),已退役——确定性三表解析改由 business-analysis skill 的
 * 固定脚本完成:`agent-skills/skills/business-analysis/scripts/parse_statements.py`(探测列位、
 * 按行次/科目名取数、跳过 T3 客户实名 sheet;自测见 tests/business-analysis-script.test.ts)。
 * 本文件只保留 canonical 类型,供 business-analysis 引擎与 generate_business_analysis 工具复用。
 */

/** 单位枚举 */
export type FinancialUnit = "元" | "万元";

/** 资产负债表(简版,含所需行次科目) */
export type CanonicalBalanceSheet = {
  // 资产
  cash: number;                  // 货币资金 行1
  receivables: number;           // 应收账款 行4
  inventory: number;             // 存货 行9
  currentAssets: number;         // 流动资产合计 行15
  totalAssets: number;           // 资产合计
  // 负债
  shortTermBorrowing: number;    // 短期借款 行31
  payables: number;              // 应付账款 行33
  currentLiabilities: number;    // 流动负债合计 行41
  totalLiabilities: number;      // 负债合计
  // 净资产
  equity: number;                // 净资产合计
  // 期初对应字段(用于算平均值)
  prior?: {
    cash: number;
    receivables: number;
    inventory: number;
    currentAssets: number;
    totalAssets: number;
    currentLiabilities: number;
    totalLiabilities: number;
    equity: number;
  };
};

/** 利润表(含本期+上年同期) */
export type CanonicalIncomeStatement = {
  revenue: number;               // 营业收入 行1
  cost: number;                  // 营业成本 行2
  sellingExpense: number;        // 销售费用 行11
  adminExpense: number;          // 管理费用 行14
  rdExpense: number;             // 研发费用 行17
  financeExpense: number;        // 财务费用 行18
  netProfit: number;             // 净利润 行32
  /** 上年同期(损益表内置) */
  prior?: {
    revenue: number;
    cost: number;
    sellingExpense: number;
    adminExpense: number;
    rdExpense: number;
    financeExpense: number;
    netProfit: number;
  };
};

/** 现金流量表(简版) */
export type CanonicalCashFlow = {
  operatingCashFlow: number;     // 经营活动产生的现金流量净额
  investingCashFlow: number;     // 投资活动产生的现金流量净额
  financingCashFlow: number;     // 筹资活动产生的现金流量净额
  netCashIncrease: number;       // 现金及等价物净增加
};

/** 三表 + 元信息(脚本解析输出的 canonical 形状) */
export type CanonicalFinancials = {
  balanceSheet: CanonicalBalanceSheet;
  incomeStatement: CanonicalIncomeStatement;
  cashFlow?: CanonicalCashFlow;
  asOf: string;       // 数据截止日,如"2025-12-31"
  unit: FinancialUnit;// 报表申报单位("元"/"万元")
  footnotes: string[];
};
