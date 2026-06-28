// 匿名「功能触达」埋点白名单(红线 7):只发**事件名 + 计数**,绝不带金额/ID/名称/文件名/内容/自由文本。
// 新增埋点点 = 在这里加一个名字;recordFeatureEvent(本地)与前端 trackFeature 都只接受白名单内的名字,
// 白名单外一律丢弃——这样事件名本身永远不可能夹带 PII。
export const FEATURE_EVENT_NAMES = [
  // 主区导航(用户在用哪块)
  "nav.cockpit",
  "nav.chat",
  "nav.knowledge",
  "nav.config",
  // 主功能触达(快捷操作/功能页打开)
  "feature.business_analysis.open",
  "feature.tax_planning.open",
  "feature.reimbursement.open",
  "feature.payroll.open",
  "feature.kingdee.open",
  "feature.contract.open",
  "feature.finance_analysis.open",
  // 卡点信号(看哪儿是空态/没数据)
  "friction.empty_business_data",
] as const;

export type FeatureEventName = (typeof FEATURE_EVENT_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set(FEATURE_EVENT_NAMES);

export function isFeatureEventName(x: unknown): x is FeatureEventName {
  return typeof x === "string" && NAME_SET.has(x);
}
