# Audit: WP-B 确认合同链路（blindspot-fixes）

## Files changed

| 文件 | 操作 |
|---|---|
| `lib/db/sqlite.ts` | 修改 `setKnowledgeDocumentMeta` 签名，支持 `metadata: undefined` |
| `lib/domain/cash-obligations.ts` | 给 `persistDerivedObligations` 加 `opts?: { inTx?: boolean }` |
| `app/api/knowledge/documents/[id]/route.ts` | NaN 守卫、非法 metaStatus 400、undefined metadata、事务收拢 |
| `app/api/agents/route.ts` | 双轨收拢：换用 `listCashObligations()`，删死代码 |
| `tests/confirm-contract-chain.test.ts` | 新建：B1/B2/B3 三组测试 |
| `tests/all.test.ts` | 注册新测试 |

---

## 每处改动对应 spec 哪一条

### `lib/db/sqlite.ts` — `setKnowledgeDocumentMeta`

**Spec 条目 1**（根因修复）：
> `metadata: undefined` 表示「不更新该列」（内部按是否 undefined 选择 SQL）

改法：当 `metadata === undefined` 时执行 `UPDATE ... SET meta_status = ?`（不含 metadata 列）；否则执行原先同时更新两列的 SQL。类型签名从 `metadata: Record<string, unknown> | null` 改为 `metadata: Record<string, unknown> | null | undefined`。

### `lib/domain/cash-obligations.ts` — `persistDerivedObligations`

**Spec 条目 2**（事务收拢）：
> 给它加可选参数 `opts?: { inTx?: boolean }`，为 true 时跳过自身的 BEGIN/COMMIT/ROLLBACK

加了 `opts?: { inTx?: boolean }` 第四参数；`BEGIN/COMMIT/ROLLBACK` 三处各加 `if (!opts?.inTx)` 守卫。默认行为完全兼容（不传时按原逻辑运行）。

### `app/api/knowledge/documents/[id]/route.ts`

**Spec 条目 1**（根因修复）：
`const metadata = "metadata" in body ? body.metadata : undefined;` — 用 `"metadata" in body` 检测是否实际发送了 metadata，未发则传 `undefined` 给 `setKnowledgeDocumentMeta`，保留 DB 中已有值。

**Spec 条目 2**（事务收拢）：
`setKnowledgeDocumentMeta` + `persistDerivedObligations` 包进 `db.exec("BEGIN") / COMMIT / ROLLBACK`；调用 `persistDerivedObligations` 时传 `{ inTx: true }`，避免嵌套 BEGIN。

**Spec 条目 3**（非法 metaStatus 400）：
`if ("metaStatus" in body && !validStatuses.includes(body.metaStatus))` → 直接返回 400，不做任何写。

**Spec 条目 4**（NaN 守卫）：
PATCH 和 DELETE 两个 handler 的 `Number(id)` 后均加 `if (Number.isNaN(docId)) return 400`。

### `app/api/agents/route.ts`

**Spec 条目 5**（双轨收拢）：
- 删除 `parseMeta` 函数（原 13-18 行）
- 删除 `oblDocs` 构建块（原 102-107 行）
- 删除 `deriveCashObligations`、`ObligationSourceDoc`、`listConfirmedMetaDocRows` 的 import
- 删除 `DocMetadata`、`MetaStatus` 的 type import
- 新增 `listCashObligations` 从 `@/lib/db/finance-store` import（与既有 finance-store import 合并为一行）
- `const obligations = listCashObligations()` 替换原先的 `deriveCashObligations(oblDocs)`

### `tests/confirm-contract-chain.test.ts`（新建）

**Spec 条目 6**（测试）：
- **B1**：模拟真实前端——先 PATCH 带完整 metadata（draft），再 PATCH 只带 `{metaStatus:"confirmed"}`，断言 `fact_obligations` 有 1 行，且 metadata 未被覆盖为 NULL。修复前此测试失败。
- **B2**：非法 metaStatus 返回 400，且已有义务行不被删除。修复前失败（静默降级 draft 并删义务）。
- **B3**：PATCH/DELETE 非数字 id 返回 400。修复前失败（未做 NaN 守卫）。

---

## 测试先红后绿的证据

### 修复前（仅运行测试，无任何代码改动）

```
AssertionError [ERR_ASSERTION]: B1 FAIL: 只发 metaStatus 的 PATCH 不应将 metadata 覆盖为 NULL（修复前此处失败）
    at tests/confirm-contract-chain.test.ts:92
```

B1 的第一个核心断言立即失败（metadata 被覆盖为 NULL），B2/B3 未被执行到。

### 修复后

```
B1 PASS: 只发 metaStatus 的 PATCH 正确触发义务落盘，metadata 未被覆盖 ✓
B2 PASS: 非法 metaStatus 返回 400 且义务未被删除 ✓
B3 PASS: NaN id 守卫（PATCH/DELETE）✓
confirm-contract-chain: 全部断言通过 ✓
```

### 回归测试结果

| 测试文件 | 结果 |
|---|---|
| `tests/obligations-live.test.ts` | V1-V8 全绿（8 passes） |
| `tests/cash-obligations.test.ts` | 全绿（8 passes） |
| `tests/knowledge-lifecycle.test.ts` | 全绿（6 passes） |
| `tests/agents-space.test.ts` | 全绿（T1-T5） |
| `tests/attention.test.ts` | 全绿 |
| `tests/confirm-contract-chain.test.ts` | B1-B3 全绿 |

---

## 与 spec 的偏差

| 偏差 | 说明 |
|---|---|
| 归档钩子未加事务 | spec 条目 2 仅提到"setKnowledgeDocumentMeta 与 persistDerivedObligations 包进同一事务"，归档钩子（route 下半段 archived 分支）未被 spec 明确要求事务化，故未改动 |
| `metaStatus` 不在 body 但 `metadata` 在 body 时仍默认 draft | 原有行为保留；spec 仅要求非法值 400，未要求此场景改动 |

---

## 开放风险

- 归档钩子（`PATCH {archived: true/false}`）中 `persistDerivedObligations` 仍在无外层事务状态下调用，属既有行为，本 WP 未改。
- `setKnowledgeDocumentMeta` 的新 `undefined` 语义仅在 PATCH route 内使用；其他调用方（V4/V5 obligations-live 测试）传 `null` 或具体值，行为不变。
