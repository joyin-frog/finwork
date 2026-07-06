# 计算引擎独立化·第一刀（WP5a：政策规则表数据化 + as-of 查询）Spec

> 版本 v1.1 / 2026-07-06（v1.0 fix first → 修订 → 限定范围复审**批准**）
> 状态：**已实施并通过审查（ship）**。实施审查 fix first（1970 死区吸收、loadTaxRates 静默回落两处拒绝）→修复轮（覆盖真实生效区间+抛错对称，PR-B1/B2 红→绿）→限定复审 ship。
> 依赖：**硬性前置门（reviewer B3）：WP1a 必须已 ship 且全量测试绿，本 spec 才允许进入实施**——两个 implementer 并行追加 migrations.ts 条目会静默产生重复 version（runner 只按 version>current 过滤不校验唯一性）。orchestrator 调度层保证串行；implementer 开工第一步验证 MIGRATIONS 末尾已是 v7（fact_* 迁移），否则立即停止报告。本 spec 用 v8。
> 用户拍板（2026-07-06）：初始数据 = **内置个税表种子 + 社保表建结构留空**（用到时 agent 引导录入+人工确认）。
> 架构事实（2026-07-06 scout 摸底）：政策数字现状双源硬编码——`lib/domain/tax-config.ts:24-33`（DEFAULT_TAX_CONFIG：basicDeductionMonthly 5000 + 7 档税率/速算扣除）与 `agent-skills/skills/payroll-calc/scripts/payroll.py:20-33`（DEFAULT_CONFIG 镜像，仅兜底：生产由 TS `loadTaxConfig()` 读库后随 stdin 传入，脚本不自己查）。`TaxConfig` 已有 `version` + `effectiveYear` 字段但单配置无历史；运行期覆盖走 `app_settings` 键值（finance-store.ts:10-54，覆盖即丢旧值）。VAT/CIT 合法税率集在 `tax-config.ts:40-42`（DEFAULT_TAX_RATES），`loadTaxRates()` 校验后传入 tax_calc.py（税率本身由调用方给）。`payroll_records.tax_config_version` 记录计算时版本字符串（WP1a 后为 `fact_payroll.caliber_version`）。无任何 effective_from/to as-of 查询先例。测试先例：tests/tax-rates.test.ts、tests/payroll-script.test.ts（execFileSync 调 python selftest 断言 PASS）。

## 0. 目标与非目标

**目标**：政策规则从"代码常量+无历史覆盖"变成**带生效区间的版本化规则表**：新表 `policy_rule_sets`，as-of 查询（给定计算期间取当时生效版本），`loadTaxConfig()`/`loadTaxRates()` 改造为 as-of 读库（种子=现内置值），`caliber_version` 从此写真实规则版本。解决"明年政策一调全产品静默算错"与"补算历史月份用错新税率"两个结构性风险。

**非目标**：
- 不做社保基数的具体规则内容与录入 UI/工具（表结构天然支持 `rule_type='social_base'`，录入路径等有消费场景再做——用户拍板留空）；
- 不改 payroll.py 的计算算法与 stdin 契约（它本来就吃传入 config）；
- 不拆 finance_worker.py（WP5b）；不做规则编辑界面（对话录入+确认是后续功能）。

## 1. 成功标准

- [ ] v8 迁移建 `policy_rule_sets` 并落个税种子（payload=现 DEFAULT_TAX_CONFIG，effective_from='2019-01-01'，version 沿用现字符串）+ VAT/CIT 合法集种子；golden-schema.json 同步。先写红测试。
- [ ] `loadTaxConfig(asOf?)`：按期间 as-of 查询（`effective_from<=asOf AND (effective_to IS NULL OR effective_to>asOf)`）；无参默认今天；查无规则时**显式抛错**（绝不静默回退到可能过期的常量——DEFAULT 只作为 v8 种子存在，不再是运行时兜底）。测试覆盖：as-of 命中正确版本 / 两版本边界日 / 查无抛错。
- [ ] `calculate_payroll_batch` 按计算期间传 asOf 取当期规则，`caliber_version` 写入所取规则的 version；补算历史期间用历史版本的行为有专项测试（插入一条未来生效的假规则验证隔离）。
- [ ] `app_settings` 的旧覆盖键迁移语义明确：v8 把现存 `tax_config`/`tax_rates` 覆盖值（若有且解析合法）作为一条规则版本入库（source 'user_override'）；**解析失败的坏覆盖值：跳过吸收 + console.warn + 保留原 app_settings 行不删**（reviewer N5——不因坏覆盖回滚整个 v8，也不静默丢弃：原值留在原处可人工检视），audit 说明。此后覆盖机制改写为"插入新版本"，既有设置接口不 404。
- [ ] python 侧零改动：audit 以 `git status`/`git diff` 证明 payroll.py 与 tax_calc.py 未被触碰（reviewer N4——否决 hash 测试：会在未来合法修改时误报）。
- [ ] 全量 `FINANCE_AGENT_PYTHON_PATH=<主仓venv> FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 绿 + typecheck + lint。

## 2. 表结构

`policy_rule_sets`：`id PK · rule_type TEXT('iit_cumulative'/'vat_rates'/'cit_rates'/'social_base'/...) · version TEXT · effective_from TEXT NOT NULL · effective_to TEXT NULL · payload TEXT(JSON) · source TEXT('builtin_seed'/'user_override'/'user_dictated') · created_at`；唯一约束 (rule_type, version)；索引 (rule_type, effective_from)。同类型区间允许留白（历史无规则=查询抛错），**不允许重叠**——实现为**应用层校验：INSERT 前同事务 SELECT 重叠区间，命中即抛**（reviewer N2，否决 TRIGGER：隐性逻辑可测试性差）。

## 3. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v8 `policy_rule_sets`：建表 + 个税/VAT/CIT 种子 + 吸收 app_settings 现存覆盖 |
| `lib/db/rule-store.ts` | 新增 | as-of 查询 + 插入（含重叠校验）；loadTaxConfig/loadTaxRates 底层 |
| `lib/domain/tax-config.ts` | 修改 | loadTaxConfig(asOf) 走 rule-store；DEFAULT_* 降级为"仅供 v8 种子引用"的导出并注释声明 |
| `lib/db/finance-store.ts` 的导入链 | 修改 | DEFAULT_TAX_CONFIG 改为直接从 tax-config 导入，不再经 tax-cumulative 中转（reviewer N1，防误读运行期依赖） |
| `lib/db/finance-store.ts` | 修改 | 移除旧 app_settings 读取路径（10-54 行区域），改调 rule-store |
| `lib/agent/tools/finance/payroll.ts` | 修改 | calculate_payroll_batch 把已有的期间值（payroll.ts:94 一带的 `${year}-${month}` ）补足为 `-01` 日期传给 loadTaxConfig(asOf)（reviewer N3——现在 loadTaxConfig() 无参=今天，补算历史月会用错规则）；caliber_version 写规则 version |
| `lib/agent/mcp-tools/finance-tools.ts` | 说明 | **不改代码**（reviewer B1）：loadTaxRates 调用方（finance-tools.ts:104）行为依赖 v8 的 VAT/CIT 种子必然在库；"查无抛错"只会发生在种子被人为删除的异常态，该抛错冒泡为工具 isError 是正确行为。实施后 T4/T5 保持绿即为验证 |
| `tests/db-migration-discipline.test.ts` | 说明 | **不改代码**（reviewer B4）：T2 对照 golden fixture，golden 更新（加 policy_rule_sets）后此测试必须绿，属验证项 |
| `tests/tax-rates.test.ts` | 修改 | 按下方逐用例处置表执行（T1 改写 / T2、T3 删除并替代 / T4、T5 保留） |
| `tests/policy-rules.test.ts` | 新增 | §1 全部行为测试 + T2/T3 的替代测试 |
| `tests/fixtures/golden-schema.json` | 修改 | 新表入快照 |
| `tests/all.test.ts` | 修改 | 注册新测试 |

**tax-rates.test.ts 逐用例处置表（reviewer B2，实施必须照此执行）**：
- T1（无覆盖时返回默认集）→ **改写**：v8 种子在库时 `loadTaxRates()` 返回种子值（与 DEFAULT_TAX_RATES 相等，断言不变，语义从"常量兜底"变"种子命中"）；
- T2（setAppSetting 覆盖生效）→ **删除并替代**：新测试 = rule-store 插入一条 user_override 版本（生效日今天）后 as-of 取到覆盖值；
- T3（坏值按字段回落默认）→ **删除并替代**：新测试 = rule-store 写入非法 payload（如 vat:"坏值"）被**拒绝入库并抛错**（写入时校验取代读取时回落——"绝不静默用猜测值"红线的新落点）；
- T4/T5（tax_calculator 按集校验/合法计算）→ **保留不改断言**（工具行为不变，数据源换了而已）。
audit 附对照表逐条确认。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test && npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **与 WP1a 的迁移排序耦合**：v8 假设 v7 已存在（caliber_version 列在 fact_payroll 上）。若 WP1a 未 ship，本 spec 阻塞——roadmap 上标依赖。
- **"查无规则抛错"的用户体验**：算 2018 年工资会抛"无当期规则"——这是正确行为（用错规则更糟），报错文案要引导录入历史规则。
- 被否决：① 规则继续放 app_settings 键值（无历史、无区间，明年必翻车）；② 每类规则一张专表（结构爆炸，payload JSON + rule_type 枚举够用且可校验）；③ 运行时静默回退 DEFAULT（把"过期政策"藏进正常路径，违反红线 4）。
