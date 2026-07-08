# 知识库语义检索（WP12：本地 embedding + 混合排序 + 死旗标清理）Spec

> 版本 v1.1 / 2026-07-07（v1.0 fix first：B1 worker 协议误述已修，N1-N5 采纳）
> 状态：**已实施并通过审查（ship）**（2026-07-07；实施后两轮修复：orchestrator 验收抓出默认模型源 404（BAAI→Xenova 仓）、实施审查抓出块序号写死 B1 + 归档过滤 N4 等四项；真实模型端到端验证余弦 0.91/0.30 分离）
> 依赖：无（迁移版本 v11；当前末条 version:10 已核实 migrations.ts:684，LATEST_VERSION 系数组末位动态推导 :712，加 v11 后自动升位、无硬编码需改）
> 架构事实（2026-07-07 scout + orchestrator 精读核实）：
> - 检索现状**纯 ripgrep**：`lib/knowledge/rg-search.ts` `searchKnowledge()`（--fixed-strings，0 命中时 P3 CJK 2-gram OR 兜底重试）；MCP 入口 `search_knowledge`（registry.ts:26 safe）/`query_knowledge`（medium，沙箱多步）；HTTP `app/api/knowledge/search/route.ts`；UI `app/knowledge/page.tsx`。
> - ingest：`lib/knowledge/pipeline.ts` `ingestDocument` 解析后仅写文本镜像 `<appData>/knowledge/<hash>.txt`，`chunk_count` 恒 0（pipeline.ts:57 注释自认）。
> - **历史包袱：曾有 RAG 实现被整体退役**——schema.ts:192-199 baseline 内 DROP legacy 表（knowledge_chunks / knowledge_chunks_fts / knowledge_query_log / memory_entries）+ 清 app_settings `knowledge_embed_dim`；`scripts/knowledge-reset.mjs:12,38-39,45` 引用 **sqlite-vec（未安装、不在 package.json——scout"依赖已存在"断言证伪）** 与 knowledge_vec 表，系幽灵引用，该脚本今日运行必崩。
> - Python worker：`workers/finance_worker.py` **按 `sys.argv[1]` 命令名分发**（main() :639-670，无 stdin cmd 路由层）；带 payload 的命令（export-voucher-xlsx :499、export-payslips-xlsx :580）经 stdin 传 JSON body（**body 内无 cmd 字段**）；**每调用 spawn**（lib/knowledge/parsers/index.ts:137 execFileSync 先例），无常驻进程；requirements.txt 全是文档解析库，零向量依赖。生产 Python 分发 = python-build-standalone 运行时下载 + pip install requirements.txt（lib/runtime/python-installer.ts，已有多候选源镜像先例：FINANCE_AGENT_PYTHON_ASSET_URL / FINANCE_AGENT_GH_PROXY）。
> - ripgrep 生产已内置（lib/knowledge/rg-binary.ts 三级降级：env → Tauri bin/rg → @vscode/ripgrep）。
> - node:sqlite 支持 loadExtension 但须构造时 `allowExtension: true`，主库 `openFinanceDatabase` 未开启。
> - 死旗标：`lib/runtime/flags.ts:11-14` 四个（RAG_RERANK / MEMORY_AUTO_EXTRACT / TOOL_IDEMPOTENCY / SDK_RETRY，均标 "defined, not wired"），生产代码零消费（全仓 grep 证实）；`tests/feature-flags.test.ts:21-24,37,41-44,64-79` 以这四个名字做断言——删旗标须同步重写该测试（改用存活旗标 ROUTER_ENABLED / PROMPT_CACHE_ENABLED 等，断言语义不变）。
> - 迁移纪律哨兵：tests/db-migration-discipline.test.ts（T1 删表不复活 + T2 golden-schema 等价）；golden-schema 位于 tests/fixtures/golden-schema.json；tests/all.test.ts 手动注册（末尾追加）。

## 0. 目标与非目标

**目标**：知识库检索从"字面命中"升级为"字面 + 语义混合"：① v11 `knowledge_embeddings` 表；② Python worker 新增 `embed_texts` 命令（本地量化 bge-small-zh-v1.5 ONNX，512 维）；③ ingest 时切块嵌入落库（失败静默降级不阻断入库）；④ `searchKnowledge` 升级为 rg + 向量余弦的 RRF 融合，语义层不可用时**行为与现状逐字节等价**；⑤ `POST /api/knowledge/reindex` + knowledge 页"重建语义索引"按钮（补齐存量文档）；⑥ 顺带清 4 个死旗标；⑦ 修 knowledge-reset.mjs 幽灵引用。

**非目标**：ANN 索引/sqlite-vec（见被否决）；常驻 embed 进程（v1 接受查询冷加载延迟）；rerank 模型（bge-reranker 是另一档复杂度）；query_knowledge 沙箱路径改造（它面向 agent 多步正则，保持 rg）；memory_entries 等其他 legacy 表复活；UI 检索交互改版。

## 1. 成功标准（先红后绿）

- [ ] **v11 `knowledge_embeddings`**：`id INTEGER PK AUTOINCREMENT · document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE · chunk_index INTEGER NOT NULL · text TEXT NOT NULL · embedding BLOB NOT NULL(Float32 小端 512 维) · model TEXT NOT NULL · created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`；`UNIQUE(document_id, chunk_index)`；索引 document_id。**表名刻意避开 legacy `knowledge_chunks`**（baseline 192-199 行有其 DROP，撞名会与删表不复活守卫互咬）。golden-schema 同步；级联删除断言（删 knowledge_documents 行 → embeddings 行清除）进新测试。
- [ ] **worker `embed-texts`**：以 `sys.argv[1] == "embed-texts"` 分发（对齐 export-voucher-xlsx 先例），payload 经 `sys.stdin.read()` 传 JSON `{texts:[...], model_dir:"<路径>"}`（**body 无 cmd 字段**）；Node 侧调用照 execFileSync(getPythonPath(), [workerPath, "embed-texts"]) 既有模式；出参 stdout JSON `{ok:true, dim:512, vectors:[[...f32]...]}`；onnxruntime + tokenizers 加入 requirements.txt（版本 pin，与既有风格一致）；模型文件缺失时返回 `{ok:false, error:"model_not_found"}`（结构化错误，不是 traceback）。**模型不内置仓库**：运行时下载到 `<appData>/models/bge-small-zh-v1.5/`（model_quantized.onnx + tokenizer.json），候选源照 python-installer 先例——`FINANCE_AGENT_EMBED_MODEL_URL`（整条自托管 URL，最高优先）→ hf-mirror.com → huggingface.co 裸源；下载逻辑放 Node 侧（lib/knowledge/embed-model.ts，可注入步骤便于单测，参照 python-installer.ts 模式）。
- [ ] **切块**：纯函数 `chunkText(text)`（~400 字窗口 / 80 字重叠 / 段落边界优先），单测覆盖空文本/短文本/超长段落三边界。
- [ ] **ingest 接线**：`ingestDocument` 在文本镜像写入后追加"建立语义索引"阶段——chunk → embed → 落库；嵌入步骤经**可注入函数**走（embeddings.ts 的 embedTexts 接受可选 runner 覆盖，默认真 worker；复审 N5）——**任何一步失败（无 python/无模型/worker 崩）只记 console.warn 并继续，入库结果与现状一致**（降级断言进测试：注入失败 runner，ingest 仍成功且 knowledge_embeddings 零行）。重复 ingest：hash 变化 → 先 DELETE 旧 embeddings 再重嵌；**hash 不变 → embeddings 保留不动**（内容未变，缺失场景由 reindex 兜底；复审 N4）。
- [ ] **混合检索**：`searchKnowledge` 内部并行跑 rg 与向量路（embed query → 全表余弦 → 文档级最高分聚合），**RRF（k=60）融合两路文档排名**；向量路任何失败或 knowledge_embeddings 空表 → 纯 rg 结果原样返回（现有 rg-search 相关测试零改动跑绿即为回归防线）；返回 shape 向后兼容（SearchFile 结构不变；**语义命中映射为 SearchMatch：`lineNo = chunk_index + 1`、`line = chunk 文本片段`、`before/after = []`**——mcp-tools/knowledge.ts:53-57 的 `L${lineNo}:` 格式化对 LLM 呈现为块序号，复审 N3）。余弦在 JS 侧暴力扫（Float32Array，数千 chunk 规模 <10ms，无需 ANN）。
- [ ] **reindex**：`POST /api/knowledge/reindex` 对无 embeddings 的活跃文档补嵌入，返回 `{indexed, skipped, failed}`；knowledge 页加"重建语义索引"按钮（Surface/token 规范，复用页面既有按钮风格）。
- [ ] **死旗标清理**：flags.ts 删 11-14 行四旗标；tests/feature-flags.test.ts 改用存活旗标重写同语义断言（不删测试场景，只换旗标名），**含 :86 的旗标总数断言 `8 → 4`（数字断言易漏，复审 N1）**；全仓 `rg "RAG_RERANK|MEMORY_AUTO_EXTRACT|TOOL_IDEMPOTENCY|SDK_RETRY"` 零残留。
- [ ] **knowledge-reset.mjs**：删 sqlite-vec import / loadExtension / knowledge_vec DROP，改清 knowledge_embeddings；冒烟=对不存在的 DB 路径跑一遍脚本正常退出（**今日现状因幽灵 import 在模块加载即崩，修后即绿——天然红绿对照，复审 N2**）。
- [ ] 测试注册 all.test.ts 末尾；全量 EXIT=0 零 unhandledRejection + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v11 knowledge_embeddings（开工验证末尾是 v10） |
| `lib/knowledge/chunker.ts` | 新增 | chunkText 纯函数 |
| `lib/knowledge/embed-model.ts` | 新增 | 模型下载/路径解析（可注入步骤） |
| `lib/knowledge/embeddings.ts` | 新增 | embedTexts（spawn worker）/ 存取 knowledge_embeddings / cosine / 向量检索 |
| `lib/knowledge/pipeline.ts` | 修改 | ingest 追加嵌入阶段（降级不阻断）+ 删文档清 embeddings（若 CASCADE 未覆盖存量路径则显式清） |
| `lib/knowledge/rg-search.ts` | 修改 | searchKnowledge 混合融合（RRF）；纯 rg 路零改动 |
| `workers/finance_worker.py` | 修改 | embed_texts 命令 |
| `requirements.txt` | 修改 | onnxruntime + tokenizers（pin 版本） |
| `app/api/knowledge/reindex/route.ts` | 新增 | 补索引 |
| `app/knowledge/page.tsx` | 修改 | 重建索引按钮 |
| `lib/runtime/flags.ts` | 修改 | 删 4 死旗标 |
| `scripts/knowledge-reset.mjs` | 修改 | 除幽灵引用 |
| `tests/semantic-search.test.ts` | 新增 | 迁移形状/chunker 边界/降级/融合/reindex（worker 以 mock 或 FINANCE_AGENT_PYTHON_PATH 真跑二选一，见 §4） |
| `tests/feature-flags.test.ts` | 修改 | 换存活旗标名 |
| `tests/fixtures/golden-schema.json` | 修改 | v11 同步 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试（chunker/迁移形状/降级）。2. v11 + golden。3. chunker。4. worker embed_texts（本地 venv 手动验证一次真实出向量，audit 记录）。5. embed-model 下载器（步骤注入，单测不走真网络）。6. embeddings.ts + ingest 接线。7. 混合融合。8. reindex route + 按钮。9. 死旗标 + reset 脚本。10. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```
- 单测中 embed 一律 mock（本工作树 venv 无 onnxruntime；真实向量验证由 implementer 在主仓 venv `pip install onnxruntime tokenizers` 后手动跑一次 worker 命令，输出维度/相似度 sanity 记入 audit）。若主仓 venv 安装失败，audit 如实记录并降级为纯 mock 验证——不阻塞 ship，模型链路留待带 key 验收。
- 模型下载器单测走注入的假 download 步骤，断言候选源顺序与落盘路径；真网络不进 CI。

## 5. 风险与开放问题

- **查询侧冷加载延迟**：worker 每调用 spawn，embed query 含模型加载约 1-2s。v1 接受（检索是 agent 工具调用场景，本身秒级）；常驻进程留待延迟被实际抱怨后再做。
- **模型下载可达性**（国内网络）：三级候选源 + env 覆盖照 python-installer 先例；全部失败 = 语义层永久降级（纯 rg），不报错——UI 的 reindex 按钮返回 failed 计数可暴露该状态。
- **onnxruntime 加重安装**（~60MB wheel）：进 requirements.txt 意味着所有用户 pip 阶段变重。接受——它是语义检索的唯一现实路径；audit 记录实测安装增量。
- 512 维 Float32 BLOB ≈ 2KB/chunk，千级 chunk 约 2MB DB 增量，可忽略。
- 被否决：① **sqlite-vec**（roadmap 原案）——未安装非既有依赖、主库须开 allowExtension、打包态 Windows 加载原生 .dll 扩展是已知运行时盲区（memory: windows-runtime-test-blindspot）、数千 chunk 规模 ANN 无收益，BLOB+余弦零新原生依赖；② Node 侧 transformers.js——重计算归 Python worker 是既有架构分工；③ sentence-transformers——拖 torch（GB 级）；④ FTS5 分词检索——字面召回已被 rg+2gram 覆盖，目标是语义（"招待费上限"→"业务招待费扣除标准"）；⑤ 复活 knowledge_chunks 表名——与 baseline legacy DROP 撞名互咬；⑥ 模型文件进 git 仓库——24MB 二进制污染仓库且 hf 许可分发链路更干净。
