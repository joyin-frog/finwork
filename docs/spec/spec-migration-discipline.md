# 迁移纪律收口（WP6：baseline 冻结 + 破坏性迁移安全 + 大迁移预演）Spec

> 版本 v1.2 / 2026-07-06
> 状态：**已实施并通过审查（ship）**。实施审查裁决 fix first（唯一阻塞 B1：tests/all.test.ts 未注册，系 v1.1 Files touched 漏项），fix 轮补注册后全量 11 组测试绿（含新五组）。非阻塞记录：TDD 红态证据存于 audit 输出（无独立红态提交，评为可信）；golden fixture 20 表/26 索引 = 全迁移链真实行为（spec 正文 18/24 只数了 baseline，以 fixture 为准）。
> 依赖：无。是 WP1（事实库一步到位迁移，决策 D3）的硬前置。
> 架构事实：迁移框架**已存在且完整**——`lib/db/migrations.ts` 用 `PRAGMA user_version` 版本化（当前 v1-v5），每条迁移事务内执行、失败回滚并抛出，迁移前经注入的 `backupFn` 强制备份（VACUUM INTO，保留 7 份）。数据库 node:sqlite 单例（`lib/db/sqlite.ts:80` `getDb()` 懒初始化），WAL + foreign_keys ON。路径链：`FINANCE_AGENT_DB_PATH` → `FINANCE_AGENT_APP_DATA_DIR`/`FINANCE_AGENT_DATA_DIR` → 平台默认（`lib/runtime/paths.ts:11-21`）。Tauri 打包版与 dev 的初始化调用链完全相同（首个 API 请求触发）。测试建库两种既有模式：`openFinanceDatabase(":memory:")` 或 `/tmp/finance-agent-<name>-<pid>.db`（样板 `tests/db-hardening.test.ts:13`）。

## 0. 目标与非目标

**目标**：修掉现有"双轨制"的一个致命隐患并立下纪律。现状是 `initializeFinanceDatabase`（`lib/db/sqlite.ts:123-131`）**每次启动都无条件跑 `initializeSchema`**（18 张 `CREATE TABLE IF NOT EXISTS` + 23 处 `addColumnIfMissing`），然后才跑 `runMigrations`。后果：① 未来迁移若删表/改表（WP1 旧表退役必然发生），下次启动 baseline 会把删掉的表**原样复活成空表**；② 结构变更有两条路可走（改 baseline / 加迁移），纪律靠自觉。本 spec：让 baseline 只对全新库生效、存量库只走迁移；冻结 `schema.ts`；加 schema 等价与"删表不复活"回归测试；为 WP1 提供大迁移预演（copy-verify）能力。

**非目标（本期不做，已知并接受）**：
- 不做任何实际的业务表结构变更（那是 WP1）；
- 不引入第三方迁移库（node:sqlite + 现有框架够用，依赖纪律）；
- 不做迁移的 down/降级（现有"不降级 no-op"策略保持，退路靠备份恢复）；
- 不改备份策略与保留份数。

## 1. 成功标准

- [ ] **删表不复活**：测试先造一个已达 LATEST_VERSION 的库 → 手动 `DROP TABLE skill_snapshots` → 重新走 `initializeFinanceDatabase` → 断言该表**仍不存在**且不报错。此测试在改动前必须是**红的**（现状 baseline 会复活它），改动后转绿——这是本 spec 的核心行为变更证明。
- [ ] **全新库路径不变**：`:memory:` 空库走 `initializeFinanceDatabase` 后，`sqlite_master` 中**表名集合与索引名集合**与 spec 附录 B 的预期清单完全一致（18 表 + 24 索引；23 个补列用 `PRAGMA table_info` 逐列断言），`user_version = LATEST_VERSION`。断言集合成员而非比对 dump 字符串（后者对列顺序敏感、易误报）。
- [ ] **存量漂移愈合**：模拟"user_version=5 但缺一个 baseline 后补列"的旧库（建库后手动降版本并删列重现），重开后该列存在（由一次性 reconcile 迁移愈合），版本升至新 LATEST。
- [ ] **幂等**：同一库连续 `initializeFinanceDatabase` 两次，第二次零 DDL、版本不变、不触发备份。
- [ ] **预演能力**：`rehearseMigrations(db, dbPath)` 存在——checkpoint 后把库快照到临时副本、在副本上跑完 pending 迁移、`PRAGMA quick_check`、返回 `{ ok, fromVersion, toVersion, error? }`，全程不改原库（测试断言原库表集合与 user_version 不变）。
- [ ] `schema.ts` 与 `migrations.ts` 头部有冻结声明与新增迁移操作指引；`docs/spec/ROADMAP-improve.md` 的 WP6 状态更新。
- [ ] 全部先写红测试再实现；`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 全绿。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/sqlite.ts` | 修改 | `initializeFinanceDatabase` 去掉无条件 `initializeSchema(db)` 调用（124 行），全交给 `runMigrations`；新增 `rehearseMigrations` |
| `lib/db/migrations.ts` | 修改 | 追加 v6 `baseline_reconcile`（up = `initializeSchema`，一次性愈合存量漂移）；头部补纪律注释 |
| `lib/db/schema.ts` | 修改 | 仅头部加冻结声明注释（"本文件已冻结=v1..v6 时点快照，任何新 DDL 一律追加 MIGRATIONS 条目，禁止再改本文件"），代码零改动 |
| `tests/db-migration-discipline.test.ts` | 新增 | §1 全部五组行为测试 |
| `tests/all.test.ts` | 修改 | 注册新测试（运行器是手动 import 列表；v1.1 漏列，实施审查 B1 抓出，fix 轮由 orchestrator 补上） |

## 3. 实施步骤

1. **先写红测试** `tests/db-migration-discipline.test.ts`：建库样板抄 `tests/db-hardening.test.ts:13`（/tmp 临时文件，需要真实文件路径因为 rehearse 要复制文件；`:memory:` 只用于 dump 对照）。五组用例见 §1。"删表不复活"此时必须红。
2. **v6 reconcile 迁移**：`MIGRATIONS` 追加 `{ version: 6, name: "baseline_reconcile", up: initializeSchema }`。它对所有 <6 的存量库把 baseline 幂等重放一遍（愈合历史上"改了 baseline 没加迁移"造成的任何漂移），此后 baseline 永不再对存量库执行。
3. **摘除无条件 baseline**：`sqlite.ts:124` 删除 `initializeSchema(db)` 调用，**并删除 `sqlite.ts:7` 该具名 import**（已成死代码；`export * from "./schema"` 的重导出不受影响）。v0 全新库由 `MIGRATIONS[0]`（baseline）建全量 schema，随后 v2..v6 依次跑（各自幂等，安全）。
4. **`rehearseMigrations(db: DatabaseSync, dbPath: string)`**（放 `sqlite.ts`，与备份/恢复函数为邻）：签名接收**已打开的源库连接**（与 `runMigrations` 一致），先在源连接上 `PRAGMA wal_checkpoint(TRUNCATE)` 再 `VACUUM INTO` 临时副本（保证副本含全部已提交写入，模式同 `exportDatabase`，`sqlite.ts:157-159`）→ 新开连接打开副本跑 `runMigrations`（backupFn 传 no-op，副本不需要再备份）→ `PRAGMA quick_check` → 关闭并删除副本 → 返回结果对象。任何异常捕获进 `{ ok: false, error }`，绝不影响原库。
5. **冻结声明与指引**：`schema.ts`、`migrations.ts` 头部注释更新；`migrations.ts` 里"新增迁移示例"注释同步为"含破坏性变更"的示例措辞。
6. 跑全量测试；特别确认既有 `tests/db-hardening.test.ts`、`tests/flags-db-override.test.ts` 等依赖建库链路的测试不回归。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test                          # 全量
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test -- tests/db-migration-discipline.test.ts  # 单跑新测试
npm run typecheck
```

- 新增测试：§1 五组（删表不复活 / 新库 dump 等价 / 漂移愈合 / 幂等 / 预演不碰原库）。
- 不需要跑：e2e、golden eval（本任务不涉及 agent 行为与 UI）。
- 注意仓库测试约定（单例/环境变量）：涉及 `getDb()` 单例的用例要用显式 `openFinanceDatabase(path)` 传参，避免污染全局单例。

## 5. 风险与开放问题

- **v0→v6 全新库会触发一次"迁移前备份"**：`runMigrations` 对 v0 库也调 backupFn，备份一个刚建的空库无害但多余。保持现状不动（改判断属于顺手优化，克制）。
- **摘除无条件 baseline 后，历史上依赖"每次启动补列"的路径**：v6 reconcile 已覆盖存量库的最后一次补列；此后如果有人违规改 baseline 而不加迁移，存量库将**真的拿不到变更**——这是有意为之（让违规立刻暴露而不是静默兜底），冻结声明+dump 等价测试就是防线。reviewer 请重点确认这个取舍成立。
- **`rehearseMigrations` 的副本磁盘占用**：与库同尺寸，放 `os.tmpdir()`，用后即删；WP1 使用前应检查磁盘余量（写进 WP1 spec，不在本期）。
- 被否决的备选：① 引入 drizzle/knex 等迁移库（现框架五个版本运转良好，引依赖违反纪律）；② 给 `MIGRATIONS` 加 down 函数（本产品退路哲学是备份恢复而非代码降级，双维护成本不值）；③ 用 schema.ts 文件哈希锁冻结（脆、误伤注释修改；集合等价测试更本质）；④ 对比 `sqlite_master` 全量 dump 字符串（对列顺序敏感易误报，改为断言名字集合，reviewer N4）。

> 计划审查记录：2026-07-06 reviewer 裁决 fix first，阻塞问题 1 条（索引数 11→24，已修正）；非阻塞 N1（rehearse 签名收已开连接+先 checkpoint，已采纳）、N2（删死 import，已采纳）、N3（v6 对新库冗余幂等执行，有意接受）、N4（黄金快照改集合断言，已采纳）。四条升级路径（v0 新库 / v1-v4 / v5 存量 / restoreDatabase 恢复）推演全部成立。修正后视为**已批准**。

## 附录 B：黄金 schema 清单的获取方式

不在本 spec 里手抄 24 个索引名（易错）。implementer 开工第一步（**在任何代码改动之前**）：用现状代码对 `:memory:` 空库跑 `initializeFinanceDatabase`，导出 `sqlite_master` 的表名集合、索引名集合与各表 `PRAGMA table_info` 列清单，落盘为 `tests/fixtures/golden-schema.json`；等价测试引用该 fixture。这样黄金快照捕获的是"改动前的真实行为"，且 fixture 本身进入评审 diff（reviewer 可核对 18 表/24 索引）。未来任何合法 DDL 迁移需要同步更新此 fixture——这正是把"结构变更必须显式过评审"落成机制。
