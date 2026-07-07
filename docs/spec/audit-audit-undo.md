# audit-audit-undo — WP15 实施审计报告

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | 新增 v12 迁移 audit_logs_semantics（补列 + 索引；含防御性建表守卫） |
| `lib/db/audit-store.ts` | 新增 | recordAudit / undoAuditEntry / listAuditEntries |
| `lib/db/finance-store.ts` | 修改 | recordInvoices/upsertBusinessMetrics/payroll 三路写路径接入；删私有 auditLog；upsertBusinessMetrics 加 conversationId 参数 |
| `lib/agent/mcp-tools/business-metrics.ts` | 修改 | :38 透传 conversationId 到 upsertBusinessMetrics（reviewer B4）|
| `lib/agent/mcp-tools/undo-write.ts` | 新增 | undo_last_write 工具（两段式防误操作）|
| `lib/agent/mcp-tools/index.ts` | 修改 | 挂载 createUndoLastWriteTool |
| `lib/agent/tools/registry.ts` | 修改 | 注册 undo_last_write（finance/high）|
| `lib/agent/tools/renderers.ts` | 修改 | 添加 undo_last_write 中文摘要（T6 守卫）|
| `app/api/audit/route.ts` | 新增 | GET /api/audit?limit=N |
| `app/api/audit/[id]/undo/route.ts` | 新增 | POST /api/audit/:id/undo |
| `tests/audit-undo.test.ts` | 新增 | §1 全部行为（TDD 先红后绿）|
| `tests/tool-registry.test.ts` | 修改 | T2 手工清单追加 undo_last_write |
| `tests/fixtures/golden-schema.json` | 修改 | v12 新列 + 新索引同步 |
| `tests/all.test.ts` | 修改 | 末尾注册 auditUndoTestPromise |

---

## §1 成功标准逐条证据

### v12 audit_logs 补列

- 测试 AU1 验证四列全部存在（conversation_id / tool_name / undo / undone_at）
- 测试 AU1 验证 idx_audit_logs_created_at 索引存在
- db-migration-discipline.test.ts T2（golden-schema 等价）全通过
- 防御性守卫：某些测试绕过 initializeSchema 直接 `PRAGMA user_version=7`，v12 迁移先 `CREATE TABLE IF NOT EXISTS audit_logs` 再 `addColumnIfMissing`，避免"no such table"

### audit-store

- AU2：recordAudit 写入正确（event_type / conversation_id / tool_name / undo 字段均验证）
- AU3：白名单校验——`chat_messages` 被拒绝并抛匹配 `/白名单|whitelist/i` 的错误
- AU4：delete_rows 逆操作——两行 fact_invoices 写入后执行撤销，两行均消失，undone_at 已置，audit_undo 事件已追记
- AU5：二次撤销拒绝——已撤销条目再次调用 undoAuditEntry 抛 `/已撤销|already undone/i`
- AU6：无 undo 载荷返回结构化"不可撤销"错误——`payroll_confirm` 条目抛 `/不可撤销|undoable/i`
- AU7：restore_rows 逆操作——fact_metrics before-image 恢复正确
- AU8：事务原子性——逆操作全部执行或全部回滚，undone_at 状态与执行结果一致
- AU9：listAuditEntries 倒序 + undoableOnly 派生字段验证

### 会话删除后 audit 存活

- AU10：建会话、写 audit、删会话后 audit 行仍在（无 FK CASCADE）

### recordInvoices + upsertBusinessMetrics 端到端

- AU11：先写 A，再带 A+B 重复写，撤销仅删 B——A 仍在，B 已删。undo.keys 只含 B（不含重复的 A）
- AU12：upsertBusinessMetrics before-image 快照正确——先写 3000 元，再更新 5000 元，撤销后恢复 300000 分（3000 元）

### payroll event_type 哨兵

- tests/payroll-card.test.ts:72-75（event_type='payroll_confirm' 计数断言）全通过
- payroll_confirmed_overwrite / payroll_confirm 均改用 recordAudit，字符串逐字不变

### API 路由

- app/api/audit/route.ts：GET 列表（limit 参数守卫，1–200）
- app/api/audit/[id]/undo/route.ts：POST 撤销（400/404/409/500 分别对应不可撤销/不存在/已撤销/内部错误）

### MCP undo_last_write

- 两段式设计：无参=只查最近可撤销记录；带 auditId=执行撤销
- riskLevel=high → confirm gate 在 registry.ts ALLOWED_TOOLS 外（同 T2 通过证明）
- T6 渲染摘要已加，tool-registry.test.ts T6 通过

### 全仓 auditLog 零残留

```
rg "auditLog" lib/ tests/ app/ -g "*.ts" -g "*.tsx"
```
结果：仅 finance-store.ts 的墓碑注释行、retention.ts 中 `auditLogDays`/`auditLogs`（属性名非函数调用）、tests/unified-file-library.test.ts 中独立本地帮助函数（与 WP15 无关）。旧私有 `auditLog(db, ...)` 函数调用：零残留。

---

## 测试结果

**红态证据**：首次运行 `node --import tsx tests/audit-undo.test.ts` 报 `ERR_MODULE_NOT_FOUND: Cannot find module '...lib/db/audit-store.ts'`，EXIT=0（unhandledRejection 形式，spec 规定的红态）。

**绿态结果**：

```
audit-undo: all checks passed ✓
EXIT=0
```

全量：
```
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# duration_ms ~11700
EXIT=0  零 unhandledRejection
```

typecheck: EXIT=0（零错误）
lint: EXIT=0（0 errors, 140 warnings，与基线持平——警告数不增）

---

## 偏差与说明

1. **v12 迁移加防御性建表守卫**：policy-rules.test.ts 绕过 initializeSchema 直接 `PRAGMA user_version=7` 只建 app_settings 表，v12 `addColumnIfMissing` 会因 audit_logs 表不存在失败。加 `CREATE TABLE IF NOT EXISTS audit_logs` 守卫后恢复为幂等——符合迁移纪律"使用 addColumnIfMissing / CREATE TABLE IF NOT EXISTS 等守卫"的原则。

2. **smoke.test.ts 预存在失败**：`generated_v2.xlsx != generated.xlsx`——验证在 git stash 基线状态下同样存在，与本 WP 无关。

3. **upsertBusinessMetrics 签名**：第三参数 `conversationId?: number | null` 为新增可选参数，既有调用全部零参或两参，无破坏性变更。

---

## 开放风险

- undo_last_write 的对话级体验（agent 何时主动建议撤销）属 prompt 层，带 key 验收时人工冒烟，不进单测（与 spec §4 一致）。
- restore_rows 存整行 before-image，fact_metrics 行小（<1KB），可忽略体积风险（与 spec §5 一致）。

---

## 修复轮（fix first → ship）

### 变更摘要

**B1（阻塞）修复** — `tests/audit-undo.test.ts` AU8 全部重写：

旧实现用 `id=-9999` 的 `INSERT OR REPLACE` 作为"失败注入"，实际上不违约（SQLite 接受任意 INTEGER pk），catch 分支是死代码，事务原子性零覆盖。

新实现：
- op1：`delete_rows fact_invoices` — 先插入 `INV-AU8-ATOM` 行，使 op1 真的删得掉（有实际副作用）
- op2：`restore_rows fact_metrics` — 行数据 `revenue_cents: null`，违反 `fact_metrics.revenue_cents NOT NULL` 约束，必然抛错
- 三条断言：`undoAuditEntry` 抛错 → `INV-AU8-ATOM` 仍存在（op1 效果回滚）→ `undone_at=null` → `audit_undo` 事件计数不变

**N1（防御纵深）采纳** — `lib/db/audit-store.ts`：

1. `validateUndoOps` 导出为公开函数，新增 `keyColumn` 格式校验（`/^[A-Za-z_][A-Za-z0-9_]*/`），防 SQL 注入面
2. `undoAuditEntry` 在 `BEGIN` 前对解析出的 ops 调用 `validateUndoOps`（执行时二次校验），防未来任何绕过 `recordAudit` 直写 undo JSON 的路径
3. 新增断言 AU8b：手工向 `audit_logs` 注入含 `chat_messages` 表名的 undo JSON，`undoAuditEntry` 执行时被拒绝并保持 `undone_at=null`

### 修复后测试结果

```
audit-undo: all checks passed ✓  （含重写的 AU8 + 新增 AU8b）
# tests 11 / pass 11 / fail 0
EXIT=0  零 unhandledRejection
typecheck: EXIT=0
lint: EXIT=0 (0 errors, 140 warnings，与基线持平)
```
