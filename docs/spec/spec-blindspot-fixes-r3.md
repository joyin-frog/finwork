# Spec: 盲区扫描修复第二批（blindspot-fixes-r3）

## 背景与目标

第三轮盲区扫描（chat 管线 / 性能内存 / 金蝶格式 / 多实例并发 / 升级路径五个切面）发现 2 组 P1 + 若干 P2。本批修复四个工作包（WP-F..I），文件集互不相交，可并行实施。基线：本分支 HEAD（已合入 main 的 PR #38，迁移链尾 v15）。

**非目标**：本批不做——向量近似索引（暴力扫的延迟优化另立项，本批只修内存）、agents 页 N+1 聚合改写、v9 迁移丢数据审计化（audit_logs 表在 v13 才建，历史迁移内写审计有依赖倒置风险）、双实例日志轮转竞态、`lib/agent/tools/finance/kingdee.ts` 死代码清理（记 backlog）。不重构、不顺手改无关代码。

## 环境与验证

- 仓库根：`/Users/gyro/codex/finance-agent-public/.claude/worktrees/blissful-easley-5c7b41`
- 全量测试：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`（venv 已在 workers/.venv 符号链接就位）
- 实施期间只跑目标测试文件（`node --import tsx tests/<file>.test.ts`），全量回归由主循环统一跑
- **不要执行任何 git add / git commit**——提交由主循环统一做

## 通用铁律

- node:sqlite `DatabaseSync` 无嵌套 BEGIN；包事务前先查内层函数是否自带事务
- 修 bug 先写失败测试确认红，再修，再转绿（纯文案/schema 一行改动除外）
- **迁移编号纪律**：本批唯一新迁移编号已定为 **v17**（三查结果：main 链尾 v15、并行 worktree competent-thompson 已占 v16、共享 dev 库可能已被推到 16）。不得使用 16。

---

## WP-F 单实例守卫与并发写保护（P1）

**Files touched**: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `lib/db/finance-store.ts`, `lib/agent/tools/finance/sales-invoices.ts`, 测试文件

1. **单实例守卫**：`Cargo.toml` 加 `tauri-plugin-single-instance`（版本与现有 tauri 2.x 依赖族一致），注册位置必须在 **Builder 链上、`.setup()` 之前**（`.plugin(tauri_plugin_single_instance::init(...))`）——不要学 lib.rs 里其他插件在 setup 闭包内 `app.handle().plugin(...)` 的写法，single-instance 必须在应用启动前挂钩。回调里聚焦已有主窗口。改完跑 `cargo check --manifest-path src-tauri/Cargo.toml` 确认编译通过（不必打包）。
2. **结算防覆盖**：`finance-store.ts` `settleInvoice`（约 984-1038 行，注意它已被 WP-D 包了 BEGIN/COMMIT+recordAudit）的 UPDATE 加 `AND (settlement_status IS NULL OR settlement_status != 'settled')` 守卫。**守卫命中的处理（精确执行）**：`result.changes === 0` 时——(a) 先 `db.exec("ROLLBACK")`（绝不能带着打开的事务 return，否则下一个 BEGIN 抛 "cannot start a transaction within a transaction"）；(b) 事务外快照此时必然已过期，需在 ROLLBACK 后重新 SELECT 该发票取最新 `settled_at`/`settled_amount_cents` 用于 `alreadySettled` 返回值；(c) 此路径不写审计。返回形状与现有 `alreadySettled` 分支一致。
3. **已确认工资防降级**：`savePayrollDraft`（约 218-300 行）现有事务外抛错已覆盖单进程场景——本条只做**守卫下沉**：`ON CONFLICT ... DO UPDATE` 加 `WHERE settlement_status != 'confirmed'`（node:sqlite 自带 SQLite 3.51 支持该语法，已核实），函数签名与返回值**不变**（保持 void），单进程行为完全不变，多进程竞态下已确认行不再被覆盖。
4. **确认审计如实**：`confirmPayrollPeriod` 的 `recordAudit` 与返回值改用 UPDATE 实际 `changes` 行数对应的员工集合，不再用事务前快照（0 行更新时审计不得声称确认了 N 人）。
5. **历史发票 NULL 方向文案**：`settleInvoice` 对 `direction IS NULL` 与 `direction = 'in'` 分开返回（新增 `directionUnknown` 或等价标记）；`sales-invoices.ts` 工具层对 NULL 方向输出"历史发票未标注方向，请先确认为销项后重录方向"而非误报"为进项发票"。
6. 测试：结算两次第二次 alreadySettled（SQL 层守卫直测：绕过快照检查直接第二次 UPDATE 影响 0 行）；已确认工资 UPSERT 不降级；NULL 方向文案分支。

**成功标准**：新测试先红后绿；`cargo check` 通过；`grep -n "single-instance" src-tauri/Cargo.toml` 命中。

---

## WP-G 保留期补表 + 台账索引 + 向量内存（P1+P2）

**Files touched**: `lib/maintenance/retention.ts`, `lib/db/migrations.ts`（新增 v17）, `lib/knowledge/embeddings.ts`, 测试文件

1. **保留期补表**：`retention.ts` 的清理周期补四张表——`model_routing_log` 90 天、`subagent_dispatches` 90 天、`tool_executions` 30 天、`calc_receipts` 180 天。跟随现有表的实现模式，**逐一触达以下所有点**（漏一处即配置静默失效）：`RetentionConfig` 类型、`DEFAULT_RETENTION_CONFIG`、`loadRetentionConfig`、`isValidRetentionSettingsValue` 的 allowed 键集与逐字段校验、`RetentionStats` 类型、`runRetentionCycle` 的执行调用。时间列名已核实：`model_routing_log`/`tool_executions`/`calc_receipts` 用 `created_at`，**`subagent_dispatches` 用 `started_at`**。
2. **发票日期索引**：新增迁移 **v17**：`CREATE INDEX IF NOT EXISTS idx_fact_invoices_invoice_date ON fact_invoices(invoice_date)`。迁移体只做这一件事。
3. **向量检索内存修复**：`embeddings.ts` `vectorSearch` 不再把全表行物化成数组后再算——改为 prepared statement 的 `iterate()`（node:sqlite StatementSync 有此 API，已核实）逐行计算余弦。按文档聚合的 best Map 保留（它是 O(唯一文档数)，**不要**为凑 top-K 人为截断 Map，那会破坏按文档聚合的正确性）；本条修的是不再持有全表 BLOB 数组，行内 BLOB 用完即弃。行为（返回结果与排序）必须与现状完全一致，现有 T9/T10/T12 测试不改即须通过。
4. 测试：保留期四张新表各一条"过期删/未过期留"用例（跟随 retention 现有测试文件的模式）；v17 迁移幂等（连跑两次）+ 索引存在断言；向量检索行为回归靠既有 T9/T10/T12。

**成功标准**：新测试先红后绿；`node --import tsx tests/semantic-search.test.ts` 全绿（不改 T9/T10/T12 断言）；迁移编号确为 17。

---

## WP-H chat 管线：消息双写与附件上限（P2）

**Files touched**: `lib/agent/query-stages.ts`, 测试文件

1. **user 消息去重**：`sessionStage` insert 最后一条 user 消息前，查该 conversation 的**最后一条**消息：若 role='user' 且 content 与本次完全相同，跳过 insert（这是错误重试场景——上次请求失败、assistant 无完整落库）。若最后一条是 assistant 或内容不同则照常插入。不做跨多条的模糊去重。**实现载体**：在 `query-stages.ts` 内 import `getDb` 写内联 SQL（一条 `SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1` 级别的查询）；**不要**往 `lib/db/sqlite.ts` 加新导出函数（该文件不在本 WP 范围内）。
2. **附件大小上限**：`saveAttachmentBuffer` 前加服务端校验：单附件超过 20MB 抛出带类型标记的错误（错误文案含实际大小与上限），不落盘；在 `parseMultipartRequest`（两处调用方都在本文件内）catch 该错误并转换为 400 响应，不得以未捕获异常变成 500。
3. 测试：同 content 连发两次（模拟重试）DB 只有一条 user 消息；正常两轮对话同样问题两次（中间有 assistant 回复）则两条都在；超限附件被拒且磁盘无残留文件。

**成功标准**：新测试先红后绿；既有 `query-stages.test.ts`、`agent-attachments-json.test.ts` 回归绿。

---

## WP-I 金蝶工具收口（P2）

**Files touched**: `lib/agent/mcp-tools/kingdee-tools.ts`, 测试文件（如 `tests/kingdee.test.ts` 有相关断言则更新）

1. **工具描述矛盾收口**：`build_voucher_sheet`（约 673 行）描述删除"用 run_python(openpyxl) 写成 xlsx"指引，改为明确："仅用于向用户预览凭证行数据；生成交付 xlsx 必须用 export_voucher_list"。与 `export_voucher_list` 的"禁止 run_python 手拼"描述保持一致方向。**同步更新约 394 行的代码注释**（"实际 xlsx 由 run_python 写"已过时），保证防回归 grep 不误中。
2. **摘要长度上限**：凭证分录的 `summary` zod schema（约 43 行及 export 路径的对应 schema，grep `summary: z.string()` 全部凭证相关处）加 `.max(100, "摘要超长（金蝶上限约100字符），请精简")`。
3. 测试：超长摘要（>100 字符）被 schema 拒绝且错误信息含"精简"；`build_voucher_sheet` 描述断言不含 "run_python"（防回归）。

**成功标准**：新测试先红后绿；`tests/kingdee.test.ts` 回归绿。

---

## 汇总验收（主循环执行）

1. 全量 `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`
2. `npx tsc --noEmit`（只看 lib/app 新错误）
3. `cargo check --manifest-path src-tauri/Cargo.toml`
4. 逐 WP 自查 diff 偏差，记入各自 audit（`docs/spec/audit-blindspot-r3-wp-{f,g,h,i}.md`）
