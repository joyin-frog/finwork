# 查询路由管线化（WP10a：POST 本体分段 + ws 实验通道退役）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审**批准**；§0 可注入 db 外观残留已清）
> 状态：**已实施并通过审查（ship）**。前任中断 40%、收尾者补完（含修正前任的幽灵模块引用）；实施审查零阻塞；N1 唯一出口侵蚀记后续清理，N3 require 风格已由 orchestrator 修复。
> 依赖：无。零 DDL。
> 架构事实（2026-07-07 scout 核实）：route.ts 现 717 行，**POST 本体 176 行（40-215）**，大量辅助已抽出（runAgentTurn/persistAgentTurn/persistIncompleteTurn/createStreamingResponse/parse 两函数等 17 个）。POST 内联待抽段：解析分发(40-74)/attachment 守卫(76-84)/**会话管理+user 消息落库(86-108)**/**session staleness(110-122)**/skill hint+快照(124-129)/配额(131-149)/router(151-166)/执行分发(168-215)。流式独有：meta 事件、resolveUserQuestion 挂接、askEvents 并入、await title 推送、abort→cancelPendingQuestions。依赖全部模块级 import 直调，无注入。**项目无 async 管线抽象先例**（knowledge/pipeline 是线性步骤函数；hooks/chain 是同步拦截器）——需自建最简 Stage 模式。**agent-ws-server.ts（109 行）删除证据充分**：仅 package.json agent:ws 引用、零测试、与主路径功能重叠但缺 quota/router/persist 全部业务层；docs/architecture.html 有"可选 WebSocket Sidecar"一节需同步。哨兵（readFileSync 盯 route.ts 源码）：agent-pipeline.test.ts:9-22（insertChatMessage assistant 唯一出口计 1 次/persistAgentTurn 计 2 次/resolveModelByTier/normalizeTier）、usage-accumulate.test.ts:61-62（__modelUsage）、flags-db-override.test.ts:51-55（matchTrivialMessage）、chat-features.test.ts:179；直调 POST：smoke.test.ts（三处，流式/非流式/multipart）、agent-attachments-json.test.ts。

## 0. 目标与非目标

**目标**：① POST 本体重组为显式管线——新文件 `lib/agent/query-stages.ts` 定义 `type Stage<In,Out> = (ctx: In) => Promise<Out | Response>`（返回 Response 即短路），四段纯搬迁函数（reviewer N2 计数修正）：`parseStage`（解析+attachment 守卫）→ `sessionStage`（会话管理+user 落库+staleness，**当前最难测的内联段，抽出后经 FINANCE_AGENT_DB_PATH 环境隔离独立测试**）→ `quotaStage` → `routerStage` → 执行分发留 route.ts（流式/非流式已是独立函数）；POST 缩为管线装配（目标 ≤50 行）；② **agent-ws-server.ts 退役四件套**（详见 §1）：删文件、删 package.json 脚本、architecture.md 与 architecture.html（含 footer 残句）同步改"已移除"。**行为零变化**（WP9a 同性质：纯平移禁止逻辑改写）。

**非目标**：依赖注入框架/ctx 泛化超出本管线所需；流式内部（createStreamingResponse）重构；persist 系函数改动；性能优化；middleware 化其他 route。

## 1. 成功标准（先红后绿；纯搬迁部分以基线对照替代红测试，同 WP9a 条款）

- [ ] `lib/agent/query-stages.ts`：Stage 类型 + 四段函数，逐段签名 `(_ctx) => Promise<ctx | Response>`，ctx 字段按核实清单（traceId/settings/**roleMode（顶层直供——PersistTurnParams 要 string 非 settings 对象，reviewer B2）**/messages/attachments/conversationId/claudeSessionId/**existingClaudeSessionId（sessionStage 产出、router 与 persist 双消费、不可从 claudeSessionId 反推，reviewer B2 补漏）**/lastUserContent/routerResult/modelOverride/outputDir/beforeGenerate/startedAt/useStreaming/requestSignal）。**每段代码从 POST 对应行段平移，禁止顺手改写**。
- [ ] `sessionStage` 独立测试：**经 `FINANCE_AGENT_DB_PATH` 环境变量隔离**（reviewer N1 修正措辞——内部 sqlite 函数走 getDb 单例无参数注入口，先例 flags-db-override.test.ts:8-15），构造 ctx 调用，覆盖新会话创建/既有会话追加/staleness 重置三分支——先写红。
- [ ] POST 装配以 ≤50 行为目标（**次优先指标，reviewer N3——流式解包使装配合理超标时报告行数即可不阻塞**，WP9a 同款条款）；两个直调 POST 的测试（smoke×3、agent-attachments-json）**文件不动、复跑验绿即可**（reviewer N5 说明：它们是端到端调用无源码断言）。
- [ ] **哨兵扩展（既定规则：拼接范围扩为文件集、断言字符串不变）**：agent-pipeline/usage-accumulate/flags-db-override/chat-features 四个 readFileSync 哨兵的读取目标扩为 [route.ts, query-stages.ts]；insertChatMessage assistant 唯一出口与 persistAgentTurn 计数语义保持（若函数搬迁致计数口径变化，停下报告）。
- [ ] ws 退役**四件套**（reviewer B1/N4）：文件删除、package.json 脚本删除、**docs/architecture.md 的 WebSocket sidecar 小节（136-156 行）**与 architecture.html 图表模块及 **642 行 footer"可选的本机 WS sidecar"残句**全部改为"已移除（2026-07-07，功能由 HTTP+SSE 主路径覆盖）"；验收命令扩为 `rg "agent:ws|agent-ws|3761|WS sidecar|WebSocket sidecar"` 全仓零残留（"已移除"说明行除外）。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/query-stages.ts` | 新增 | Stage 类型+四段平移 |
| `app/api/agent/query/route.ts` | 修改 | POST 改管线装配；被平移段删除 |
| `scripts/agent-ws-server.ts` | 删除 | 退役 |
| `package.json` | 修改 | 删 agent:ws 脚本 |
| `docs/architecture.html` | 修改 | Sidecar 图表模块 + 642 行 footer 残句改"已移除" |
| `docs/architecture.md` | 修改 | WebSocket sidecar 小节（136-156 行）改"已移除"（reviewer B1） |
| `tests/query-stages.test.ts` | 新增 | sessionStage 三分支（红先行）+ 各段短路语义 |
| `tests/agent-pipeline.test.ts` | 修改 | 哨兵读取范围扩 |
| `tests/usage-accumulate.test.ts` | 修改 | 同上 |
| `tests/flags-db-override.test.ts` | 修改 | 同上 |
| `tests/chat-features.test.ts` | 修改 | 同上（179 行处） |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 基线：全量测试输出存档（audit 对照用）。
2. 红测试：query-stages.test.ts 的 sessionStage 分支（函数不存在即红）。
3. 平移四段（一次一段，每段后 typecheck；`matchTrivialMessage`/`__modelUsage` 等哨兵目标字符串随段迁移，哨兵测试同步扩读取范围）。
4. POST 装配收口 + 直调测试复跑。
5. ws 退役四件套。
6. 对照基线全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```

## 5. 风险与开放问题

- **最大风险=平移时的隐性依赖**（POST 内段间共享的局部变量成为 ctx 字段时漏传）——每段平移后立即 typecheck + 直调 POST 测试是防线；reviewer 按"移动+ctx 化"审，逻辑改写即 fix first。
- 流式路径的 ctx 传递终点是 createStreamingResponse 既有签名——参数打包进 ctx 后在装配处解包回原签名，不动该函数（非目标）。
- 被否决：① 引 middleware 库（依赖纪律）；② 连 createStreamingResponse 一起重构（diff 审不完，留 WP10b 若有需要）；③ ws 转正（补齐业务层成本远超价值，摸底证据充分）。
