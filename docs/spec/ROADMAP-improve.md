# ROADMAP-improve：全面改造总纲

> **本文件是跨会话的进度账本。** 每个会话开工先读它，收工前更新状态表。
> 设计决策与被否决的备选方案写进各 spec；本文件只管全局：工作包、依赖、状态、批次。
> 创建：2026-07-06。来源：全领域改造评审（finance-product-advisor 模式 A）+ 用户拍板。

## 总判断

最大的升维机会不在加功能，而在把数据底座从"对话的副产品"改造成"公司财务事实的唯一居所"。
每月的发票、工资、凭证、流水沉淀成带信任标签（结算状态/口径版本/合规标记/精度规格）的
结构化事实后，产品从"好用的 AI 工具"变成"离开它就丢掉公司账务记忆"的东西。

## 已拍板决策（2026-07-06，用户确认）

| # | 决策 | 内容 |
|---|------|------|
| D1 | 执行方式 | 多份 spec 分批走流水线，绝不梭哈。切分标准：一个 spec 的 diff 必须能一次审完 |
| D2 | TDD 铁律 | 每份 spec 成功标准必须列测试清单；implementer 先写失败测试亲眼看红再实现；audit 报告测试先行证据；reviewer 审查此项 |
| D3 | 事实库策略 | **一步到位迁移**（用户明确选择，否决了渐进并存）：设计终态 schema，现有表数据搬进事实层，旧表退役。风险缓解：迁移框架先行 + 迁移前强制备份 + dry-run + 回滚路径为硬性验收标准 |
| D4 | 预检触发 | 打开驾驶舱/到达日历节点时触发，跑前显示预计消耗可跳过。不做后台常驻定时（额度不可控），不做纯手动（体验断裂） |
| D5 | UI 首选风格 | 保持现风格，底座只做解耦（token 收敛 + surface 原语）。风格切换后置，另起 spec |
| D6 | 第一批开工 | 迁移框架 + UI 底座 + 申报前复核，三线并行 |
| D7 | 断点续传 | 本文件为进度唯一真相；spec 自包含（含被否决方案及原因）；audit 记录实际改动；关键取舍冗余写入持久记忆 |

## 工作包清单

状态取值：`未开始` → `spec已写` → `计划已批` → `实施中` → `已ship`。

### T0 结构性

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| WP1 | 财务事实库 | 统一事实层 schema（四信任标签内建）+ 一步到位迁移现有表（D3）。拆三刀：WP1a schema+迁移+store门面切换 / WP1b 义务落盘消费切换 / WP1c invoice 新字段写入端。摸底关键事实：金额全 REAL 需转分整数；finance-store.ts 是唯一门面（调用方零改动的杠杆）；义务无表、方向靠解析状态文本 | WP6 | **WP1 三刀全部已ship**（WP1a schema+迁移 / WP1b 义务落盘 / WP1c 发票写入端——事实库工作包收官） |
| WP2 | 节奏引擎 | 摸底后收窄为 WP2a：确定性预检=attention 新规则（零消耗直跑）+ LLM 预检=跳转对话入口（点=跑不点=跳过），不造消耗预估机器（D4 重解释见 spec） | WP3/WP1a（已ship） | **WP2a 已ship**（R6/R7/R8 三规则+双调用方；实施审查零阻塞） |
| WP3 | 申报前复核 filing-precheck | 税务专员旗舰场景：申报前检查清单跑一遍，三态输出（通过/异常/无法核验）。v1 勾稽靠用户上传文件（台账字段不足，扩展归 WP1） | 无硬依赖（WP1 落地后切事实层） | **已ship**（spec v1.3；实施审查 ship，嵌入式测试块偏差被采纳；带 key 人工验收脚本见 spec §4，留给用户报税期实测） |

### T1 信任基础设施

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| WP4 | 可追溯性泛化 | 摸底修正：CalcReceipt/通用卡片/兜底分发已在。拆 WP4a（kind 判别契约+四生成方 source 补链）/ WP4b（voucher与分析接入+provenance 落库 v9） | 无 | **WP4a 已ship**（kind 契约+三处 source 补链+对账文件名全链路） |
| WP5 | 计算引擎独立化 | 拆两刀：WP5a 规则表数据化（个税表内置种子+社保表建空结构，用户 2026-07-06 拍板）/ WP5b worker 拆包。摸底：政策数字双源硬编码（payroll.py:20-33 与 tax-config.ts:24-33 镜像）、金额全 float、无 as-of 查询先例 | WP1a（迁移版本排序 v8>v7） | **WP5a 已ship**；**WP5b 评估后收窄不拆（2026-07-07）**——751 行域边界自然无真实痛点，拆包需改 7 处 Node 路径引用+入口方式且踩 Windows 打包盲区，值不回票价；已落轻整理（7 条域分段注释），某域超 300 行再议 |
| WP6 | 迁移纪律收口 | **摸底修正（2026-07-06）：版本化迁移框架已存在**（user_version v1-5、事务回滚、迁移前备份）。真正的债：baseline 每次启动无条件重跑，`CREATE TABLE IF NOT EXISTS` 会复活未来被迁移删除的表（WP1 旧表退役的直接地雷）+ 双轨制无护栏。范围收窄为：baseline 冻结、v6 reconcile、删表不复活测试、rehearseMigrations 预演。**仍是 WP1 硬前置** | 无 | **已ship**（spec v1.2；实施审查 fix-first 唯一阻塞已修，全量 11 组测试绿；未提交，随第一批一起 commit） |
| WP7 | Windows 运行时防线 | 摸底修正：windows_smoke CI/打包硬校验/GBK 防线大半已在。收窄为 WP7a：编码防线统一 12+ 调用点（parsers 两处是现实漏洞）+守护 CI 守护者+tar 兜底 | 无 | **WP7a 已ship**（12 调用点统一 pythonSpawnEnv；CI 守护者有人守了；tar 兜底） |

### T2 工程速度

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| WP8 | UI 底座 | **摸底修正（2026-07-06）：token 层已相当完善**（oklch/@theme/单旋钮 radius/elevation 三档/tone 14 色/next-themes）。真正的债是散落：rounded-\* 141 处 47 文件、border 73 处 33 文件。拆为 WP8a（Surface 原语+ESLint 护栏+data-style 挂载点+3 试点）与 WP8b+（按 spec 附录 A 清单分批收敛）。视觉保持现状（D5） | 无 | **WP8a 已ship**（spec v1.1；实施审查 fix first→修复轮（补 3 条变体断言、护栏测试改读真实 eslint 配置并红态自证）→重审 ship。WP8b+ 收敛批次照 spec 附录 A 排期） |
| WP9 | chat-page 拆解 | 拆两刀：WP9a 纯结构搬迁（私有组件+hooks 平移，行为零变化，≤500 行）/ WP9b 消息类型注册式渲染。踩 WP8a Surface API | WP8a（已ship） | **WP9a 已ship**；**WP9b 摸底后收窄（2026-07-07）**——消息级已是单点二分不动；改造对象=工具卡级：ToolResultCard if 链→注册表、TOOLS_WITH_RESULT_CARD 升运行时权威、镜像哨兵改断注册表与 TOOL_REGISTRY 一致（消除漂移前科）。轻量路径实施，**排 WP15/13b 之后**（共享 tool-registry.test.ts） |
| WP10 | query 路由管线化 | WP10a ✅已ship：POST 176 行内联→四段 Stage 管线（sessionStage 首获独立测试）+agent-ws-server 退役四件套。摸底修正：路由本已半整洁，真债=内联会话段+无管线抽象 | 无 | **WP10a 已ship** |
| WP11 | 脏文件语料库 | 摸底定案路线 A（直喂解析器）。9 样本+GBK 编码检测（修静默乱码入库）+PII 自动门控（含 xlsx mirror）+analyze-csv column_warnings（修静默 0）。遗留：eval:golden:ci 未接 CI（独立小事待办） | 无 | **已ship** |
| WP12 | 知识库语义检索 | 摸底修正：sqlite-vec 系幽灵引用未安装，否决扩展路线改 BLOB+JS 余弦（Windows 打包盲区+规模无 ANN 需求）。落地：v11 knowledge_embeddings + worker embed-texts（bge-small-zh-v1.5 int8 ONNX，Xenova 仓三级候选源）+ ingest 嵌入（失败降级）+ rg/向量 RRF 融合 + reindex API/按钮 + 清 4 死旗标 | 无 | **已ship**（2026-07-07；两轮修复：默认源 404、块序号/归档过滤；真机余弦 0.91/0.30） |

### T3 扩展面

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| WP13 | 往来管理落地 | 拆刀：WP13a 合同应收层（用户拍板）✅已ship——转正+query_receivables+receivables-ledger 技能+今日到期分箱修复 / WP13b 销项发票登记+发票级账龄+回款落盘（待启动） | WP1（已ship） | **WP13a 已ship** |
| WP14 | 交互工件系统 | 拆刀：WP14a 可勾选清单工件 ✅已ship（artifacts 表 v10+emit_checklist+三态卡片+状态 API+两技能接入）/ WP14b 凭证行内改科目等编辑型工件（待启动） | WP8、WP9、WP1（已ship） | **WP14a 已ship** |
| WP15 | 审计日志与撤销 | 落地：v12 audit_logs 补列（conversation_id/tool_name/undo/undone_at，无会话 FK 长寿设计）+ audit-store（delete_rows/restore_rows 双原语、白名单硬校验+执行时二次校验、单事务撤销）+ fact_invoices/fact_metrics 写路径留痕 + 两段式 undo_last_write（high）+ GET /api/audit + POST undo。fact_obligations 经审查裁定移出（用户 UI 触发非 agent 写路径） | WP6 | **已ship**（2026-07-07；fix first 一轮：AU8 原子性真实中途失败重写） |

## 依赖关系（关键路径）

```
WP6 迁移框架 ──→ WP1 事实库 ──→ WP2 节奏引擎 / WP13 往来 / WP14 工件(数据侧)
WP8 UI底座  ──→ WP9 chat-page拆解 ──→ WP4 可追溯UI / WP14 工件(UI侧)
WP3 申报复核（独立先行，WP1 后切换数据源）
WP5 / WP7 / WP10 / WP11 / WP12（无前置，按资源穿插）
```

## 批次计划

- **第一批（✅ 已完成，2026-07-06 单日走完全流水线）**：WP6 迁移纪律收口、WP8a UI 底座、WP3 申报前复核——三包均经 spec→计划审查→实施(TDD)→实施审查 ship。改动未提交，待用户决定 commit/PR。
  - 遗留到后续批次的钩子：WP8b+ 收敛批次（spec-ui-foundation 附录 A 清单）；doc-card.tsx 死代码清理（已登记独立任务）。
  - **filing-precheck 带 key 验收 ✅ 通过（2026-07-06）**：场景①空画像正确追问资格+义务分叉+截止日；场景②b 三态清单齐全、B1 用 run_python 抓出埋设的 50 元销项尾差、B3/B4 复算通过、缺数据项全部老实标"无法核验"。附带发现并修复：JSON 路径 dataUrl 附件不落盘、内联块被非 Anthropic 网关丢弃 → 落盘归一 hotfix（audit-json-attachments.md，实施中）。
- **第二批**：WP1 事实库（spec 在第一批期间设计）、WP9 chat-page 拆解、WP5 计算引擎。
- **第三批（✅ 已完成，2026-07-07）**：WP2a 节奏引擎、WP4a 可追溯契约、WP7a Windows 防线收口——均经完整流水线 ship。本批要点：三份摸底均有失真（WP4a 最重——把已实现功能当待办），计划审查全部抓回；WP9a 哨兵泄漏事故在本批开工时发现并修复（教训⑦⑧入记忆）。
- **第四批（✅ 已完成，2026-07-07）**：WP1b（✅ 已ship——义务落盘+五路钩子+读切换；中断续接与钩子测试真实化两轮波折后收口）、WP1c（✅ 已ship——写入端补字段+query_invoice_ledger+A4 升级+dataScope 清尾）、WP8b（✅ 完成，轻量路径——六文件 8 处容器收敛+28 行豁免注释，lint 警告 203→180，orchestrator 自查 diff 通过）。**WP1b/WP1c 实施须串行（共享 finance-store.ts）**。后续：WP1b（义务落盘消费切换）、WP1c（invoice 写入端补字段+registry dataScope 更新+fact_invoices source DEFAULT）、WP4b（voucher/分析接入 receipt+provenance 落库 v9）、WP8b+（UI 收敛批次）、WP10 route 管线化、WP11 语料库、WP12 语义检索、WP13-15。
- **第五批（✅ 已完成，2026-07-07）**：WP13a 合同应收层、WP11 脏文件语料库、WP8c UI 长尾（30 文件收敛，lint 警告 181→139；orchestrator 自查抓到 first-run-gate 暗色变色回归）。其后批次见下。
- **第六批（✅ 已完成，2026-07-07）**：WP14a 可勾选清单工件、WP10a 路由管线化——均经完整流水线 ship。本批要点：WP10a 前任中断收尾者救回幽灵模块引用；两实施审查各有一次跨任务 diff 归属误判（累计第四、五次），orchestrator 均以 git 实证撤销。剩余：WP13b、WP4b/5b/9b、WP12、WP15。
- **第七批（🔄 进行中，2026-07-07）**：WP12 知识库语义检索 + WP15 审计日志与撤销。前置动作：一至六批 9 提交已发 PR #36 合 main（待用户合并）。进度：两 spec 均经 fix first→修订→限定复审批准（WP12 v1.1 / WP15 v1.2）；WP12 已实施+两轮审查修复（默认模型源 404 是 orchestrator 验收抓出、块序号偏差是实施审查抓出），真实模型端到端验证通过（同义句余弦 0.91 vs 无关句 0.30），限定复审中；WP15 等 WP12 ship 后串行实施（v12 迁移位）。用户已下达连续执行指令：批7完成后继续 WP13b→WP4b→WP5b→WP9b 直至路线图清零，然后提交更新 PR。

## 会话协议（断点续传）

1. 开工：读本文件 → 找到状态非"已ship"的最靠前工作包 → 读对应 spec（和 audit，若实施中断）。
2. 流水线：scout 探索 → 主循环写 spec（自包含，含被否决方案）→ reviewer 批计划（复杂任务）→ implementer 实施（TDD，先红后绿）→ 写 audit → reviewer 审 diff → ship。
3. 收工：更新本文件状态表 + 未决问题；关键取舍写持久记忆。
4. spec 命名：`docs/spec/spec-<工作包名>.md`；audit：`docs/spec/audit-<工作包名>.md`。

## 需要用户确认的口径（遇到时问，不编默认值）

- WP3：申报检查清单的具体项目与用户实际申报表版本（增值税小规模/一般纳税人、附加税、个税）——spec 会先给提案清单，逐项标注"需核实当年政策"，由用户确认增删。
- WP1：事实库终态 schema 评审（动真实数据前必须过目）。
- WP5：税率/基数规则表的初始数据来源（内置模板 or 用户提供）。

## 不做清单（不设限也不做，防止反复纠结）

直连银行/税务局/直写金蝶（文件进文件出覆盖 80% 价值）；全自动申报/付款（对外不可逆动作永不进代办级）；
通用财务知识问答独立功能（与免费 LLM 无差异且责任风险高）；微服务化/上云（单机 SQLite 是卖点）。
