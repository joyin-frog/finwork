# Spec:数据安全(schema 迁移 / 导出 / 恢复)

## 背景与目标
财务是 system-of-record。现状:有写前快照(`backupDatabase`,`lib/db/sqlite.ts`),但**无 schema 迁移系统、无数据导出、无恢复流程**——升级改 schema 可能丢数据(`CREATE TABLE IF NOT EXISTS` 不会给老库加列),机器坏了无法离机恢复。本特性补齐这半张安全网:

1. **schema 迁移系统**:版本化 schema,启动时幂等应用待应用迁移,升级不丢数据。
2. **数据导出**:整库导出为可携带、可恢复的单文件(离机备份)。
3. **数据恢复**:从导出文件恢复,恢复前先备份当前库。

## 红线约束(必须遵守)
- **红线 7 数据不外发**:导出/恢复只走本地文件路径,零网络。
- **红线 5 写操作审批**:恢复是高风险破坏性写,经确认门思路处理(若做成 agent 工具则 `riskLevel: "high"` + `withIdempotency`;若做成设置页/IPC 入口,UI 二次确认);无交互通道 fail-closed。
- **红线 8 审计**:恢复/导出落 `audit_logs`(经 `insertAuditLog`),记谁/何时/做了什么。
- **不可丢数据**:每个迁移幂等、可重入;迁移应用前先 `backupDatabase`(失败可回滚);迁移在事务内。

## 设计

### 1. 迁移系统(`lib/db/migrations.ts`)
- 用 `PRAGMA user_version` 追踪 schema 版本(整数)。
- `export const MIGRATIONS: { version: number; name: string; up: (db: DatabaseSync) => void }[]`,按 version 升序。
- 现有建表(`initSchema` 或等价)作为 **baseline = version 1**:即把当前 schema 视为 v1,`user_version=0`(全新或老库)时先确保 baseline 表在(沿用现有 CREATE IF NOT EXISTS),再把 user_version 设为 1;之后的结构变更**一律新增一条 migration**(version 2、3…)。
- `export function runMigrations(db, dbPath)`:
  1. 读当前 `user_version`。
  2. 若 `< 最新 version`:先 `backupDatabase(db, dbPath)`(可回滚)。
  3. 按序对每个 `version > current` 的迁移:在事务内执行 `up(db)`,成功后 `PRAGMA user_version = <version>`。
  4. 任一迁移抛错 → 事务回滚 + 抛出(让上层决定;**禁止静默吞**,红线 4)。
- **幂等**:迁移内做"加列前先查 `PRAGMA table_info` 是否已有"这类守卫(SQLite 无 `ADD COLUMN IF NOT EXISTS`);跑两次第二次 no-op。
- 集成:`getDb()` 初始化里,建完 baseline 表后调 `runMigrations`(替换/包住现在直接 initSchema 的位置)。**保持 `getDb()` 对现有调用方行为不变**(只是多了迁移这一步)。

### 2. 导出(`exportDatabase`)
- `export function exportDatabase(destPath: string): { path: string; bytes: number }`。
- 实现:`PRAGMA wal_checkpoint(TRUNCATE)` 后用 SQLite 原生 `VACUUM INTO '<destPath>'`(产出干净、完整、自带 `user_version` 的单文件 .db,可直接当库打开)。
- destPath 必须是本地绝对路径;落审计(`insertAuditLog("data_export", {...})`)。

### 3. 恢复(`restoreDatabase`)
- `export function restoreDatabase(srcPath: string): { restored: true; backupOf: string }`。
- 步骤:① 校验 `srcPath` 是合法 finance-agent 库(能以 sqlite 打开 + 含核心表如 `app_settings`/`audit_logs` + `user_version` ≤ 当前代码最新版本,**高于则拒**:不能用新库覆盖旧代码);② `backupDatabase`(当前库,留退路);③ 关闭当前连接 → 用 `srcPath` 覆盖 `dbPath`(原子:先拷到临时再 rename);④ 重开连接 + `runMigrations`(把恢复进来的旧库迁到当前版本)。
- 非法文件 → 抛错且**不破坏当前库**;落审计(`insertAuditLog("data_restore", {...})`)。

### 4. 暴露入口(MVP)
- **必做**:`lib/db/migrations.ts`(迁移 + runMigrations)、`exportDatabase`/`restoreDatabase`(放 `lib/db/sqlite.ts` 或 `lib/db/backup.ts`)、集成进 `getDb()`、测试。
- **尽量做**:设置页"导出备份/恢复备份"入口(API route + 按钮)或 agent 工具 `export_backup`/`restore_backup`(注册进 registry + renderer,restore 标 high risk)。若时间紧,入口可只留 API/lib,UI 后置——但 lib + 测试必须全。

## 验收(AC,每条配测试)
- **AC1** 全新库 → `runMigrations` → `user_version` = 最新 version;核心表齐全。
- **AC2** 幂等:`runMigrations` 连跑两次,第二次无变化、数据不变。
- **AC3** 保数据:构造一个"低版本 + 缺新列"的库(手动设 user_version + 删某新列场景)→ `runMigrations` → 新结构补上、旧行数据仍在。
- **AC4** 导出→恢复往返:写入已知数据 → `exportDatabase` → 改/删数据 → `restoreDatabase(导出文件)` → 原数据回来。
- **AC5** 恢复安全:恢复前自动 `backupDatabase`;传非库文件 → 抛错且当前库完好;恢复落审计。
- **AC6** 全本地零网络;导出/恢复路径校验(非绝对路径/越界按错处理)。

## 测试
`tests/data-safety.test.ts`(导出 `dataSafetyTestPromise`,wire 进 `tests/all.test.ts`),用隔离 DB(`FINANCE_AGENT_DB_PATH` 临时路径),覆盖 AC1–AC6。**只跑确定性逻辑,无需 key / 网络。**

## 改完必跑
`npm run typecheck` · `npm test` · `npm run lint` 全绿。

## 不做(本期边界)
- 云备份、自动定时备份、增量备份(本期只做启动迁移 + 手动导出/恢复)。
- 跨大版本的破坏性迁移回退(只保证前向迁移 + 恢复前快照退路)。
