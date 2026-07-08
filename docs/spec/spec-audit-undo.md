# 审计日志与撤销（WP15：agent 写操作统一留痕 + 事实层行级回滚）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审唯一残余 B4（business-metrics.ts 漏列 Files touched）已补，按"修复即批准"生效）
> 状态：**已实施并通过审查（ship）**（2026-07-07；实施审查 fix first 一轮——AU8 原子性测试死分支重写为真实中途失败 + 执行时二次白名单校验/keyColumn 形状校验，限定复审通过）
> 依赖：WP6 迁移纪律（已ship）。迁移版本 **v12**（v11 归 WP12 语义检索，两包共享 migrations.ts/golden-schema/all.test.ts，**实施必须串行：WP12 ship 后本包才进实施队列（reviewer B3）；implementer 开工首步验证 migrations.ts 末条已是 v11，否则停止报告**）。
> 架构事实（2026-07-07 scout + orchestrator 精读核实）：
> - `audit_logs` 表已存在于 baseline（schema.ts:21-26：id/event_type/payload/created_at；trace_id 经 addColumnIfMissing schema.ts:92 追加），**无 conversation_id、无撤销语义、无级联删除**（比 chat_agent_events 更适合长期审计源——后者随会话 CASCADE 清除）。
> - 现有写入函数 `auditLog`（finance-store.ts:713，私有）只写 event_type+payload，**不写 trace_id**；全库仅 3 个调用点：payroll_confirmed_overwrite（:235）、payroll_confirm（:376）、invoice_ledger_record（:441）。其余写路径（upsertBusinessMetrics :589-614、fact_obligations 写入、document-metadata、update_company_profile、remember_convention 文件写）**零留痕**。
> - agent 写 DB 的 MCP 工具（registry.ts riskLevel medium/high）：record_reimbursement_invoices→fact_invoices、record_business_metrics→fact_metrics、record_document_metadata、update_company_profile、calculate_payroll_batch/confirm_payroll_period→payroll_*、import_kingdee_accounts、emit_checklist→artifacts；写文件：remember_convention、export_kingdee_draft、builtin Write/Edit/Bash。
> - 写操作形状：recordInvoices 循环单条 INSERT OR IGNORE（幂等靠主键）；upsertBusinessMetrics 循环 INSERT..ON CONFLICT DO UPDATE；无统一写入门面，无 before-image 先例。
> - **无软删除先例**（全库无 deleted_at）；删除全是硬删+CASCADE。
> - provenance：fact_invoices 有 conversation_id+source 列；fact_metrics 有 source 无 conversation_id；chat_agent_events 有 trace_id 链。"哪次对话哪个工具写的"目前只有 fact_invoices 半可答。
> - conversationId 注入先例：createFinanceMcpServer 签名有 conversationId（emit_checklist/WP14a 已用）。
> - 哨兵：golden-schema（tests/db-migration-discipline.test.ts T2）；tests/all.test.ts 手动注册；涉 finance-store 的行为测试 40+ 个文件（invoice-write-path/business-metrics/obligations-live 等）——本刀只增列不改既有行为，它们是回归防线。

## 0. 目标与非目标

**目标**：agent 每次落库写操作可回答"谁（哪次对话/哪个工具）、何时、写了什么、能否撤销"，并对事实层写入提供行级撤销：① v12 给 audit_logs 补审计语义列；② 新 `lib/db/audit-store.ts`（recordAudit / listAuditEntries / undoAuditEntry——撤销以逆操作 JSON 执行于单事务）；③ finance-store **两类 agent 事实写路径**接入带撤销信息的留痕（fact_invoices / fact_metrics），payroll 确认类只留痕不支持撤销（标 undoable=false）；④ `GET /api/audit`（近期写操作列表）+ `POST /api/audit/[id]/undo`；⑤ MCP 工具 `undo_last_write`（high）——用户在对话里说"记错了，撤销"时 agent 可执行。

**非目标**：**fact_obligations 留痕与撤销（reviewer B1/B2 裁定移出）**——其唯一写函数 `persistDerivedObligations`（lib/domain/cash-obligations.ts:133）由用户在 UI 确认文档元数据触发（app/api/knowledge/documents/[id]/route.ts:40,72），非 agent 写路径，概念上不属"agent 操作留痕"；且 DELETE+INSERT 派生重建模式与行级撤销原语不匹配、可从源文档随时重放，撤销无意义；**emit_checklist→artifacts 写入不进审计（reviewer N2）**——清单工件是会话内进度记录非财务事实，撤销语义不清晰；文件写撤销（remember_convention/export/builtin Write——文件系统快照另一档复杂度）；软删除改造；audit UI 页面/时间线（v1 API+工具先行，UI 等使用反馈）；对 UPDATE 型撤销做冲突检测（last-write-wins 单机产品，同 WP14a 先例）；chat_agent_events 改动；跨多条审计的批量回滚。

## 1. 成功标准（先红后绿）

- [ ] **v12 audit_logs 补列**（baseline 冻结，走迁移）：`conversation_id INTEGER NULL · tool_name TEXT NULL · undo TEXT NULL(JSON 逆操作) · undone_at TEXT NULL`；索引 created_at。golden-schema 同步。不加 FK（audit 须在会话删除后存活——独立留存是它对 chat_agent_events 的差异价值，测试断言：删会话后 audit 行仍在）。
- [ ] **audit-store**：
  - `recordAudit({eventType, payload, conversationId?, traceId?, toolName?, undo?})`——undo 为逆操作数组，仅两种原语：`{op:'delete_rows', table, keyColumn, keys[]}`（撤销 INSERT）与 `{op:'restore_rows', table, keyColumn, rows[]}`（撤销 UPDATE，rows=before-image 整行）；**table 白名单硬校验**（fact_invoices/fact_metrics——fact_obligations 已移出范围），白名单外写入时拒绝并抛错——防未来误用扩权。
  - `undoAuditEntry(id)`：单事务执行全部逆操作 → 置 undone_at → 追记一条 `audit_undo` 事件（撤销本身留痕）；已撤销的拒绝二次撤销；无 undo 载荷的返回结构化"不可撤销"错误（中文）。
  - `listAuditEntries({limit, undoableOnly?})`：倒序，含"是否可撤销"派生字段。
- [ ] **写路径接入**（行为零变化，只加留痕；既有 40+ 行为测试全绿即回归防线）：
  - recordInvoices：现有 auditLog 调用升级为 recordAudit，undo=delete_rows(**仅 inserted 数组内的 invoice_nos**——INSERT OR IGNORE 被忽略的重复行不进 inserted，不会误删他人先写的行，语义已核实 finance-store.ts:409-443)，透传 conversationId（入参已有）；
  - upsertBusinessMetrics：新增留痕，undo=对新插入行 delete_rows + 对被覆盖行 restore_rows（写前 SELECT before-image）；**conversationId 经新增可选入参传递**（reviewer N4 定案：BusinessMetricRow 不动，函数签名加 `conversationId?: number`，MCP 工具 business-metrics.ts:38 调用处透传既有工具入参）；
  - payroll_confirm / payroll_confirmed_overwrite：升级为 recordAudit（获得 trace/conversation 归因）但 undo=null（周期确认是业务动作非行级写，撤销走业务流程）；**event_type 字符串三处保持逐字不变**——tests/payroll-card.test.ts:72-75 有 `event_type='payroll_confirm'` 计数断言（reviewer N3 哨兵）；
  - 私有 auditLog 函数删除，全部调用点迁到 audit-store（全仓 `rg "auditLog"` 零残留）。
- [ ] **API**：GET /api/audit?limit=50 返回列表；POST /api/audit/[id]/undo 成功返回撤销明细、对不可撤销/已撤销/不存在分别 400/409/404 中文错误。
- [ ] **MCP `undo_last_write`**（category finance，riskLevel high——运行时权限门已核实真实存在：hooks/built-in.ts:159-188 createRiskConfirmHook 对 high 触发 confirm、registry.ts:90-91 移出 ALLOWED_TOOLS 强制走 canUseTool（reviewer N1）；接线三件套：TOOL_REGISTRY + renderers T6 中文摘要 + 不挂子代理角色白名单——撤销是主对话动作）：**两段式防撤错对象（reviewer N5）**——无参调用=只查不执行，返回最近一条可撤销记录的描述（表/行数/原写入时间/auditId），工具描述指示 agent 先向用户复述确认；带 auditId 调用=执行撤销并返回撤销明细。
- [ ] 测试（tests/audit-undo.test.ts）：迁移形状/两种逆操作原语/白名单拒绝/事务原子性（逆操作中途失败全回滚）/二次撤销拒绝/会话删除后 audit 存活/recordInvoices+upsertBusinessMetrics 的 undo 载荷正确性（插入→撤销→表回到写前状态的端到端断言）/**重复发票不误删**（先写 A，再带 A+B 重复写，撤销第二条只删 B）；注册 all.test.ts 末尾。tests/tool-registry.test.ts 的 T2 手工清单追加 undo_last_write（T2 系部分覆盖清单非全镜像、T6 自动查 renderer，已核实——reviewer N7）。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v12 audit_logs 补列（**开工首步验证末尾是 v11，否则停止报告——WP12 须先 ship**） |
| `lib/db/audit-store.ts` | 新增 | recordAudit/undoAuditEntry/listAuditEntries |
| `lib/db/finance-store.ts` | 修改 | fact_invoices/fact_metrics 两类写路径接入 + payroll 留痕升级 + 删私有 auditLog |
| `lib/agent/mcp-tools/undo-write.ts` | 新增 | undo_last_write 工具 |
| `lib/agent/mcp-tools/business-metrics.ts` | 修改 | :38 调用处透传 conversationId 到 upsertBusinessMetrics（复审 B4） |
| `lib/agent/mcp-tools/index.ts` | 修改 | 挂载 |
| `lib/agent/tools/registry.ts` | 修改 | 注册（finance/high） |
| `lib/agent/tools/renderers.ts` | 修改 | 中文摘要（T6） |
| `app/api/audit/route.ts` | 新增 | GET 列表 |
| `app/api/audit/[id]/undo/route.ts` | 新增 | POST 撤销 |
| `tests/audit-undo.test.ts` | 新增 | §1 全部行为 |
| `tests/tool-registry.test.ts` | 修改 | 工具清单镜像扩（若该哨兵覆盖全部工具名，开工核实） |
| `tests/fixtures/golden-schema.json` | 修改 | v12 同步 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试（迁移形状/逆操作原语/白名单）。2. v12+golden。3. audit-store。4. finance-store 接入（一次一个写路径，每步跑该路径既有测试）。5. API 两条。6. MCP 工具+接线（跑 T6 守卫）。7. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```
- undo_last_write 的对话级体验（agent 何时主动建议撤销）属 prompt 层，带 key 验收时人工冒烟，不进单测。

## 5. 风险与开放问题

- **before-image 时点**：upsertBusinessMetrics 的 restore_rows 依赖写前 SELECT——写与 SELECT 之间无并发写者（node:sqlite DatabaseSync 同步阻塞模型，单机单进程），无 TOCTOU——复审已核实成立。
- **撤销的业务语义边界**：撤销只回滚事实层行，不通知下游（驾驶舱/义务钩子读表是 pull 模型，天然看到回滚后状态）；若未来出现物化派生表需级联失效，留给引入者。
- **undo 载荷体积**：restore_rows 存整行 before-image，fact_metrics 行小（<1KB）；fact_invoices 撤销走 delete_rows 只存键。可忽略。
- **工具滥用面**：v1.1 已改两段式（无参只查、带 auditId 才执行），叠加 riskLevel high 的运行时 confirm 门（hooks/built-in.ts:159-188）+ 撤销自身留痕可再查。剩余风险=agent 跳过复述直接带 auditId 执行，属 prompt 遵从性问题，带 key 验收观察。
- 被否决：① 触发器自动留痕（SQLite TRIGGER 拿不到 conversation/trace 上下文，且隐式魔法违反项目品味）；② 通用 undo 框架/命令模式（三张表两种原语够用，过早抽象）；③ 软删除列改造（侵入全部读路径，收益不成比例）；④ 文件写撤销进 v1（快照/diff 另一档复杂度，且 remember_convention 本身可被 agent 编辑修正）；⑤ audit_logs 挂会话 FK CASCADE（审计必须比会话长寿，独立留存是设计目标）。
