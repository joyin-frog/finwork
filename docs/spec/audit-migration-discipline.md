# 迁移纪律收口 实施审计报告

> spec-migration-discipline v1.1 / 2026-07-06

## Files changed

| 文件 | 动作 |
|---|---|
| `tests/db-migration-discipline.test.ts` | 新增（五组测试，TDD 红→绿） |
| `tests/fixtures/golden-schema.json` | 新增（黄金 schema 快照，20 表 / 26 索引） |
| `lib/db/migrations.ts` | 修改（头部冻结声明 + v6 baseline_reconcile 迁移） |
| `lib/db/sqlite.ts` | 修改（删 initializeSchema 具名 import + 无条件调用；新增 rehearseMigrations） |
| `lib/db/schema.ts` | 修改（头部冻结声明注释，代码零改动） |
| `docs/spec/ROADMAP-improve.md` | 修改（WP6 状态从"实施中"改为"已完成"） |
| `docs/spec/audit-migration-discipline.md` | 新增（本文件） |

---

## 各文件改了什么

### `tests/db-migration-discipline.test.ts`（新增）

五组测试全部使用显式 `openFinanceDatabase(path)` 传参，不污染 `getDb()` 单例；临时库路径 `/tmp/finance-agent-discipline-<name>-<pid>.db`，测试结束后删除。

- **T1 删表不复活**：建全量库后 `DROP TABLE skill_snapshots`，再 `initializeFinanceDatabase`，断言表仍不存在。
- **T2 新库 dump 等价**：`:memory:` 跑 `runMigrations`，表名集合 / 索引名集合 / 各表列清单与 `golden-schema.json` 比对。
- **T3 漂移愈合**：手建 `user_version=5` 且 `knowledge_documents` 缺 `meta_status` 列的库，再 `initializeFinanceDatabase`，断言列存在且 `user_version = LATEST_VERSION`。
- **T4 幂等**：第一次初始化后，第二次 `runMigrations` 注入计数 backupFn，断言 backupFn 调用次数为 0、版本不变。
- **T5 预演不碰原库**：建全量库后跑 `rehearseMigrations`，断言原库表集合与 user_version 不变，result.ok = true。

### `tests/fixtures/golden-schema.json`（新增）

由实施前（无代码改动）的 `runMigrations(":memory:", ...)` 导出，捕获 20 张表与 26 个索引的完整快照，含各表 PRAGMA table_info 列清单。

**与 spec 数字差异说明**：spec §1 写的"18 表 + 24 索引"基于 `initializeSchema` 单独运行（不含 v3 `feature_events` 表、v4 `subagent_dispatches` 表及其索引）。Appendix B 明确说"对 `:memory:` 空库跑 `initializeFinanceDatabase`"，完整迁移链（v1→v5）产出 20 表 / 26 索引，fixture 捕获的是真实行为，以 fixture 为准。v6 加入后重跑 fixture 结果不变（baseline_reconcile 幂等）。

### `lib/db/migrations.ts`（修改）

1. **头部冻结纪律注释**：说明 schema.ts 已冻结、新增 DDL 一律追加 MIGRATIONS 条目、含破坏性变更示例。
2. **v6 baseline_reconcile 迁移**：
   ```
   { version: 6, name: "baseline_reconcile", up: (db) => { initializeSchema(db); } }
   ```
   对存量库（v<6）幂等重放 baseline，愈合历史列漂移；对全新库从 v0 跑完后 v6 也是幂等 no-op（`CREATE TABLE IF NOT EXISTS` + `addColumnIfMissing` 守卫）。

### `lib/db/sqlite.ts`（修改）

1. **删除具名 import `initializeSchema`**（第 7 行），已成死代码（`export * from "./schema"` 的重导出不受影响）。
2. **`initializeFinanceDatabase`**：移除 `initializeSchema(db)` 无条件调用（原 124 行），改为全交 `runMigrations`，并更新注释说明四条升级路径（v0 全新 / v1-v5 存量 / v6 reconcile / restoreDatabase 恢复）。
3. **新增 `rehearseMigrations(db, dbPath)`**：WAL checkpoint → VACUUM INTO 临时副本 → 新连接跑 `runMigrations`（no-op backupFn）→ `PRAGMA quick_check` → 关闭删除副本 → 返回 `{ ok, fromVersion, toVersion, error? }`。任何异常捕获进 `{ ok: false }`，不影响原库。签名接收已打开的源库连接（与 runMigrations 一致）。

### `lib/db/schema.ts`（修改）

仅头部加冻结声明注释，代码零改动：
```
⚠️  本文件已冻结 = v1..v6 时点快照。禁止再修改本文件中的任何 DDL...
```

### `docs/spec/ROADMAP-improve.md`（修改）

WP6 状态从"实施中"改为"已完成"，补充实施日期与结果摘要。

---

## 与计划的偏差

### 偏差 1：`tests/all.test.ts` 未修改（计划外文件，停止编辑）

**spec §2 Files touched 未列出 `tests/all.test.ts`**，遵守"列表外文件不动"铁律，未将新测试注册进 `all.test.ts`。

影响：`npm test`（运行 `all.test.ts`）不会执行新的五组测试，但 `node --import tsx tests/db-migration-discipline.test.ts` 单测正常通过。

处理建议：orchestrator 后续应将 `tests/all.test.ts` 加入可编辑列表并追加以下导入：
```typescript
const { dbMigrationDisciplineTestPromise } = await import("./db-migration-discipline.test.ts");
await dbMigrationDisciplineTestPromise;
```
（ROADMAP 注释中已提到"WP8a 排队等 WP6——两者都改 tests/all.test.ts"，说明遗漏属于 spec 疏漏）

### 偏差 2：`docs/spec/ROADMAP-improve.md` 在 spec §2 Files touched 中未列出

spec §1 成功标准明确写"`docs/spec/ROADMAP-improve.md` 的 WP6 状态更新"，§2 却未列入。属于 spec 内部不一致，按 §1 成功标准操作（已修改）。

### 偏差 3：golden-schema.json 表数 / 索引数与 spec §1 数字不符

spec §1 写"18 表 + 24 索引"，实际全迁移链产出 20 表 + 26 索引。已在 Files changed 说明节详述原因，fixture 捕获的是真实行为，以 fixture 为准。

---

## 测试结果

### 红测试证据（改动前 T1 失败）

```
node --import tsx tests/db-migration-discipline.test.ts

AssertionError [ERR_ASSERTION]: T1 FAIL: skill_snapshots 不应被 baseline 复活（存量库应只走迁移）
+ actual - expected

+ [Object: null prototype] {
+   name: 'skill_snapshots'
+ }
- undefined

    at tests/db-migration-discipline.test.ts:64:12
```

说明：现状代码 `initializeFinanceDatabase` 无条件跑 `initializeSchema`，`CREATE TABLE IF NOT EXISTS skill_snapshots` 把已删表复活，T1 断言 `undefined` 但收到了行对象，测试红。

### 实施后五组测试全绿

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/db-migration-discipline.test.ts

T1 PASS: 删表不复活 ✓
T2 PASS: 新库 dump 等价 ✓
T3 PASS: 漂移愈合 ✓
T4 PASS: 幂等 ✓
T5 PASS: 预演不碰原库 ✓
db-migration-discipline: all 5 checks passed ✓
```

### db-hardening.test.ts（无回归）

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/db-hardening.test.ts

db-hardening: all 4 checks passed ✓
```

### flags-db-override.test.ts（无回归）

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/flags-db-override.test.ts

flags-db-override: F1-F7 全部通过 ✓
```

### typecheck

```
npm run typecheck
（无输出，零错误）
```

### 全量 npm test

pre-existing 失败（与本任务无关）：`smoke.test.ts` 因 `.venv/bin/python3 ENOENT`（venv 未初始化）报错，该失败在本分支改动前已存在，与迁移纪律实施无关。

---

## 开放风险

1. **`tests/all.test.ts` 未注册新测试**：五组测试不在 CI 全量扫描路径内，需后续手动补入。
2. **golden-schema.json 维护负担**：任何合法 DDL 迁移须同步更新此 fixture（T2 会立即发现不一致），这是有意为之的机制。
3. **v0→v6 全新库触发一次"迁移前备份"**：`runMigrations` 对 v0 库调 backupFn（备份空库），无害但多余——与 spec §5 风险说明一致，有意不动。
4. **`rehearseMigrations` 副本磁盘占用**：与库同尺寸，放 `os.tmpdir()`，用后即删；WP1 使用前应检查磁盘余量（写进 WP1 spec）。
5. **v6 对全新库冗余幂等执行**：v0 跑 v1（baseline）后再跑 v6（再次 initializeSchema）属于幂等冗余，无功能问题，符合 spec N3 已知接受。

---

## Fix 轮记录（orchestrator，2026-07-06）

实施审查裁决 fix first，唯一阻塞 B1：`tests/all.test.ts` 未注册新测试（spec v1.1 Files touched 漏项，implementer 守界未改，偏差报告如实上报）。修复：orchestrator 在 `tests/all.test.ts` 末尾追加 `dbMigrationDisciplineTestPromise` 的 import+await（单文件两行，按 CLAUDE.md 琐碎改动例外直接动手）。验证：`FINANCE_AGENT_PYTHON_PATH=<主仓venv> FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 全量 11 组全绿，T1-T5 出现在运行器输出末尾。注：本工作树无 workers/.venv，需用 FINANCE_AGENT_PYTHON_PATH 指向主仓 venv。
