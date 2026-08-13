# Design：多 sheet 财务 xlsx 处理能力盘点与补齐

> 状态：G1–G4 已实现并接入生产工具目录（2026-08-12）
>
> 前置：[`CONTEXT.md`](../../CONTEXT.md)（两档模型、六条不变量）
>
> 性质：能力现状、实现边界与验收证据。生产发布仍受真实 Office、真实模型和真实业务样本门约束。

---

## 1. 现状盘点

判定口径：✅ 有且通用；🟡 有但只覆盖特定场景；❌ 没有。
**只记录逐条核实过的结论，不含推测。**

### 1.1 分析

| 能力 | 状态 | 实际是什么 |
| --- | --- | --- |
| 读多 sheet、识别表头 | ✅ | `spreadsheetInspect` 返回 sheets / headers / sample_rows / columns |
| 识别期间、科目、金额区块 | 🟡 | 仅三大报表（`parse_statements.py` 按行次取数，兼容列位漂移）；任意表无 |
| 汇总 | 🟡 | `analyze_tabular` 仅 count/sum/avg/min/max + groupBy，且需先把数据变成结构化行 |
| 对账 | 🟡 | 仅银行对账（`bank-recon-batch`） |
| 勾稽检查 | ✅ | `check_workbook_ties`：声明式左右值、容差和确定性结果；含资产=负债+权益模板 |
| 同比 / 环比 | ✅ | `financial-ratios` + business-analysis 三基准列 |
| 结构分析 | 🟡 | 仅四能力那套 |
| 公式错误扫描 | ✅ | `inspect` 全量扫 `#REF!/#DIV/0!` 等 |
| 异常值 / 缺失值 / 重复项 | ✅ | `detect_data_issues`：重复键、必填缺失、IQR 离群值和非负约束 |
| 跨表不一致 | ✅ | `check_workbook_ties` 可读取跨 sheet 单元格并输出逐项差异 |
| 输出问题清单 | 🟡 | `emit_checklist` 在，内容靠模型 |

### 1.2 编辑

| 能力 | 状态 | |
| --- | --- | --- |
| 修改现有 xlsx | ✅ | `patch_workbook`，XML 层无损，保样式 / 公式 / 缓存 |
| 新增 sheet | ✅ | `patch_workbook` 的 `createSheet` 显式创建；未声明时仍拒绝拼写错误 |
| 新增辅助列 / 校验列 | ✅ | 即写单元格 |
| 写入公式 | ✅ | 并由 `formulas` 引擎自动补算缓存值 |
| 批量清洗 / 统一格式 / 重命名列 | ❌ | 无 |
| 拆分 / 合并表 | 🟡 | `merge_labeled_tables` 支持按标签合并多个来源并生成来源列与合计；不含抵消和任意拆表 |

### 1.3 财务场景

| 能力 | 状态 | |
| --- | --- | --- |
| 三大报表解析 | ✅ | 会小企 / 金蝶导出格式 |
| 科目余额表 | 🟡 | 有 fixture，无专用解析器 |
| 凭证汇总 | ✅ | 金蝶路径最成熟（11 个领域工具） |
| 科目映射 | ✅ | `resolveAccount`：关键词 → 科目码，对照表驱动 |
| 费用台账 / 收入成本分析 | 🟡 | 局部；T3 下钻仍待建 |
| 多公司 / 多期间合并 | 🟡 | 通用标签合并底座已提供；合并抵消仍属于 Case/业务规则层，不由通用工具猜测 |
| 报表交叉核对 | ✅ | 声明式勾稽能力已接入生产目录；具体口径由 TaskContract/规则提供 |

### 1.4 结构与保真

| | 状态 | |
| --- | --- | --- |
| 保留原表结构与样式 | ✅ | `patch_workbook` 的核心保证 |
| 合并单元格 | ✅ | inspect 报 `merged_ranges`，patch 保留 |
| 筛选 / 冻结窗格 | ✅ | inspect 报 `auto_filter` / `frozen_panes`，patch 保留 |
| 复杂公式 | 🟡 | 引擎覆盖常用函数；`IFERROR` + 外部链接算不出 |
| 外部链接 | 🟡 | 能识别、缓存能保住，但本机算不出 |
| 数值精度 | 🟡 | `money.ts` 分单位；引擎回浮点 |
| 多 sheet 引用关系 | ❌ | 无依赖图；patch 只给直接引用的下游清单，不做传递闭包 |
| 隐藏行列 | ❌ | 不感知 |
| 日期格式 | ❌ | 未处理 |
| 数据透视缓存 | ❌ | 未处理 |
| 宏 `.xlsm` | ❌ | 合同明确 `needsMacroPreservation: false` |

### 1.5 形状判断

```
两口深井：三大报表分析 ✅   凭证 / 金蝶 ✅
一层地基：无损编辑 ✅（2026-08-05 建）
中间的通用面：很薄
```

当前通用底座已经覆盖“安全创建、无损修改、声明式核对、标签合并、确定性数据质量检查”。它仍不把复杂财务口径交给启发式猜测：合并抵消、任意表头理解和高保真 Office 重算必须由 Case、规则与外部依赖明确提供。

---

## 2. 已实现能力（四项）

四项均满足：确定性实现、schema/权限/证据/资源策略、生产工具目录注册和单测守护。

### G1 新增 sheet

`patch_workbook` 的 edit schema 保留 `createSheet`，Spreadsheet Runtime 只在显式声明时创建工作表，并拒绝未声明的新 sheet，避免把拼写错误变成静默创建。创建路径写入 sheet XML、关系和内容类型，并经过回读测试。

### G2 跨表勾稽

`check_workbook_ties` 接收左右引用、容差和标签，批量读取真实 workbook 单元格并逐项输出 pass/difference；规则由 TaskContract、用户或规则库声明，引擎不猜口径。

### G3 多表合并汇总

`merge_labeled_tables` 按标签对齐多个来源的结构化表，输出一行一标签、来源列和合计，并显式返回重复标签等诊断。**不含抵消**：抵消属于 Case/业务规则层，禁止塞进通用工具做隐式判断。

### G4 异常 / 重复 / 缺失检测

`detect_data_issues` 对结构化行执行重复键、必填缺失、IQR 离群值和非负约束检查，返回机器可判定的问题清单，不做不可解释的“智能判断”。

### 2.5 生产接线

- 工具工厂：`lib/agent/mcp-tools/index.ts` 的 `createFinanceWorkerTools`。
- 安全创建：`lib/agent/mcp-tools/create-workbook.ts`。
- 无损修改：`lib/agent/mcp-tools/patch-workbook.ts` 与 `lib/runtime/spreadsheet-runtime.ts`。
- 勾稽、异常和合并：`lib/agent/mcp-tools/workbook-checks.ts`。
- Capability SSOT：上述工具通过 Finance Capability Runtime 注册，未注册或依赖缺失时返回结构化阻断，不走 Bash/Python 兜底。

---

## 3. 明确不做

- 宏 / VBA 保留
- 数据透视缓存重建
- 样式美化
- 合并报表的抵消逻辑（属任务类型，不属通用能力）
- 任意表的「智能」表头识别（靠猜的结构识别不进交付档）

---

## 4. 验收

### 4.1 本地确定性门

统一入口：

```bash
npm run test:xlsx-capabilities
```

覆盖：

- G1：显式新增 sheet 成功，未声明时拒绝；工具 schema 不丢失 `createSheet`。
- G2：容差内通过、超差失败、缺失单元格结构化失败。
- G3：多来源标签对齐、合计和重复标签诊断。
- G4：重复、缺失、IQR 离群和符号异常。
- 新建 workbook 的路径边界、公式安全、原子写入和不可覆盖。
- patch 的样式/公式/关系保留和输入值强类型处理。

2026-08-12 本地结果：上述入口全部通过。

### 4.2 生产发布门

本地测试通过不等于真实交付完成。发布前必须：

1. 用 HISTORY-001、HISTORY-002 和真实多 sheet 财务样本运行真实模型；
2. 用真实 Office/LibreOffice 重算并检查公式缓存、结构 diff 和业务断言；
3. 将每条正式结论和交付文件绑定到 Artifact hash 与 CompletionEvidence；
4. 对比交付率、断言通过数、Bash 调用占比、声明式 workbook 工具使用率；
5. 任一关键用例失败都不得用汇总分数或 legacy fallback 豁免。
