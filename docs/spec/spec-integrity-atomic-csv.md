# Integrity, Atomic Writes, and CSV Duplicate Fix Spec

> 版本 v1.4 / 2026-07-13
> 状态：实施完成，独立实施审查通过
> 依赖：`spec-security-release-blockers.md`；本 spec 在当前分支取代外部 worktree 中的计划 002、计划 003，不修改或提交该 ignored worktree
> 架构事实：当前分支 `codex/security-atomic-csv` 从最新 `origin/main` (`7441ffc`) 创建，并承载尚未提交的安全热修复；`getDb()` 按数据库路径缓存一个进程内 `DatabaseSync`，三个聊天 helper 都复用该连接且自身不打开事务；知识库原件与文本镜像可能被多个逻辑文档引用，物理删除必须以剩余 owner 数量为准。

## 0. 目标与非目标

**目标**：一次完成三个已授权范围：

1. 收口知识库 `storage_path` / `content_hash` 多 owner 安全，任何物理副本或文本镜像只在最后一个 owner 消失后删除。
2. 实施计划 002：assistant message+events、user message+attachments、archive flag+obligations 三处多行写入原子化。
3. 实施计划 003：空发票号不再被 `analyze_csv` 误判重复，同时保留真实非空重复检测。

**非目标（本期不做）**：
- 不增加 `content_hash` 唯一索引或做存量去重迁移；本期用精确 owner 计数兼容已有重复记录。
- 不改变 amount 对货币符号/千分位的拒绝行为。
- 不重构 SQLite DAL，不修改 insert helper 签名。
- 不处理此前审计的上传总配额、OS Python 沙箱、Tauri capability 等后续安全项。
- 不在上传/解析失败时立即删除尚无 DB owner 的内容寻址文件；跨请求并发下无法证明它没有 in-flight owner，孤儿清理由后续基于年龄的 GC 处理。
- 不修改或提交用户已有的 `src-tauri/Cargo.lock` 变更。

## 1. 成功标准

- [x] DB 提供按 canonical 物理 `storage_path` 与精确 `content_hash` 统计知识文档 owner 的 helper，可复用传入的事务连接；darwin/win32 的路径大小写变体视作同一 owner key，Linux 保持大小写敏感。
- [x] 内容寻址原件采用同目录临时文件 + 原子、非覆盖发布；已存在目标必须校验实际 SHA-256，一致则幂等复用，不一致则报错且原字节不变。
- [x] 两个上传入口使用唯一目标路径算法（hash 小写、扩展名小写），在发布文件前同时按 `content_hash` 与平台感知的 canonical `storage_path` key 获取进程级 ingest lease，并在 `ingestDocument` 成功或失败后 finally 释放；最后-owner删除在同一同步临界段确认 canonical owner 为 0 且对应 lease 不活跃。
- [x] 上传/解析失败路径不立即删除可能正被并发请求使用的内容寻址目标；移除基于单行 hash owner 的危险清理。
- [x] DELETE 知识文档先完成逻辑删除，再仅在 `storage_path` owner 为 0 且该 path 无 active lease 时删除物理副本；同一副本或正在 ingest 的请求继续可用。
- [x] 同名更新切换 storage/hash 后，仅在旧 storage owner 为 0 且旧 path 无 lease 时删旧副本、旧 hash owner 为 0 且旧 hash 无 lease 时删旧文本镜像。
- [x] `deleteDocument` 对共享 `content_hash` 的文本镜像执行最后-owner且无-active-lease删除，删除一个重复文档不破坏另一个或 in-flight ingest。
- [x] 真实 route 回归覆盖多 owner 共享路径：删第一条保留文件/镜像，删最后一条才删除；storage 单测覆盖并发发布所需的非覆盖/幂等合同。
- [x] Site A assistant message+events、Site B user message+attachments、Site C archive+obligations 均由 `BEGIN/COMMIT/ROLLBACK` 包围；Site C unarchive 使用 `{ inTx: true }`。
- [x] Site A/B/C 均有真实 SQLite `RAISE(ABORT)` 故障注入回滚测试，分别通过真实 POST route、`sessionStage`、真实 PATCH route 触发。
- [x] CSV 两个空发票号产生 0 条“发票号重复”，两个相同非空发票号仍只产生 1 条重复告警；amount 解析未改。
- [x] 所有定向测试通过；标准全量验证如仍仅被 ignored Tauri 生成副本阻断，记录精确命令与路径，不修改生成副本或 Cargo.lock。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `docs/spec/spec-integrity-atomic-csv.md` | 新增/更新 | 本 spec 状态 |
| `docs/spec/audit-integrity-atomic-csv.md` | 新增 | 实施审计 |
| `docs/spec/spec-security-release-blockers.md` | 更新 | storage owner 阻塞解决后更新状态 |
| `docs/spec/audit-security-release-blockers.md` | 更新 | 记录 owner 收口结果 |
| `lib/db/sqlite.ts` | 修改 | storage/hash owner 计数 helper |
| `lib/knowledge/storage.ts` | 修改 | 内容寻址文件原子、非覆盖发布及 hash 校验 |
| `app/api/knowledge/documents/route.ts` | 修改 | 上传 ingest 全程获取/释放 content hash lease |
| `app/api/files-library/route.ts` | 修改 | 移除并发不安全的失败即时清理 |
| `app/api/knowledge/documents/[id]/route.ts` | 修改 | archive 事务；DELETE 最后-owner物理删除 |
| `lib/knowledge/pipeline.ts` | 修改 | 同名更新与 deleteDocument 最后-owner清理 |
| `tests/files-promote.test.ts` | 修改 | 多 owner、共享镜像、失败清理真实 route 回归 |
| `tests/knowledge-storage.test.ts` | 修改 | 非覆盖发布、幂等复用、冲突字节保护回归 |
| `app/api/agent/query/route.ts` | 修改 | assistant message+events 事务 |
| `lib/agent/query-stages.ts` | 修改 | user message+attachments 事务 |
| `tests/atomic-multirow-writes.test.ts` | 新增 | 002 三处原子性回归 |
| `tests/all.test.ts` | 修改 | 注册新增原子性测试 |
| `workers/finance_worker.py` | 修改 | 空 invoice_no 不比较、不入 seen |
| `tests/fixtures/corpus/csv-blank-invoices.csv` | 新增 | 空值+真实重复 fixture |
| `tests/parse-corpus.test.ts` | 修改 | 003 RED/GREEN 回归 |

实施中如需修改列表外文件，停止并报告。

## 3. 实施步骤

### A. storage_path/content_hash owner 安全

1. 先扩展 `tests/files-promote.test.ts`：
   - 人工插入两个 owner 指向同一知识副本与同一 hash，创建文本镜像；第一次 DELETE 后另一个 owner、文件和镜像均存在，第二次 DELETE 后均消失。
   - 确认当前实现 RED。
2. 先扩展 `tests/knowledge-storage.test.ts` 并确认 RED：
   - 目标不存在时成功发布，临时文件最终清理。
   - 目标已存在且实际 hash 一致时幂等复用，不重写目标。
   - 目标路径已存在但实际 hash 与请求 hash 不一致时抛错，原字节保持不变。
3. `lib/knowledge/storage.ts` 增加进程级 lease registry 与 API：
   - registry 必须挂在 `globalThis[Symbol.for("finance-agent.knowledge-ingest-leases")]`（或等价稳定 symbol）上，不能使用模块局部 `Map`，确保 Next 不同 route bundle 观察到同一状态。
   - 同时维护 `hash:<content_hash>` 与 `path:<canonicalStoragePathKey(storagePath)>` 两类引用计数；acquire 返回幂等 release，并提供分别查询 hash/path active lease 的函数。
   - `canonicalStoragePathKey` 先 `path.resolve`/Unicode normalize，并在 darwin/win32 统一大小写，Linux 保持大小写；不得只用原始字符串。
   - 增加唯一纯路径计算 helper（hash+ext → storagePath），将 hash 与扩展名统一小写，让 route 在写文件前即可同时获取两类 lease；`writeUploadedFile` 与 DB 持久化必须使用该同一结果。
   - 当前 Tauri/Next 桌面运行时是单 Node 进程；若未来改为多进程服务部署，必须将 lease 升级为跨进程协调。
4. `writeUploadedFile` 改为原子、非覆盖发布：先将完整字节以 `wx` 写入同目录唯一临时文件，再通过硬链接原子发布到目标；目标竞争产生 `EEXIST` 时校验现有目标 hash，一致则复用，不一致则失败；finally 清理临时文件。不得先覆盖目标。
5. `app/api/knowledge/documents/route.ts` 与 `app/api/files-library/route.ts` 均先计算最终 storagePath，再在调用 `writeUploadedFile` 前获取 hash+path lease，并以涵盖 write + parse + `ingestDocument` 的 finally 释放。existing 直接返回路径无需 lease；overwrite/新 ingest 必须持有。
6. `files-library` catch 移除 `getKnowledgeDocumentByHash` 及任何即时删除目标文件的逻辑。解析失败可能留下内容寻址孤儿，记录为后续基于年龄的 GC，优先保证并发请求不丢文件。
7. 在 `lib/db/sqlite.ts` 新增 `countKnowledgeDocumentsByStoragePath(storagePath, db = getDb())` 与 `countKnowledgeDocumentsByContentHash(contentHash, db = getDb())`。hash 使用精确等值；storage path 必须按当前平台 canonical key 计数（darwin/win32 大小写不敏感，Linux 大小写敏感），兼容存量 `.PDF`/`.pdf` 路径。
8. DELETE route 保存旧 storage/hash 后先调用 `deleteDocument`；随后在不含 await 的同步临界段内，仅当剩余 storage owner 为 0 且该规范化 path 无 active lease 时调用受 realpath containment 保护的 `deleteStoredFile`。删除外部历史路径仍是 no-op，但 DB 删除成功。
9. `pipeline.ts`：
   - 同名 hash/storage 更新落 DB 后，再同步检查旧 storage owner + path lease，以及旧 hash owner + hash lease；对应 owner 为 0 且对应 lease 不活跃才清物理副本/旧 mirror。
   - `deleteDocument` 先清文档专属 obligations/embeddings 并删除 DB 行，再仅在 hash owner 为 0 且无 active lease 时删 mirror。
   - 删除 route 中重复的提前 `deleteTextMirror` 调用。
10. 增加 lease 竞态回归：
   - 最后一个 DB owner 删除时若同 path/hash lease 活跃，逻辑行可删除但原件和 mirror 必须保留；释放 lease 后不做即时删除，作为安全孤儿留待年龄 GC。
   - 人工构造“同一 storage_path、不同 content_hash”的兼容数据，以新 hash + 同 path lease 模拟 in-flight ingest；删除旧 hash owner 时原件必须因 path lease 保留。
   - 断言 `.PDF` 与 `.pdf` 经目标路径算法得到同一路径；在 darwin/win32 上，大小写变体 owner/lease 也必须互相可见，最后-owner删除不得误删。
   - 通过独立加载/route 可见性断言证明 registry 位于 `globalThis`，并验证两个上传 route 在 `ingestDocument` 抛错时仍释放 hash/path lease。

### B. 计划 002 三处原子性

11. 新建 `tests/atomic-multirow-writes.test.ts` 并先 RED：
   - Site A：临时 DB 建 `BEFORE INSERT ON chat_agent_events` 的 `RAISE(ABORT)` trigger，启用 mock agent 后调用真实 `POST /api/agent/query?stream=false`；使用会产生 agent event 的输入，断言响应失败、trigger 确实触发，且本次 assistant message 与 events 均未残留。此前已提交的 user message不属于 Site A 事务。
   - Site B：临时 DB 建 `BEFORE INSERT ON chat_attachments` 的 `RAISE(ABORT)` trigger，再调用 `sessionStage`；断言异常传播，且本次 user message/attachment 均未残留。
   - Site C：临时 DB 创建文档和至少一条 obligation，并建 `BEFORE DELETE ON fact_obligations` 的 `RAISE(ABORT)` trigger；调用真实 PATCH archived，断言返回 500、trigger 确实触发，且 archived 标志和 obligation 均保持原状。另断言 unarchive 分支行为通过同一事务测试覆盖。
12. Site A/B/C 复制既有 metadata 分支的同步事务模板：`BEGIN` → writes → `COMMIT`; catch 中 best-effort `ROLLBACK` 后 `throw err`。Site B transaction 只包 message+attachment，不移动 dedup；Site C 包 flag 与 obligations，unarchive 传 `{ inTx: true }`。

### C. 计划 003 空发票号

13. 添加 fixture：至少两个空 `invoice_no`，以及两个相同非空 `INV-001`。测试断言空值重复告警数严格为 0、`INV-001` 重复告警数严格为 1。先确认 RED。
14. worker 仅在 `invoice_no` 非空时比较和加入 `invoice_seen`，不动 amount/category/金额异常逻辑。

### D. 状态与验证

15. 运行所有定向测试和标准验证，编写 audit；将 security spec/audit 标记为 owner 阻塞已解决。外部 ignored worktree 的 plans/README 不属于本分支交付，本 spec/audit 记录 002/003 已实施与验证。

## 4. 测试与验证方式

```bash
node --import tsx tests/files-promote.test.ts
node --import tsx tests/atomic-multirow-writes.test.ts
node --import tsx tests/parse-corpus.test.ts
node --import tsx tests/python-worker.test.ts
node --import tsx tests/query-stages.test.ts
node --import tsx tests/obligations-live.test.ts
node --import tsx tests/confirm-contract-chain.test.ts
node --import tsx tests/confirm-gate-fix.test.ts
node --import tsx tests/agent-confirm-flow.test.ts
node --import tsx tests/sdk-pre-tool-use.test.ts
node --import tsx tests/knowledge-storage.test.ts
node --import tsx tests/skill-xlsx.test.ts
node --import tsx tests/role-registry.test.ts
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```

- 如果标准 typecheck 仍扫描 ignored `src-tauri/resources` / `src-tauri/target`，额外运行 audit 中记录的 source-only typecheck 命令作为改动代码证据，但不得把它冒充标准命令通过。
- 不运行真实模型联网测试；桌面 SDK smoke 仍是发布前人工验证项。

## 5. 风险与开放问题

- owner 计数不是 schema 唯一性约束；它解决共享文件误删，但不阻止重复逻辑行。存量去重是独立产品/迁移决策。
- 解析失败可能留下尚无 DB owner 的内容寻址孤儿；当前只提供单进程 lease，仍不把失败即时清理作为正确性依赖，孤儿只允许未来以安全年龄阈值做 GC。
- lease 仅覆盖当前桌面单进程运行模型；未来若用多个 Node worker/实例共享同一知识目录，必须改为 DB/文件锁等跨进程 lease 后才可保留物理删除能力。
- SQLite 事务内不得出现 await；三个目标 block 均为同步 DB 写，必须保持这一性质。
- 内容镜像按 hash 共享，任何新增删除路径都必须复用最后-owner规则。
