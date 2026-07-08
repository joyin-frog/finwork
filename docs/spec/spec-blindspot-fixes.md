# Spec: 盲区扫描修复批次（blindspot-fixes）

## 背景与目标

两轮多代理盲区扫描（覆盖 ebd1937..7f2ba59，即一至八批改造）发现 4 组 P1 + 若干 P2。本批次修复其中 P1 全部 + 高价值 P2，按五个独立工作包（WP-A..E）执行，文件集互不相交，可并行实施。

**非目标**：P3 项（audit_undo 归因字段、迁移冻结纪律、时区系统性偏差、CalcReceipt 静默 null 等）本批不修；不做任何重构、不动无关代码、不新增迁移。

## 环境与验证

- 仓库根：`/Users/gyro/codex/finance-agent-public/.claude/worktrees/blissful-easley-5c7b41`
- 全量测试：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`（runner 是 `node --import tsx tests/all.test.ts`；Python 相关测试需要仓库既有 venv，先看 tests/README 或 all.test.ts 顶部注释确认激活方式）
- 实施期间只跑与自己 WP 相关的单个测试文件（`node --import tsx tests/<file>.test.ts`，若单文件不可直跑则跑全量），全量回归由主循环在合并后统一跑。
- 每个 WP 完成后单独 commit，message 前缀 `fix(blindspot):`。

## 通用铁律

- node:sqlite `DatabaseSync` 不支持嵌套 BEGIN。凡"把两个写操作包进同一事务"的改动，必须先检查内层函数是否自己 `BEGIN/COMMIT`（如 `persistDerivedObligations`、`recordAudit`），需要时给内层函数加"已在事务内"参数或抽出不带事务的内核函数，而不是嵌套 BEGIN。
- 修复缺陷前先写会失败的测试，确认失败，再修，再确认通过（除非纯文案/schema 一行改动）。
- 手术式修改：不顺手重构、不重新格式化。

---

## WP-A 安全脱敏（P1）

**Files touched**: `lib/agent/mcp-tools/read-document.ts`, `app/api/agent/query/route.ts`, `app/api/cockpit/summary/route.ts`, 新增/扩展 1 个测试文件

1. `read-document.ts:58` 附近：返回给 LLM 的 OCR/提取文本先过 `redact()`（`lib/safety/pii`，参考 `payroll.ts:219` 的用法）。
2. 同工具加路径白名单：`filePath` 经 `path.resolve` 归一化后必须位于会话文件目录或应用数据目录内（参考 `app/api/files/[conversationId]/[...filename]/route.ts:21-25` 的前缀校验模式），否则返回错误文本（不抛裸异常）。
3. `app/api/agent/query/route.ts:91`、`:392`、`app/api/cockpit/summary/route.ts:76`：`appendServerLog` 写入的 `error.stack/message` 先过 `redact()`。
4. 测试：仿照 `tests/telemetry-app-errors.test.ts:74-90` 模式——构造含身份证号样式字符串的文本经 read_document 返回后不含原文；路径穿越（如 `/etc/hosts`）被拒。

**成功标准**：新测试先红后绿；`grep -n "redact" lib/agent/mcp-tools/read-document.ts` 命中；三处 serverLog 调用点均过 redact。

---

## WP-B 确认合同链路（P1）

**Files touched**: `app/api/knowledge/documents/[id]/route.ts`, `app/api/agents/route.ts`, `lib/db/sqlite.ts`（改 `setKnowledgeDocumentMeta` 签名）, `lib/domain/cash-obligations.ts`（事务内核参数）, 测试文件

1. **根因修复** `route.ts:22`：`body.metadata === undefined` 时**不覆盖 metadata 列**。`setKnowledgeDocumentMeta`（`lib/db/sqlite.ts:678`）当前一条 SQL 同时更两列——改其签名支持 `metadata: undefined` 表示"不更新该列"（内部按是否 undefined 选择 SQL），不要在路由层写裸 SQL。修复后"前端只发 `{metaStatus:"confirmed"}`"的请求必须能触发义务落盘（前提是库里已有 metadata）。
2. **事务收拢**：`setKnowledgeDocumentMeta` 与 `persistDerivedObligations` 包进同一事务。`persistDerivedObligations` 内部自带 BEGIN/COMMIT——给它加可选参数 `opts?: { inTx?: boolean }`，为 true 时跳过自身的 BEGIN/COMMIT/ROLLBACK（保持默认行为向后兼容，WP-D 不依赖此函数，无接口冲突）。
3. **非法 metaStatus 返回 400**：`route.ts:21` 现在非法值静默降级 draft 并删义务；改为校验失败直接 400，不做任何写。
4. **NaN 守卫**：`Number(id)` 为 NaN 时返回 400（GET/PATCH/DELETE 全部路径）。
5. **双轨收拢**：`app/api/agents/route.ts:108` 的 `deriveCashObligations(oblDocs)` 改为与 cockpit 相同的 `listCashObligations()`（返回类型已核实结构一致，消费方 `deriveAttentionItems` 不受影响）。**同一提交内删除因此死掉的代码**：`oblDocs` 构建块（约 102-107 行）、`parseMeta`（约 13-18 行，若无其他使用方）、不再使用的 import（`deriveCashObligations`、`ObligationSourceDoc`、`listConfirmedMetaDocRows`）。
6. 测试：模拟真实前端行为——先 PATCH 带完整 metadata（draft），再 PATCH 只带 `{metaStatus:"confirmed"}`，断言 `fact_obligations` 有行（此测试在修复前必须失败）；非法 metaStatus 400 且义务未被删。

**成功标准**：新测试先红后绿；`app/api/agents/route.ts` 不再 import `deriveCashObligations` 且无残留死代码。

---

## WP-C 语义检索可用性（P1）

**Files touched**: `lib/knowledge/embed-model.ts`, `lib/knowledge/embeddings.ts`, `lib/knowledge/rg-search.ts`, `app/api/knowledge/reindex/route.ts`, `app/knowledge/page.tsx`, `tests/semantic-search.test.ts`

1. **接线模型下载**：`ensureEmbedModel()` 目前全仓库零调用方，且其签名要求必填的 `download: DownloadStep`（`embed-model.ts:106-111`，注入式设计、模块内无内置实现）。改法分两步：
   - 在 `embed-model.ts` 新增内置的 fetch 版 `DownloadStep` 并把 `download` 参数改为可选（缺省用内置实现）。下载源与文件清单**先核对** `docs/spec/spec-semantic-search.md` 的原始设计与 `MODEL_FILES` 常量；若原 spec 未定源，用 `hf-mirror.com` 优先、`huggingface.co` 兜底（模型 `bge-small-zh-v1.5` 的量化 ONNX 与 tokenizer）。每个文件的下载带超时（单文件 120s，AbortController），失败返回 `ok: false` 不抛异常。
   - `POST /api/knowledge/reindex` 开头 `await ensureEmbedModel({...})`：`ok: false` 时响应带 `modelUnavailable: true` 并提前返回（不把文档计入 skipped）。模型约 24MB，请求内下载可接受；超时即失败返回，不允许无限挂起。
2. **响应区分**：reindex 响应把"模型不可用"与"已索引跳过"分开；`app/knowledge/page.tsx:326` 的 toast 相应区分文案。
3. **异步化**：`embeddings.ts:27` 的 `execFileSync` 改 `execFile`（promisify），让 `rg-search.ts:98` 的 `Promise.all` 真并行；确认无调用方依赖同步语义。**范围仅限 `embeddings.ts`**——`lib/knowledge/parsers/index.ts` 里另有两处 execFileSync 属既有代码，本批不动（记入遗留清单）。
4. **完整性校验**：`ensureEmbedModel` 下载完成后落一个 manifest（各文件字节数）；`isEmbedModelReady()` 校验文件存在且字节数与 manifest 一致，不一致视为未就绪（下次 ensureEmbedModel 重新下载）。对"用户手动放置模型文件、无 manifest"的场景：文件齐全但无 manifest 时按现状放行（仅存在性检查），不破坏现有手动路径。
5. **模型列过滤**：`embeddings.ts:101` `vectorSearch` 的 SQL 加 `AND ke.model = ?`（当前模型名）。
6. **并发守卫**：reindex 路由加模块级 in-flight 标记，并发 POST 返回 409。
7. 测试：修 `tests/semantic-search.test.ts:172` T4 缺 `chunkIndex` 的假绿（补字段并断言 `lineNo` 非 NaN）；新增 model 过滤与 reindex 409 的用例；`ensureEmbedModel` 内置下载器用注入 mock 测（不打网络）。

**成功标准**：`grep -rn "ensureEmbedModel" lib app | grep -v embed-model.ts` 至少 1 处；`grep -n execFileSync lib/knowledge/embeddings.ts` 零命中；`npx tsc --noEmit` 通过；测试先红后绿。

---

## WP-D 审计原子性与销项守卫（P1+P2）

**Files touched**: `lib/db/finance-store.ts`, `lib/db/audit-store.ts`, `lib/agent/tools/finance/sales-invoices.ts`, `lib/agent/mcp-tools/finance-tools.ts`, 测试文件

1. **写+审计同事务**：`recordInvoices`、`settleInvoice`、`upsertBusinessMetrics` 三处，把业务写与 `recordAudit` 包进同一 `BEGIN/COMMIT`。已核实 `recordAudit` 自身无事务，可直接包住，无嵌套 BEGIN 问题。**已知局限（不扩大范围）**：`recordInvoices` 里的查重 SELECT（`findInvoicesInLedger`，约 435 行）留在事务外，TOCTOU 是既有行为，本批不处理。
2. **撤销守卫**：`audit-store.ts:185` 附近 UPDATE 加 `AND undone_at IS NULL`，`changes === 0` 时抛"已被撤销"错误（事务内）。
3. **负数回款拒绝**：`sales-invoices.ts:105` `settledAmountYuan: z.number().positive()`。
4. **账龄负数分箱**：`sales-invoices.ts:187-191` 新增"未到期/未来日期"计数（`agingDays < 0`），并纳入输出文本，保证 各分箱+nullDate+future 之和 = 总数。
5. **台账口径修复**：`finance-store.ts:574-580` `getInvoiceLedgerBreakdown` 的 `uncertifiedCount`、`directionUnknownCount` 加与 `total` 相同的 `invoice_date LIKE` 月份过滤。
6. **进项税部分和标注**：`finance-tools.ts:178` 附近，输出税额合计时统计 `direction='in'` 中 `tax_amount_cents IS NULL` 的张数，非零时追加"（其中 N 张税额未录）"。需要的话在 `getInvoiceLedgerBreakdown` 返回里加 `taxMissingCount` 字段（同月份过滤）。
7. 测试：撤销两次第二次报错；负数回款 schema 拒绝；未来日期发票分箱守恒；uncertifiedCount 只数本月（造两个月数据断言）。

**成功标准**：新测试先红后绿；`tests/audit-undo.test.ts`、`tests/sales-invoices.test.ts`、`tests/receipt-store.test.ts` 全绿。

---

## WP-E 工件并发与 ESLint 护栏（P2）

**Files touched**: `lib/db/artifact-store.ts`, `app/components/checklist-card.tsx`, `lib/agent/mcp-tools/emit-checklist.ts`, `eslint.config.mjs`, `app/agents/agent-detail-drawer.tsx`, `tests/ui/` 下新增 1 个测试, `tests/artifact-checklist.test.ts`

1. **原子 patch**：`artifact-store.ts:108-124` `patchArtifactState` 的读-改-写改为单条 `UPDATE artifacts SET state = json_patch(state, json_object(?, ?)), updated_at = ? WHERE id = ?`（保持"itemId 不存在返回错误"的现有行为——先查 items 合法性可以保留读，但状态合并必须落在这条原子 UPDATE 上）。
2. **按钮守卫一致**：`checklist-card.tsx:212` `disabled` 改为 `!!submitting || loading || deleted`，与 `handleToggle` 的守卫语义一致。
3. **fallback 移除**：`emit-checklist.ts:82-84` 读回 null 时不再造 `item-${i+1}` 假 ID，直接抛错。
4. **suppress 数量锁**：`tests/ui/` 新增测试，统计 `app/**/*.tsx` 中 `eslint-disable-next-line no-restricted-syntax` 的行数，断言 `<=` 当前实际值（写死数字，注释说明"只准降不准升"）。
5. **补标注**：`agent-detail-drawer.tsx:60/170/221` 三处裸 suppress 补 `-- 交互元素豁免，WP8a 规则` 尾注。
6. **正则豁免 token 合规写法**：`eslint.config.mjs:48` 的 `\brounded(\b|-)` 改为 `\brounded(?!-\[var)(\b|-)`（注意：`\b` 分支在 `rounded-[var` 里也能匹配 d 与 - 之间的边界，所以否定环视必须放在 alternation 之前）。改后用两个用例验证：`rounded-md` 仍告警、`rounded-[var(--radius-chip)]` 不告警。随后删除因此不再需要的 suppress 注释（仅限确认是 `rounded-[var(` 触发的行），并同步更新第 4 条的锁定数字。
7. 测试：json_patch 并发语义用两次交错 patch 断言互不覆盖；suppress 锁测试本身即护栏。

**成功标准**：`tests/artifact-checklist.test.ts` 全绿 + 新增用例通过；`npx eslint app/components/checklist-card.tsx` 无 no-restricted-syntax 告警（该文件的 rounded-[var 行不再需要 suppress）。

---

## 汇总验收（主循环执行）

1. 五个 WP 全部合入后跑全量：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`
2. `npx tsc --noEmit`（或仓库既有的 typecheck 脚本）
3. 逐 WP 自查 diff 与本 spec 的偏差，偏差记入各自 audit 文档。
