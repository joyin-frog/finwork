# 申报前复核 filing-precheck（WP3）Spec

> 版本 v1.3 / 2026-07-06（v1.1 裁决 fix first → v1.2 修订 → 限定范围复审**批准**；复审附带的测试环境变量隔离要点已并入 §3 步骤 1）
> 状态：**已实施并通过审查（ship）**。实施审查裁决 ship：§6 全项落实、零硬编码政策数字、B 组全 run_python、零越界；implementer 的嵌入式测试块偏差被采纳（独立 IIFE 会被运行器静默吞错，嵌入才能让断言传播；env 时序经核实无残留）。
> 依赖：无硬依赖。WP1 事实库落地后数据源升级（见非目标）。
> 用户确认（2026-07-06）：实际场景为**一般纳税人月报**（增值税月报+附加税+个税扣缴月报）。14 项全部保留；B6（小规模免征判断）为条件项，仅当画像 taxpayerType 为小规模时启用——技能按 A1 推导的义务清单动态取用检查项，不写死场景。
> 架构事实：技能 = `agent-skills/skills/<name>/SKILL.md`（frontmatter: name/title/summary/requires/starter/category/description + 正文流程），`lib/agent/skills-store.ts` 的 `listSkills()` 自动扫描注册，内置技能恒启用；SDK 经 `getSkillSdkConfig()` 把 `agent-skills/` 作为 local plugin 传入，**主对话可用全部启用技能**。公司画像经 `readCompanyProfile()` 注入**主对话** system prompt C 段（`lib/agent/claude-adapter.ts:219`、`lib/agent/system-prompt.ts:130-143`）；**子代理的 system prompt 不注入画像**（`buildSubagentSystemPrompt` 只拼 `SUBAGENT_BASE_PROMPT + rolePrompt`，subagent-runner.ts:210），子代理也**没有与用户对话的通道**（subagent-runner.ts:33-35）——因此本技能 v1 **由主对话直接执行，不派发 tax-officer 子代理**。工具能力边界（reviewer 核实）：`tax_calculator`（finance-tools.ts:79-98）只做**正向计税**（单 amount 的 vat/cit 换算），**不能**拿申报表数字做倒验比对；`query_payroll_status` 返回 confirmed/drafts 分组，confirmed 行只有 `employeeName/netPay/taxCurrent`（payroll.ts:276-277），**没有应发（gross）字段**；`invoice_ledger` 表（schema.ts:298-305，仅 invoice_no/amount/invoice_date/category）**没有任何读工具**暴露给 agent。报税期快捷入口（tax-calendar.ts:111-117）现有 prompt 只覆盖个税工资确认，**本期不改其文案**。

## 0. 目标与非目标

**目标**：新增主对话技能 filing-precheck——报税期用户在对话里发起"申报前帮我复核一遍"，agent 按检查清单逐项核验，输出**按风险排序**的三态清单（✅通过 / ⚠️异常 / ❓无法核验-缺什么数据），异常项给出定位与建议动作。心智价值 > 省时价值。信任等级：**复核者**（人申报，agent 检查），绝不代提交。**执行方 = 主对话**（画像、问用户通道、全部工具三者俱备；见架构事实）。

**非目标（本期不做，已知并接受）**：
- **不挂进 tax-officer 的 `skills` 数组**——子代理拿不到画像也问不了用户（B1），挂上去只会产出"无法核验"清单。registry.ts 的"待建"注释更新为说明此决策；子代理画像注入机制落地后再另行挂载；
- **不改报税期快捷入口文案**（tax-calendar.ts:112 现有 prompt 只覆盖个税确认，与本技能并存不冲突；文案升级放 WP2 节奏引擎一并设计——预检结果本来就要进驾驶舱）；
- 不扩 `invoice_ledger` schema、不新增台账读工具（A4 的 DB 自动查询是 WP1 事实库落地后的升级项）；
- 不改税务日历结构（节假日顺延、季报/年报节点扩充）；
- 不接入驾驶舱 attention 面板（WP2）；
- 不计算权威应纳税额（只做勾稽复核，算术下沉 run_python）；
- 不做企业所得税季度预缴复核（数据可得性最差，缓做）。

## 1. 成功标准

- [ ] `listSkills()` 能发现 `filing-precheck` 且 frontmatter 解析正确。测试写法（N1 修正）：**不要**改 `tests/skills-store.test.ts` 既有的临时目录 fixture 用例（那里没有真实技能目录）；新增独立测试块，把 `listSkills` 指向真实 `agent-skills/skills/` 目录断言发现与解析。先红后绿。
- [ ] SKILL.md 正文实现 §6 清单编排：每项有数据来源指令、三态判定标准、输出格式（样板：rnd-deduction-check 分节表格）；按 A1 推导的义务清单动态取用检查项。
- [ ] **算术纪律**：B 组全部数值比较由 `run_python` 执行（Decimal、显式舍入、比较阈值写在代码里），SKILL.md 明文禁止心算勾稽；`tax_calculator` 不用于倒验（能力边界见架构事实）。
- [ ] 缺数据行为符合"宁可问人"：无上传文件 → B 组逐项"无法核验 + 需要什么文件"；画像缺 `taxpayerType` → 主对话直接问用户（有通道），不默认小规模。
- [ ] 政策数字零硬编码：SKILL.md 不写任何税率/免征额数值，勾稽税率一律取自用户文件本身；输出中政策相关项标"需核实当年当地政策"。
- [ ] B5 用 `query_payroll_status` 实际存在的字段（人数、`netPay` 实发合计、`taxCurrent`）做一致性对比，SKILL.md 明确说明**没有应发字段**、对比口径是实发+个税（N4 修正）。
- [ ] `lib/agent/roles/registry.ts` 仅更新 tax-officer 处注释（说明 v1 主对话执行的决策与原因），`skills`/`tools` 数组零改动——因此 `tests/role-registry.test.ts` 的 G3 守卫不受影响，无需改动。
- [ ] mock 模式验收技能可见；真实效果验收由用户带 key 跑一遍（脚本见 §4）。
- [ ] `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 全绿（skills-store.test.ts 已在 tests/all.test.ts 注册，无需动运行器）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `agent-skills/skills/filing-precheck/SKILL.md` | 新增 | 技能定义：frontmatter + §6 清单编排 + 输出格式 + 算术纪律 |
| `lib/agent/roles/registry.ts` | 修改 | 仅 tax-officer 处注释：`// 待建：filing-precheck` → 说明 v1 主对话执行、子代理画像注入落地后再挂载（数组零改动） |
| `tests/skills-store.test.ts` | 修改 | 新增独立测试块：真实 skills 目录发现 filing-precheck + frontmatter 解析 |

无新工具、无 schema 改动、无 UI 改动、无运行器改动。闭环切在"对话里拿到可执行的复核清单"。

## 3. 实施步骤

1. **先写红测试**：`tests/skills-store.test.ts` 追加独立块（真实目录 `listSkills` 含 filing-precheck、frontmatter name/title/summary/starter 非空）。此时技能目录不存在，红。**写法要点（复审 reviewer 确认）**：`listSkills` 不接受目录参数，路径来自 `getBundledPluginRoot()` 读 `FINANCE_AGENT_BUNDLED_PLUGIN_DIR`；新测试块必须在现有 fixture IIFE 的 `finally` 清理**之后**另起独立 IIFE，重新赋 `FINANCE_AGENT_BUNDLED_PLUGIN_DIR` 为真实 `agent-skills` 路径（并给 `FINANCE_AGENT_USER_PLUGIN_DIR`/`FINANCE_AGENT_SKILLS_STATE_PATH` 独立临时值），避免与 fixture 块的临时目录互串。
2. **写 SKILL.md**：frontmatter 参照 `agent-skills/skills/rnd-deduction-check/SKILL.md`（category 同类；starter 写报税期典型问法）。正文结构：
   - **第 0 步 前置采集**：从 system prompt C 段画像读 `taxpayerType`/`region`；缺失 → 直接问用户（选项式：一般纳税人/小规模），不猜；
   - **A 组**（全自动）：A1 义务清单推导；A2 截止日（读 tax-calendar 语境或按"每月 15 日、节假日顺延未推算"表述）；A3 `query_payroll_status`（上月）；A4 **改为**：若用户已上传开票汇总/台账导出文件则据此提示本期开票概况，否则输出"❓请自查发票台账登记（本产品台账自动核对待 WP1 后提供）"；
   - **B 组**（有上传文件才进）：从文件提取数字 → `run_python` 做比较（Decimal、四舍五入到分、B1 尾差阈值 1 元、B7 差异阈值 5%，全部写进代码注释）；B5 对比口径 = 人数 + 实发合计 + 个税合计；
   - **C 组**：攒一批一起问（给选项不给开放题）；
   - **输出**：rnd-deduction-check 风格分节表格，⚠️ 排最前、❓ 次之、✅ 收尾；末尾声明段（"本复核不构成申报依据…"沿用其措辞风格）。
3. **registry.ts 注释更新**（一处，数组不动）。
4. 跑测试转绿；mock 模式启动确认技能出现在技能目录。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test -- tests/skills-store.test.ts   # 若 test 脚本不支持过滤则全量
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test    # 全量
npm run typecheck && npm run lint
```

- 带 key 人工验收脚本：① 空画像+无文件发起复核 → 期望：先被问纳税人资格，然后 A 组产出、B 组逐项"无法核验+要什么文件"；② 补画像（一般纳税人）+确认上月工资+上传申报表草稿 → 期望：三态清单，B 组有 run_python 计算痕迹（工具调用可见），无任何心算勾稽。
- 不需要跑：e2e、golden eval（v2 增强项：golden 加一条 filing-precheck 场景）。

## 5. 风险与开放问题

- **主对话执行的上下文成本**：14 项编排 + 文件解析都在主对话进行，长对话里可能挤占上下文。接受：这正是"报税期专项对话"的用法（用户从快捷入口/新对话发起）；SKILL.md 开头注明建议在新对话中运行。
- 上传文件的脏格式决定 B 组胜率；解析失败降级"无法核验"，样本进 WP11 语料库。
- 被否决的备选：① 派发 tax-officer 子代理执行（子代理无画像注入、无问用户通道，reviewer B1 实锤；等画像注入机制落地）；② 用 `tax_calculator` 做勾稽倒验（它只能正向计税，reviewer B2 实锤；v1.1 的"已覆盖 VAT 勾稽所需"论据错误，撤回）；③ 新增 `query_invoice_ledger` 读工具支撑 A4（有价值但与 WP1 事实库读取层撞车，两次动同一数据面；v1 降级为看上传文件）；④ 本期改快捷入口文案（牵动现有个税查询行为，归 WP2 一并设计）；⑤ 做成驾驶舱页面按钮（违反"对话即任务"）。

> 计划审查记录：2026-07-06 reviewer 裁决 fix first。B1 子代理读不到画像且无问人通道（已修：v1 主对话执行，不挂角色 skills 数组）；B2 tax_calculator 做不了勾稽倒验（已修：B 组算术全部下沉 run_python，撤回错误论据）；B3 快捷入口内容与执行方未说清（已修：架构事实注明现有入口只覆盖个税、本期不改文案列非目标，执行方=主对话写进目标）；B4 invoice_ledger 无读工具（已修：A4 降级为看上传文件+提示自查，DB 自动查询归 WP1）；N1 测试扩展点说清（独立真实目录测试块，不动 fixture 用例）；N2 G3 守卫（已消解：不改 skills 数组）；N3 快捷入口文案遗漏（已列非目标）；N4 B5 无应发字段（已修：对比口径改实发+个税）；N5 被否决论据修正（已修）。

## 6. 检查清单（2026-07-06 用户已确认；主场景=一般纳税人月报，B6 为小规模条件项）

**A 组：义务与数据就绪（不依赖上传文件，全自动）**
| # | 检查项 | 数据源 | 异常判定 |
|---|--------|--------|---------|
| A1 | 纳税人资格与本期申报义务清单（一般纳税人：增值税月报+附加；小规模：按季申报判断本月是否申报月；个税扣缴月报） | 主对话画像（system prompt C 段） | 画像缺 taxpayerType → 问用户（选项式） |
| A2 | 申报截止日剩余天数 | tax-calendar 口径 | ≤3 天标 urgent；注明"15 日未做节假日顺延" |
| A3 | 上月薪资期间状态（个税申报数据源是否定版） | query_payroll_status | 存在 draft 未确认 → ⚠️（草稿数不能当申报依据，红线） |
| A4 | 本期开票/收票概况 | 用户上传的开票汇总/台账导出（可选） | 无文件 → ❓提示"请自查发票台账登记"（DB 自动核对待 WP1） |

**B 组：勾稽复算（需用户上传：增值税申报表草稿 / 开票汇总 / 勾选认证汇总；算术一律 run_python，缺哪个文件哪项标❓）**
| # | 检查项 | 复算方式 |
|---|--------|---------|
| B1 | 销项：销售额 × 适用税率（取自文件） ≈ 销项税额 | run_python Decimal 比较，尾差>1 元标⚠️ |
| B2 | 进项：申报抵扣额 ≤ 勾选认证可抵扣额 | run_python 比较 |
| B3 | 应纳税额 = 销项 − 进项 − 上期留抵（勾稽链，各数取自文件） | run_python 复算 |
| B4 | 附加税税基 = 实缴增值税额；城建/教育/地方教育按文件税率（标注"需核实当地税率"） | run_python 乘法复算 |
| B5 | 个税申报人数、实发合计、个税合计 vs 已确认工资期间（无应发字段，口径=实发+税额） | query_payroll_status 对比 |
| B6 | （条件项：仅小规模）季销售额 vs 免征额（标注"需核实当年政策"） | run_python 比较，临界±10% 标⚠️ |
| B7 | 开票汇总合计 vs 台账/申报表口径差异 | run_python，差异>5% 标❓请人工核对 |

**C 组：遗漏风险提示（攒一批一起问，给选项）**
| # | 检查项 |
|---|--------|
| C1 | 本期有无新签合同/租赁——印花税申报是否需要（标注"需核实税目税率"） |
| C2 | 上期申报有无留抵、更正、缓缴等未结事项 |
| C3 | 全部税率/免征额引用处统一声明"以当年当地政策为准" |

---

## 附录：audit 要求

按 `docs/spec/TEMPLATE.md` 附录执行；因本任务主体是 prompt 资产，audit 额外附一段"SKILL.md 编排逻辑与 §6 清单的逐项对照表"。
