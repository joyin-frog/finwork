# Audit: WP-C 语义检索可用性（blindspot-fixes）

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/knowledge/embed-model.ts` | 修改 |
| `lib/knowledge/embeddings.ts` | 修改 |
| `app/api/knowledge/reindex/route.ts` | 修改 |
| `app/knowledge/page.tsx` | 修改 |
| `tests/semantic-search.test.ts` | 修改 |

`lib/knowledge/rg-search.ts` 列于 Files touched 但无需修改：`vectorSearch` 新增 `model` 可选参数（默认 `EMBED_MODEL`），`rg-search.ts:141` 调用 `vectorSearch(db, queryVecResult, topK * 2)` 无需改动即可自动获得正确的 `EMBED_MODEL` 过滤行为。

---

## 逐条对照

### 条目 1：接线模型下载（`ensureEmbedModel` 可选 `download` + 内置实现）

- **`embed-model.ts`**：
  - 新增 `builtinDownload: DownloadStep`（fetch，AbortController，120s 超时）。
  - `ensureEmbedModel` 签名由 `opts: { download: DownloadStep; ... }` 改为 `opts?: { download?: DownloadStep; ... }`，缺省用内置实现。
  - 下载完成后写 `manifest.json`（各文件字节数）。
- **`app/api/knowledge/reindex/route.ts`**：
  - 开头 `await ensureEmbedModel()`，`ok: false` 时提前返回 `{ ok: true, modelUnavailable: true, indexed: 0, skipped: 0, failed: 0 }`。

### 条目 2：响应区分

- **`app/api/knowledge/reindex/route.ts`**：响应加 `modelUnavailable: true` 字段，与 `skipped` 区分。
- **`app/knowledge/page.tsx:326`**：toast 增加 `else if (json.modelUnavailable)` 分支，显示"嵌入模型不可用，语义索引未更新（仍可使用全文检索）"。

### 条目 3：异步化 `embeddings.ts:27` `execFileSync`

- 删除 `execFileSync` import。
- 新增 `spawnWithInput` 辅助函数（`spawn` + 手动 stdin 管道 + 超时 + maxBuffer 守卫），替代 `execFileSync(... {input})`。
- `defaultEmbedRunner` 改用 `spawnWithInput`，真正非阻塞，让 `rg-search.ts:98` 的 `Promise.all` 真并行。
- **偏差说明**：spec 写 "execFile（promisify）" 但 `promisify(execFile)` 的 TypeScript 类型不含 `input` 选项（stdin 注入在 execFileSync 专属 API）；用 `spawn` 实现等效异步目标，且更正确。

### 条目 4：完整性校验（manifest）

- `isEmbedModelReady()`：若 `manifest.json` 存在，验证各文件字节数与 manifest 一致；不一致视为未就绪。若无 manifest（用户手动放置），仅存在性检查（向后兼容）。
- `ensureEmbedModel()` 下载成功后写 `manifest.json`。

### 条目 5：model 列过滤

- `vectorSearch` 新增 `model = EMBED_MODEL` 参数，SQL 加 `AND ke.model = ?`。
- `rg-search.ts:141` 调用无需改动（第四参数缺省即 `EMBED_MODEL`）。

### 条目 6：并发守卫

- `app/api/knowledge/reindex/route.ts`：模块级 `let reindexInFlight = false`；POST 开头检查，并发返回 409；`finally` 块重置。

### 条目 7：测试

- **T4 假绿修正**（原 line 172）：vectorHits 补 `chunkIndex: 1`；新增向量独有命中 docId=3（chunkIndex=2），断言 `lineNo = 3`（非 NaN）。
- **T5 类型修正**：`emptyVec` 类型注解补 `chunkIndex: number`（因 `mergeRrfResults` 签名已更新）。
- **T9 修正**：`vectorSearch(db9, queryVec, 20, "test")` 显式传 model，避免 EMBED_MODEL 过滤排除测试数据。
- **T10 修正**：同 T9。
- **T11（新）**：ensureEmbedModel mock download（不打网络）→ `ok:true`；manifest 写入验证；失败 download → `ok:false`；无 manifest 手动放置场景放行。
- **T12（新）**：`vectorSearch` model 过滤——`model-a` 命中，`nonexistent-model` 无结果。
- **T13（新）**：并发 POST reindex → 一个 409。
- 总数从 10 → 13。

---

## 测试先红后绿

在实施前运行（保留 T1-T10 通过，新加 T11/T12/T13 直接 RED）：

```
T11: AssertionError: T11 FAIL: 下载后应生成 manifest.json  (exit 1)
```
（T12/T13 因 T11 提前退出未执行，逻辑分析确认二者在当时亦为 RED：T12 的"nonexistent-model 无结果"断言因无模型过滤而失败；T13 因无 in-flight 守卫两次 POST 均非 409。）

实施后：
```
semantic-search: all 13 checks passed ✓  (exit 0)
```

---

## `npx tsc --noEmit` 结果

- `lib/knowledge/embed-model.ts`：无错误。
- `lib/knowledge/embeddings.ts`：无错误（`execFileSync` 替换后 TS2769 消除）。
- `app/api/knowledge/reindex/route.ts`：无错误。
- `app/knowledge/page.tsx`：无错误。
- `tests/semantic-search.test.ts`：`TS5097`（`.ts` 扩展名，全测试套件共同的预存在错误，本批不引入）；无其他错误。

全仓 `npx tsc --noEmit` 所有实质错误（非 TS5097/TS2775）均为本批前已存在，WP-C 未引入新错误。

---

## 偏差与理由

1. **`execFile + promisify` → `spawn + spawnWithInput`**：`promisify(execFile)` TypeScript 类型不支持 `input` 选项（stdin 注入），改用 `spawn` 实现等效异步目标，代码更正确且有 maxBuffer 守卫。
2. **`rg-search.ts` 无改动**：spec 列于 Files touched，但 `vectorSearch` 的新 `model` 默认参数让 `rg-search.ts:141` 调用无需改动，符合"最小改动"原则。

---

## 开放风险

- `builtinDownload` 在国内网络下 hf-mirror.com 可能超时；但三级候选源（自托管 URL > hf-mirror > huggingface）+ 超时失败即返回 `modelUnavailable` 不影响全文检索，可接受。
- `reindexInFlight` 是模块级变量：Next.js 开发模式热重载或多进程时可能在不同模块实例中各有一份（竞态无法跨进程）；生产单进程场景下正确，符合 spec 意图。
