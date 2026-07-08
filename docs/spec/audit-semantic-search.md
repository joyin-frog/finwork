# Audit: semantic-search (WP12)

> 实施日期：2026-07-07 | 实施者：implementer (claude-sonnet-4-6)

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/db/migrations.ts` | 修改：追加 v11 `knowledge_embeddings` 迁移 |
| `lib/knowledge/chunker.ts` | 新增：`chunkText` 纯函数（段落边界 / 400 窗口 / 80 重叠） |
| `lib/knowledge/embed-model.ts` | 新增：模型下载/路径解析，步骤注入，候选源 env/hf-mirror/hf-raw |
| `lib/knowledge/embeddings.ts` | 新增：embedTexts / cosine / vectorSearch / rrfScore / mergeRrfResults / storeEmbeddings / deleteEmbeddings / getDocIdsWithEmbeddings |
| `lib/knowledge/pipeline.ts` | 修改：ingest 追加嵌入阶段（embedRunner 注入 + 失败静默降级）+ deleteDocument 兜底显式清 embeddings |
| `lib/knowledge/rg-search.ts` | 修改：searchKnowledge 并行 rg + 向量路，RRF 融合 |
| `workers/finance_worker.py` | 修改：新增 `cmd_embed_texts` + `embed-texts` 命令分发 |
| `requirements.txt` | 修改：追加 `onnxruntime==1.19.2` + `tokenizers==0.20.3` |
| `app/api/knowledge/reindex/route.ts` | 新增：POST /api/knowledge/reindex |
| `app/knowledge/page.tsx` | 修改：reindexing state + doReindex handler + 重建语义索引按钮 |
| `lib/runtime/flags.ts` | 修改：删 4 死旗标（RAG_RERANK / MEMORY_AUTO_EXTRACT / TOOL_IDEMPOTENCY / SDK_RETRY） |
| `scripts/knowledge-reset.mjs` | 修改：移除 sqlite-vec import / loadExtension / knowledge_vec DROP，改清 knowledge_embeddings |
| `tests/semantic-search.test.ts` | 新增：8 个测试 T1-T8 |
| `tests/feature-flags.test.ts` | 修改：换存活旗标名，总数断言 8→4 |
| `tests/fixtures/golden-schema.json` | 修改：新增 knowledge_embeddings 表/索引/列 |
| `tests/all.test.ts` | 修改：末尾注册 semanticSearchTestPromise |
| `tests/artifact-checklist.test.ts` | 修改（计划外）：将 `LATEST_VERSION === 10` 改为 `LATEST_VERSION >= 10` |

---

## 逐条成功标准核实

### v11 knowledge_embeddings
- **红态证据**：测试注册前运行套件，semantic-search.test.ts 中的 T1 因找不到模块而预期失败（import 阶段）。
- **绿态**：T1 PASS — 迁移后表存在、所有必填列存在、CASCADE 删 knowledge_documents → embeddings 行清除（EXIT=0）。
- golden-schema.json 同步：新增 `knowledge_embeddings` 表名、`idx_knowledge_embeddings_doc` 索引、7 列列清单；db-migration-discipline T2 (golden-schema等价) 绿。

### worker embed-texts
- **真实 worker 验证**：
  - 不存在 model_dir → `{"ok": false, "error": "model_not_found"}` ✓
  - onnxruntime=1.27.0（venv 已有）、tokenizers=0.23.1 安装成功，模块 import 路径通；dummy 文件 → `{"ok": false, "error": "embed_error: ..."}` ✓（import 成功，模型加载失败为预期）
  - hf-mirror 上 `model_quantized.onnx` 404（BAAI/bge-small-zh-v1.5 无 ONNX 版本在主分支），因此降级为"model_not_found 层次验证"，模型链路留待带 key 验收（与 spec §4 约定一致）。

### chunkText
- T2 PASS：空文本 → `[]`；短文本 → 单 chunk；超长段落 → ≥2 块且相邻块有重叠 ✓

### ingest 接线
- T3 PASS：注入失败 runner → ingestDocument 仍成功返回 documentId，knowledge_embeddings 零行 ✓

### 混合检索
- T4 PASS：`rrfScore(1,60) = 1/61 ✓`；`mergeRrfResults` 空向量 → 纯 rg 结果 ✓
- T5 PASS：空向量路 → `mergeRrfResults` 不报错 ✓
- 现有 rg-search 相关测试（knowledge-search-title / knowledge-query / knowledge-lifecycle 等）全部 PASS（EXIT=0 全量测试确认），回归防线绿 ✓

### reindex
- T6 PASS：`app/api/knowledge/reindex/route.ts` 导出 `POST` 函数 ✓
- 路由返回 `{ ok, indexed, skipped, failed }` 结构 ✓

### 死旗标清理
- flags.ts 删 11-14 行四旗标（RAG_RERANK_ENABLED / MEMORY_AUTO_EXTRACT_ENABLED / TOOL_IDEMPOTENCY_ENABLED / SDK_RETRY_ENABLED）✓
- feature-flags.test.ts 改用 PROMPT_CACHE_ENABLED / SESSION_LIVENESS_CHECK_ENABLED 等存活旗标，总数断言 `8 → 4` ✓
- 全仓 grep `RAG_RERANK|MEMORY_AUTO_EXTRACT|TOOL_IDEMPOTENCY|SDK_RETRY` 零残留 ✓

### knowledge-reset.mjs
- **红态（修前）**：`import * as sqliteVec from "sqlite-vec"` 模块加载即崩（sqlite-vec 未安装）。
- **绿态（修后）**：T8 PASS — 对不存在的 DB 路径脚本正常退出（status=0，无 Error 输出）✓

### 测试注册 + 全量
- all.test.ts 末尾追加 semanticSearchTestPromise ✓
- 全量 EXIT=0，无 unhandledRejection，11 pass 0 fail ✓
- `npm run typecheck` EXIT=0 ✓
- `npm run lint` EXIT=0，0 errors ✓

---

## 计划外改动说明

**`tests/artifact-checklist.test.ts`**（不在 spec Files touched 列表中）：
该文件有一行 `assert.equal(LATEST_VERSION, 10, ...)` 用作 WP14a 的开工守卫。新增 v11 迁移后 LATEST_VERSION=11，此断言会产生 unhandledRejection。spec 明言 "LATEST_VERSION 系数组末位动态推导，加 v11 后自动升位、无硬编码需改" — 此改动正是该设计意图的延伸。将断言从 `=== 10` 改为 `>= 10`（1 行），不影响该测试的实质语义（仍守卫 v10 artifacts 功能已落地），与 spec 一致。

---

## lint 警告数变化

- 基准：138 warnings（0 errors）
- 提交后：140 warnings（0 errors）
- 净增 2 warnings：均来自 `app/knowledge/page.tsx` 新增的"重建语义索引"按钮（`rounded-md` 触发 WP8 Surface 护栏，与页面所有既有 `<button>` 的同款 2-warning 对完全一致）。spec 要求"复用页面既有按钮写法"，页面既有按钮写法本身产生此 2-warning 对；不引入新类别警告，lint EXIT=0 不变。

---

## 开放风险

- 查询侧冷加载延迟：embed query 每次 spawn worker，含模型加载约 1-2s（spec §5 已知并接受）。
- requirements.txt 新增 onnxruntime（~60MB）加重 pip 安装时间（spec §5 已知并接受）。

---

## 修复轮：HF_REPO 路径修正（2026-07-07）

### 本轮 Files changed 增量

| 文件 | 动作 |
|---|---|
| `lib/knowledge/embed-model.ts` | 修改：`HF_REPO` 从 `BAAI/bge-small-zh-v1.5` 改为 `Xenova/bge-small-zh-v1.5`；新增 `HF_REMOTE_PATH` 映射表区分子目录（`model_quantized.onnx` → `onnx/model_quantized.onnx`，`tokenizer.json` → `tokenizer.json`） |
| `tests/semantic-search.test.ts` | 修改：T7 改为断言 Xenova 仓库路径 + `onnx/` 子目录形状 |
| `docs/spec/audit-semantic-search.md` | 修改：本节追加 |

### 红态证据

T7 测试在修改前 AssertionError 输出（实测红态）：
```
AssertionError [ERR_ASSERTION]: T7 FAIL: tokenizer.json 候选源应用 Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json，
实际: ["https://hf-mirror.com/BAAI/bge-small-zh-v1.5/resolve/main/tokenizer.json",
       "https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/tokenizer.json"]
```

### 绿态

全量 `npm test` EXIT=0，11 pass，0 fail，**零 unhandledRejection**。
`npm run typecheck` EXIT=0；`npm run lint` EXIT=0，140 warnings（0 errors）— 与上轮相同。

### 真实 worker 端到端验证

模型文件下载（hf-mirror Xenova 路径，HTTP 200 已验证）：
- `tokenizer.json`：439 125 bytes ✓
- `model_quantized.onnx`：24 010 842 bytes（~24MB）✓

embed-texts 命令真实调用，三段文本（"发票怎么开" / "如何开具发票" / "今天天气不错"）：
- `ok: true`，`dim: 512` ✓
- `cosine(发票怎么开, 如何开具发票) = 0.9136`
- `cosine(发票怎么开, 今天天气不错)  = 0.3009`
- `cosine(如何开具发票, 今天天气不错) = 0.2510`
- 断言：语义相似对 0.9136 >> 无关对 0.30/0.25，**ASSERTION PASSED** ✓

模型加载运行时：onnxruntime 1.27.0，tokenizers 0.23.1（主仓 venv）。

---

## 第二修复轮：reviewer fix-first 五项（2026-07-07）

### Files changed 增量

| 文件 | 动作 |
|---|---|
| `lib/knowledge/embeddings.ts` | 修改：vectorSearch SQL 加 `chunk_index` 列、JOIN `knowledge_documents WHERE archived=0`；返回类型增 `chunkIndex` 字段；mergeRrfResults 参数类型同步，lineNo 改为 `vh.chunkIndex + 1` |
| `lib/knowledge/rg-search.ts` | 修改：`vectorHits` 本地类型标注补 `chunkIndex: number` |
| `lib/knowledge/embed-model.ts` | 修改：`MODEL_NAME` 常量改为 `export const EMBED_MODEL` 单一来源 |
| `lib/knowledge/pipeline.ts` | 修改：移除本地 `const EMBED_MODEL`，改从 `./embed-model` 导入 |
| `app/api/knowledge/reindex/route.ts` | 修改：移除本地 `const EMBED_MODEL`，改从 `@/lib/knowledge/embed-model` 导入 |
| `requirements.txt` | 修改：`onnxruntime==1.19.2` → `1.27.0`；`tokenizers==0.20.3` → `0.23.1` |
| `tests/semantic-search.test.ts` | 修改：T3 移除 try/catch 兜底 + 删未使用 `embeddingsModule` import（N1）；新增 T9（B1 lineNo）、T10（N4 archived 过滤）；删未使用顶层 `DatabaseSync` import |

### B1 红态证据

修改前运行 `npm test`，T9 触发 unhandledRejection：

```
# Error: A resource generated asynchronous activity after the test ended. This activity created the error
"AssertionError [ERR_ASSERTION]: T9 FAIL: lineNo 应为 2（chunk_index=1），实际 chunkIndex=undefined\n\nNaN !== 2\n"
which triggered an unhandledRejection event, caught by the test runner.
# tests 11
# pass 11
# fail 0
EXIT=0
```

注：tap 计数显示 pass=11/fail=0，但 unhandledRejection 已在输出中明确报告——正是此红态需要捕获的形式。

### 绿态

全量 `npm test` EXIT=0，11 pass，0 fail，**零 unhandledRejection**：

```
semantic-search T9 PASS: vectorSearch 返回 chunkIndex=1（lineNo=2）✓
semantic-search T10 PASS: archived 文档不出现在向量检索结果 ✓
semantic-search: all 10 checks passed ✓
# tests 11  pass 11  fail 0
EXIT=0
```

`npm run typecheck` EXIT=0；`npm run lint` EXIT=0，140 warnings（0 errors）— 与上轮相同。
