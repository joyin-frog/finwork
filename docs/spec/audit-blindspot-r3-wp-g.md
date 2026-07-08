# Audit: blindspot-fixes-r3 WP-G

## Files changed

| File | Type | Change |
|---|---|---|
| `lib/maintenance/retention.ts` | modified | 补四张新表的类型/默认值/校验器/加载/统计/执行（spec 1） |
| `lib/db/migrations.ts` | modified | 新增 v17 迁移（spec 2） |
| `lib/knowledge/embeddings.ts` | modified | vectorSearch 改 iterate()（spec 3） |
| `tests/retention-new-tables.test.ts` | created | 四张新表各一"过期删/未过期留"用例（spec 4） |
| `tests/migration-v17.test.ts` | created | v17 幂等 + 索引存在断言（spec 4） |
| `tests/retention.test.ts` | modified | deepEqual stats 期望值补四字段；initializeSchema 换 runMigrations（见偏差说明） |
| `tests/fixtures/golden-schema.json` | modified | 补 idx_fact_invoices_invoice_date 索引（migration discipline T2 要求） |
| `tests/all.test.ts` | modified | 引入两个新测试文件 |

---

## 每文件改动与 spec 对应关系

### lib/maintenance/retention.ts

- **RetentionConfig 类型**（spec 1 · 类型）：新增 `modelRoutingLogDays`, `subagentDispatchesDays`, `toolExecutionsDays`, `calcReceiptsDays` 四个 `number` 字段，附注释说明来源。
- **DEFAULT_RETENTION_CONFIG**（spec 1 · 默认值）：四字段分别设为 90/90/30/180，与 spec 吻合。
- **isValidRetentionSettingsValue**（spec 1 · 校验器）：`allowed` Set 增加四个键；返回值 `&&` 链各追加一条 `isRetentionDays()` 守卫。
- **loadRetentionConfig**（spec 1 · 加载）：解析结果对象补四字段，缺省时回落 `DEFAULT_RETENTION_CONFIG` 对应值。
- **RetentionStats 类型**（spec 1 · 统计）：新增 `modelRoutingLogs`, `subagentDispatches`, `toolExecutions`, `calcReceipts` 四字段。
- **pruneOldModelRoutingLogs / pruneOldSubagentDispatches / pruneOldToolExecutions / pruneOldCalcReceipts**（新增）：逐一对应四张表；`subagent_dispatches` 使用 `unixepoch(started_at)` 而非 `created_at`，与 spec 要求一致。
- **runRetentionCycle**（spec 1 · 执行）：`stats` 初始化补四字段；末尾追加四条 `run()` 调用，各传 `db` 与 `now`。

### lib/db/migrations.ts

- 在 MIGRATIONS 数组末尾追加 `version: 17, name: "idx_fact_invoices_invoice_date"` 条目，`up` 函数执行：
  ```sql
  CREATE INDEX IF NOT EXISTS idx_fact_invoices_invoice_date ON fact_invoices(invoice_date)
  ```
  幂等（`IF NOT EXISTS`），迁移体只做这一件事（spec 2 明确要求）。
- `LATEST_VERSION` 自动更新为 17。

### lib/knowledge/embeddings.ts

- `vectorSearch`：用 `stmt.iterate(model)` 替代 `stmt.all(model)`（spec 3）。行内 BLOB 用完即弃，不持有全表数组。
- `best` Map 保留不截断（spec 3 明确要求）。
- 原先先调 `.all()` 再判 `rows.length === 0` 的逻辑改为：声明语句 + 在迭代完成后判 `best.size === 0`；行为等价。
- try-catch 包含整个迭代块（与原来只包 `.all()` 对称）。

---

## 与 spec 偏差及理由

### 偏差 1：retention.test.ts 由 initializeSchema 改为 runMigrations

**spec 未提及**，属必要联动修改。原因：新增的 `runRetentionCycle` 现在调用 `pruneOldSubagentDispatches` / `pruneOldCalcReceipts`，而这两张表只在 migration v4/v14 中建立，`initializeSchema`（baseline schema.ts）不包含。若不改，原有测试的 `assert.deepEqual(result.errors, [])` 会因"no such table"而失败。
改法：`initializeSchema(db)` 换成 `runMigrations(db, ":memory:", () => null)`，同时补 `PRAGMA foreign_keys = ON`（对齐其他迁移测试的惯例）。这是最小改动，不改数据插入逻辑，不改断言语义。

### 偏差 2：tests/fixtures/golden-schema.json 补索引

spec "Files touched" 中列出"测试文件"。`golden-schema.json` 是测试 fixture，被 `db-migration-discipline.test.ts` T2 直接 import 比对，加 v17 后索引集必须同步更新，否则 T2 失败。将 `idx_fact_invoices_invoice_date` 加入 `indexes` 和 `indexDetails` 数组。

---

## 先红后绿证据

| 测试文件 | 红（改前） | 绿（改后） |
|---|---|---|
| `tests/retention-new-tables.test.ts` | `TypeError: pruneOldModelRoutingLogs is not a function` | all checks passed |
| `tests/migration-v17.test.ts` | `AssertionError: v17 T1: idx_fact_invoices_invoice_date 应存在` | all 3 checks passed |

**T9/T10/T12 不变即通过**（spec 要求）：`tests/semantic-search.test.ts` 全 13 条 PASS，`iterate()` 重写行为与原 `.all()` 版本完全一致。

---

## 测试结果

```
tests/retention-new-tables.test.ts  : all checks passed ✓  (8 assertions)
tests/migration-v17.test.ts         : all 3 checks passed ✓
tests/retention.test.ts             : retention tests passed ✓
tests/semantic-search.test.ts       : all 13 checks passed ✓  (T9/T10/T12 通过)
tests/db-migration-discipline.test.ts : all 5 checks passed ✓  (T2 golden-schema 匹配)
tests/db-hardening.test.ts          : all 4 checks passed ✓
tests/idempotency.test.ts           : all 6 checks passed ✓
```

---

## 开放风险

1. **subagent_dispatches / calc_receipts 在旧数据库上的首次执行**：生产数据库如果 user_version < 4（或 < 14），这两张表尚未建立。`runRetentionCycle` 调用对应 prune 函数，DELETE 失败会被 `run()` catch 放入 `errors` 而非抛出，不会阻断启动。待 `runMigrations` 升库至 v17 后，下次定时清理即正常生效。风险低，符合现有 best-effort 设计。
2. **StatementSync.iterate() 实验性 API**：Node.js 22.12+ 已有此方法（当前运行 v22.22.3 验证通过），但 node:sqlite 整体仍标注 ExperimentalWarning。如未来 API 变更需关注升级兼容性。
