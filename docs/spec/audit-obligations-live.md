# Audit: WP1b 义务落盘消费切换（obligations-live）

> 注：本 audit 由收尾者（claude-sonnet-4-6）核对后编写。前任 implementer 连接中断死亡，大部分实施工作已落盘，本次收尾补全三处缺口并修复测试设计问题。

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v9 迁移：补两处 IF EXISTS 守卫（fact_obligations 表存在检查、knowledge_documents 表存在检查），防止 policy-rules.test.ts PR-B1 模式（PRAGMA user_version 伪造版本号）触发 unhandledRejection |
| `lib/db/finance-store.ts` | 前任已修改（本次核对） | listCashObligations 已实现 |
| `lib/domain/cash-obligations.ts` | 前任已修改（本次核对） | persistDerivedObligations 已适配 v9 新列清单 |
| `app/api/cockpit/summary/route.ts` | 前任已修改（本次核对） | 读切换已完成 |
| `app/api/knowledge/documents/[id]/route.ts` | 前任已修改（本次核对） | 四路钩子（PATCH confirmed/降级/归档/取消归档）已实现 |
| `lib/knowledge/pipeline.ts` | 前任已修改（本次核对） | deleteDocument 清行已实现 |
| `lib/db/sqlite.ts` | 核对：归档钩子在 PATCH route（非 setKnowledgeArchived 内部） | 见下方说明 |
| `scripts/knowledge-reset.mjs` | 修改 | 补 `DELETE FROM fact_obligations`（gap ③） |
| `tests/fixtures/golden-schema.json` | 修改 | fact_obligations 条目更新为 v9 新列形状（gap ①） |
| `tests/obligations-live.test.ts` | 修改 | 补 MIGRATIONS import；修复 V2 测试（改用手动逐条执行 v1-v8，而非 runMigrations 全量）；修正 V1 索引名断言（src_doc vs source_document） |
| `tests/all.test.ts` | 前任已修改（本次核对） | obligations-live 已注册 |

## 与计划的偏差说明

**gap ② setKnowledgeArchived 钩子位置**：spec §2 说"若归档函数在别处，以现场为准并报告"。前任 implementer 将归档/取消归档钩子实现在 `app/api/knowledge/documents/[id]/route.ts` PATCH 处理器中（lines 57-74），而非 `setKnowledgeArchived` 内部。该路径（PATCH route → setKnowledgeArchived + 显式 DELETE/re-derive）在语义上等价，且避免了向 sqlite.ts 引入对 cash-obligations.ts 的依赖。本次核对确认路由层钩子完整，不重复实现在 sqlite.ts 内部，符合 spec 的豁免条款。

**v9 迁移守卫补充**：前任 implementer 的 v9 迁移在 `fact_obligations` 表存在检查和 `knowledge_documents` 表存在检查方面存在遗漏，导致 policy-rules.test.ts PR-B1 测试（手动 PRAGMA user_version=7 伪造版本号，不含实际 DDL）触发 unhandledRejection。本次在 v9 迁移前两处各加 sqlite_master 查询守卫，符合迁移"幂等"原则。

**V2 测试修复**：obligations-live.test.ts V2 测试的注释写"建到 v8 但不含 v9"，但实际代码调用 `runMigrations`（包含 v9），导致 v9 在插入文档之前就已运行（回填为空）。本次改为手动遍历 `MIGRATIONS.filter(m => m.version <= 8)` 逐条执行，精确还原"v8 完成、v9 待运行"的状态，使 v9 回填测试有实际文档可回填。

**V1 索引断言修复**：V1 测试检查 `source_document_id` 索引是否存在，用 `includes("source_document")` 匹配，但实际索引名为 `idx_fact_obligations_src_doc`（含 `src_doc`）。改为同时接受 `src_doc` 或 `source_document`。

## 逐条成功标准核对

### SC1：v9 obligations_reshape 迁移（warn+DROP 语义、新表形状、索引、回填）
**结果：✓**

- v9 迁移已实现：表存在时 console.warn 行数后照常 DROP；新表列清单（kind/amount_cents NULL/due_date NOT NULL/status_raw/source_doc/recurrence/source_document_id NOT NULL/settlement_status/source/provenance/derived_at）与 spec §1 完全匹配
- 两个索引：`idx_fact_obligations_due`（due_date）、`idx_fact_obligations_src_doc`（source_document_id）
- 迁移内回填：读 confirmed 文档 → deriveCashObligations → INSERT（V2 测试绿）
- golden-schema.json 已同步新列形状（T2 测试绿）
- 补加两处守卫防幽灵迁移失败

### SC2：persistDerivedObligations INSERT 适配新列清单 + 精度校验
**结果：✓**

- INSERT 语句目标列：`(kind, amount_cents, due_date, counterparty, status, status_raw, source_doc, recurrence, source_document_id, settlement_status, source, provenance, derived_at)`
- kind 映射：付款→pay / 收款→receive / 开票→invoice
- amount undefined→NULL（非 0）
- status_raw 存原始中文状态
- 0.005 精度校验超差抛错
- V3 测试绿

### SC3：写钩子四路全覆盖
**结果：✓（钩子在 PATCH route，非 setKnowledgeArchived 内部，见偏差说明）**

- PATCH metaStatus=confirmed → 重派生落盘（V4 绿）
- PATCH 改为 none/draft → DELETE 该文档行（V5 绿）
- deleteDocument → DELETE（V6 绿，pipeline.ts:86）
- archived=true → DELETE（PATCH route:59）；archived=false → 重派生（PATCH route:61-73）（V7 绿）

### SC4：finance-store listCashObligations 读写等价性
**结果：✓**

- 函数签名：`listCashObligations(db: DatabaseSync = getDb()): CashObligation[]`
- kind 映射回中文、status 返回 status_raw、amount NULL→undefined、done=status==='settled'、sourceDoc 直读 source_doc
- 等价性测试：amount 用 |a-b|<0.005、其余字段严格相等（V8 绿）

### SC5：summary route 切换
**结果：✓**

- app/api/cockpit/summary/route.ts line 22: `const obligations = listCashObligations()`
- 删除了 derive 调用，改用读表
- 响应形状不变（既有 cockpit/attention 测试不改断言跑绿，finance-summary: all 3 checks passed ✓）

### SC6：全量 EXIT=0 零 unhandledRejection + typecheck + lint
**结果：✓**

```
EXIT=0
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
obligations-live: all 8 checks passed ✓
TC_EXIT=0
LINT_EXIT=0  (0 errors, 181 pre-existing warnings)
```

## 开放风险

- **policy-rules.test.ts PR-B1 脆性模式**：该测试手动设置 PRAGMA user_version=7 而不运行 v7 DDL，v9 迁移对此模式现在有守卫，但未来添加其他依赖存量表的迁移时需注意同类风险。建议后续将 PR-B1 改为显式运行 v1-v7 migrations 而非 PRAGMA 伪造。
- **归档钩子事务原子性**：spec §5 记录了"PATCH 路径建议 setKnowledgeDocumentMeta 与 persist 同事务（原子性）"。当前实现是顺序执行，非同事务。失败面为极小窗口的表滞后，读侧无损坏，与 spec 风险记录一致。
- **setKnowledgeArchived 内部无钩子**：若未来有不经过 PATCH route 调用 setKnowledgeArchived 的路径（如直接调用 sqlite.ts 函数），归档钩子不会触发，存在悬空义务行风险。

---

## Fix 轮记录（审查后修复）

### 阻塞 B1：V6 假绿（deleteDocument 未被调用）

**问题**：V6 import 了 `deleteDocument` 但从未调用它；两处裸 SQL DELETE 替代了真实钩子，使得钩子缺失时测试仍绿。

**修法选择**：真实调用（方案 a）。

**隔离机制**：设 `FINANCE_AGENT_DB_PATH = tmpDb("v6-delete")`，`getDb()` 检测路径变化后重开，`deleteDocument` 内部的 `getDb()` 与测试侧同库。

**红态证据**（临时注释 pipeline.ts:86 的 DELETE 行）：
```
AssertionError [ERR_ASSERTION]: V6 FAIL: deleteDocument 后 fact_obligations 应清行，实际 1
1 !== 0
```
→ unhandledRejection，测试红。

**还原后**：V6 PASS，全套 EXIT=0，pipeline.ts 零改动（git diff 确认）。

### 阻塞 B2：V7 假绿（归档钩子 PATCH handler 未被调用）

**问题**：V7 用裸 SQL `db.prepare("DELETE ...").run(docId)` 替代真实 PATCH route 钩子；归档方向、取消归档方向均绕过实现。

**修法选择**：真实调用 PATCH handler（方案 a）。

**实现**：import `PATCH` from `app/api/knowledge/documents/[id]/route.ts`，构造合成 `Request`，以 `{ params: Promise.resolve({ id: String(docId) }) }` 调用，分两次断言（archived=true 清行、archived=false 重派生）。

**Next.js 15 params Promise 兼容**：handler 签名 `{ params: Promise<{ id: string }> }` 可直接传 `Promise.resolve({ id: "..." })`，无 Next.js runtime 依赖，测试环境可用。

**红态证据**（临时将 route.ts 归档分支改为 `if (false && body.archived)`）：
```
AssertionError [ERR_ASSERTION]: V7 FAIL: 归档后应清行，实际 1
1 !== 0
```
→ unhandledRejection，测试红。

**还原后**：V7 PASS，全套 EXIT=0，route.ts 零改动（git diff 确认仅有前任 implementer 的预存改动）。

### 最终验证

```
EXIT=0
# tests 11
# pass 11
# fail 0
obligations-live: all 8 checks passed ✓
```

**Files changed（fix 轮）**：
- `tests/obligations-live.test.ts`：V6 改为真实调用 `deleteDocument`（FINANCE_AGENT_DB_PATH 隔离）；V7 改为真实调用 PATCH handler（合成 Request，params Promise）
- `docs/spec/audit-obligations-live.md`：追加本 fix 轮记录
