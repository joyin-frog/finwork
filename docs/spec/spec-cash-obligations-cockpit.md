# Spec: 合同收付 → 资金/合规日历 + 待办,总览重排

> 状态：待审阅
> 日期：2026-06-21
> 范围：把 P1 合同目录里"已确认"文档的收付/开票到期,派生成现金义务,喂进总览的财务日历(时间地图)与待办(紧迫切片),并按新优先级重排总览。纯确定性,无 LLM。

---

## 背景

P1 合同归纳刚落地:`knowledge_documents` 带 `metadata`(`DocMetadata`:`counterparty`/`amount`/`keyDates: KeyDate[]`/`recurrence`/`status`/`sourceFile`)+ `meta_status`(`none`/`draft`/`confirmed`)。当时把"提醒/资金日历"后置,只在目录里按到期日筛。

现总览(`app/cockpit/page.tsx`)整体围着薪税/报销转:
- **财务日历** `lib/domain/tax-calendar.ts`(纯函数):只有 报税期 / 算薪窗口 / 月末结账。
- **待办** `lib/domain/cockpit-todos.ts` `deriveCockpitTodos(calendar, payroll)`:申报前复核 / 算薪 / 结账 / 核对报销。
- MetricStrip / PayrollStatusCard 同。

新重点是 **合同收付(资金)+ 经营分析 + 税务筹划**。本功能把合同收付的"到期日 + 状态"接进日历与待办——即 P1 计划里"毕业到资金管理"那块——并重排总览。**载体不另起:数据源就是 P1 的 metadata。**

## 设计要点:同一份数据喂两个视图
- **财务日历 = 本月时间地图**(被动浏览):报税/算薪/结账 + 合同付款日/收款日/开票日 合并。
- **待办 = 紧迫可执行切片**(主动清单):只挑临近到期 + 状态待办(待付/待收/待开票)的。
两者派生自**同一份已确认合同 metadata**,跟现有 `日历 → deriveCockpitTodos → 待办` 管线同构。

## ① 确定性派生核心(红线 2/3)

新建 `lib/domain/cash-obligations.ts`(纯函数,好测):

```ts
export type CashObligation = {
  documentId: number;
  counterparty: string;        // metadata.counterparty,缺则"未填对方"
  kind: "付款" | "收款" | "开票";
  amount?: number;             // metadata.amount(元);缺则不显示金额、不编(红线4)
  dueDate: string;             // YYYY-MM-DD(来自 keyDate.date)
  status: string;              // metadata.status(待付/已付/待收/已收/待开票/已开票)
  recurrence?: DocMetadata["recurrence"];
  sourceDoc?: string;          // metadata.sourceFile / fileName
};

// 只吃 meta_status==='confirmed'(红线3:草稿不算);按 keyDate.kind 映射:
//   付款 → 付款义务 / 开票 → 开票义务 / 到期|收款 → 收款义务(签订、交付 不产生收付义务)
// dueDate 缺或非法 → 跳过该条(红线4,不编日期);amount 缺 → 义务保留但不显金额。
export function deriveCashObligations(
  docs: Array<{ id: number; fileName: string; metadata: DocMetadata | null; metaStatus: MetaStatus }>
): CashObligation[];

export function obligationsInMonth(obls: CashObligation[], year: number, month: number): CashObligation[]; // 日历用,按 dueDate 升序
export function urgentObligations(obls: CashObligation[], today: Date, withinDays: number, pending: Set<string>): CashObligation[]; // 待办用
```

`pending` 默认 `{"待付","待收","待开票"}`;`withinDays` 默认 14。

**DB 取数**:`lib/db/sqlite.ts` 复用 `listKnowledgeDocuments()`(行含 `metadata: string|null` / `meta_status`)在派生前 `JSON.parse` + 过滤 `meta_status==='confirmed' && metadata`;若性能需要再加 `listConfirmedMetadataDocs()` 专查。**绝不把客户实名等敏感原文带出本地——本功能全在 DB→服务端,不进模型上下文(红线 7)。**

## ② 财务日历集成

- `tax-calendar.ts` `getCalendarContext` **保持纯**(财政截止),不碰 DB。
- `FinanceCalendarCard` 入参加 `obligations?: CashObligation[]`(本月、`obligationsInMonth` 已排序)。渲染:把 报税/算薪/结账 节点与收付到期日**合并成一张本月时间地图**;收/付/开票分图标或色;每条带 `status`,已完成(已付/已收/已开票)弱化展示(红线 3)。
- 卡片标题语义从"财务日历"→"资金 + 合规日历"(文案可保留"财务日历",内容扩)。

## ③ 待办集成

- `deriveCockpitTodos(calendar, payroll, obligations?)` 扩参:把 `urgentObligations(...)` 追加为待办条目:
  - `label` 例:`12/31 付「金蝶服务费」5万 · 未付`;`hint`:`距 X 天`;`prompt`:`帮我把这笔标记已付` / `打开这份合同看付款条款`。
  - 与现有 todos 合并,**按截止日最近优先**排序,整体仍 ≤ N 条(现逻辑保留)。
- `CockpitTodo` 若需新字段(如 `kind`/`amount`/`documentId`)按需扩,保持向后兼容。

## ④ Summary API + 类型

- `app/api/cockpit/summary/route.ts`:读已确认 metadata 文档 → `deriveCashObligations` → ① 注入 `obligations`(供日历)② 传给 `deriveCockpitTodos`(供待办)。
- `app/cockpit/types.ts` `CockpitSummary` 加 `obligations: CashObligation[]`。

## ⑤ 总览重排(`app/cockpit/page.tsx`)

按"日常一眼看什么"重排,不删薪税/报销、只调权重:
- **头条**:`FinanceCalendarCard`(资金+合规)+ `TodosCard`(含收付紧迫项)置顶放大。
- **降级**:`PayrollStatusCard` 缩小/下移;MetricStrip 把收付相关(应收/应付/本月到期)提前,报销/薪税指标次要。
- **入口**:`QuickActionsCard` 增"生成本月经营分析"(P2)、"查可享税务优惠/政策"(P3);`BusinessMetricsCard` 保留趋势缩略。

## ⑥ 红线 + MVP

- **红线**:2 金额求和/筛选走确定性函数 · 3 只认 `confirmed`、每条带 status、草稿不入 · 4 缺 dueDate 跳过、缺 amount 不编 · 7 全本地 DB、敏感原文不外发 · 8 summary 读数沿用现有审计落点。
- **MVP**:派生核心 + 日历显示本月收付到期 + 待办紧迫项 + 总览重排。
- **后置**:提醒/系统通知推送、跨月现金流预测、给 agent 的 `query_cash_obligations` 工具(让对话里也能问"这月要付什么")、状态回写(待办里"标记已付"改 metadata.status)。
- **测试**:`tests/cash-obligations.test.ts`(派生 / kind 映射 / 本月筛 / 紧迫筛 / 缺字段不编 / 只认 confirmed / 金额求和)+ 扩 `cockpit-todos` 测试覆盖收付义务 + 扩 `cockpit-page` 测试断言新布局;挂进 `tests/all.test.ts`。
