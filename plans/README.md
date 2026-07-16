# Implementation Plans

## 第七轮 · 动效审计（038–044，基准 `5d26309`，2026-07-12）

| Plan | Title | Severity | Depends on | Status |
|------|-------|----------|------------|--------|
| 038 | 收紧共享 primitives 的 transition 范围 | HIGH | — | TODO |
| 039 | 键盘命令面板即时出现 | HIGH | — | TODO |
| 040 | 对话动效性能、时长与 reduced-motion | MEDIUM | 043 | TODO |
| 041 | 进度条只动画 transform | MEDIUM | — | TODO |
| 042 | 侧栏、选中态与分组展开连续性 | MEDIUM | 043 | TODO |
| 043 | Motion presets 使用完整 transform | MEDIUM | — | TODO |
| 044 | 预览面板打开/收起/最大化连续性 | LOW | 043 | TODO |

推荐执行顺序：**043 → 038 → 041 → 040 → 039 → 042 → 044**。先统一 Motion 表达，再处理共享基础控件与高频聊天路径，最后增加导航和预览的空间连续性。所有计划禁止新增依赖；完整验收为 `npm run typecheck && npm run lint && npm test && npm run build`，再跑受影响的 Playwright 场景。

两轮 improve 审计的计划集合。**先读计划全文再开工**,遵守其 STOP conditions,完成后更新自己那行状态。

- **第一轮**:2026-06-13,审计基准 commit `97b1bdf`,standard 强度,全部九类 → 计划 001–006(已基本完成)。
- **第二轮**:2026-06-15,审计基准 commit `a111de5`,**deep 强度**,重点覆盖「架构 / 代码结构 / 安全 / 前端 UI / 交互 / 体验」+ 第一轮之后新增的安全提交(PII 脱敏 + 钥匙库,commit `1429e5e`,第一轮未见)→ 计划 007–025。
  - 选择说明:用户选定「安全 S1–S6 + 前端/UX F1–F7 + 架构 A1–A5 + 推荐快赢中的 M1」全量落计划;钱/正确性其余项 M2–M4 暂留 Backlog。

## 第一轮 · Execution order & status(001–006)

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | 修复 agent_traces 写入静默失败 + 观测页占位指标 | P1 | S | — | DONE (worktree agent-ab5699f88bb9679f5) |
| 002 | 收紧本地 API 与 Agent 工具的文件/进程边界 | P1 | S | — | DONE (worktree agent-abf1dd8f0956fc441) |
| 003 | 知识库与记忆内容的提示注入隔离 | P2 | M | — | DONE (worktree agent-a6bc859c6061ce3ac) |
| 004 | SQLite 读路径去 N+1 与连接复用 | P2 | M | — | DONE (worktree agent-af64b78f482a7c5b7) |
| 005 | 依赖卫生清理 | P3 | S | — | DONE (commit d1fadf3;Step 4 见 Backlog) |
| 006 | 上线就绪 follow-up | P1 | L | — | 大部分 DONE (2026-06-13);残留见 006 文末 |

## 第二轮 · Execution order & status(007–025,基准 `a111de5`)

按表序执行,除依赖另有说明。同一主题相邻编号可并行验证后再合并。

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 007 | PII 在 span/error/export 写入点脱敏(脱敏提交的盲区) | P1 | S | — | DONE — 已审核(worktree-agent-ae4bca244ba9b8f92 @ a111de5;writeSpan 收口 + error 脱敏,T4/T5 有效,全绿) |
| 008 | /api/files 校验 conversationId 为正整数(堵路径穿越) | P1 | S | — | DONE — 已审核(worktree-agent-a16d26b873030b5ec @ a111de5;typecheck/lint/test 全绿,3 文件在范围内) |
| 009 | PII 脱敏覆盖分隔符格式卡号/手机 + 统一社会信用代码 | P1 | S | — | DONE — 已审核(worktree-agent-a20174032d390500b @ a111de5;分隔符 + USCC,身份证仍在首位,全绿,未提交 lockfile)。合并注:与 007 同改 safety-redaction.test.ts,按 007→009→025 顺序合 |
| 010 | 工资期间确认改单事务(避免部分确认污染下月累计) | P1 | S | — | DONE — 已审核(worktree-agent-ad41b29ad3fd39e6a @ a111de5;事务逻辑正确,T6/T7 断言有效,全绿) |
| 011 | 会话切换加取消守卫(避免陈旧响应覆盖当前会话) | P1 | S | — | DONE — 已审核(worktree-agent-aa2725c1e30b5696b @ a111de5;typecheck/lint/test 全绿,仅 chat-page.tsx) |
| 012 | docx 预览切换文件后重渲染(去陈旧内容) | P1 | S | — | DONE — 已审核(worktree-agent-abcd3d402275b902a @ a111de5;去 renderedRef 闩 + innerHTML 清空,全绿) |
| 013 | ToolResultCard 作为组件渲染(修 Rules of Hooks 隐患) | P2 | S | — | DONE — 已审核(worktree-agent-a9a7adfa8aa50b3a3 @ a111de5;wrapper 内移 + JSX 渲染,全绿) |
| 014 | 启动注入 DB feature flag + 修正 spec 幽灵引用 | P1 | S | — | DONE — 已审核(worktree-agent-a9c283d7b3f8519f6 @ a111de5;instrumentation.ts + 注解 + spec 修正,全绿) |
| 015 | 子 Agent 注册金蝶 MCP(共享 MCP 构建器,修工具缺失) | P1 | M | — | DONE — 已审核(worktree-agent-a0d38a2ff47715d6e @ a111de5;子 Agent mcpServers 现含 kingdee_worker,全绿) |
| 016 | 工具 registry↔renderer 一致性守卫 | P2 | M | — | DONE — 已审核(worktree-agent-a337290d6b3ead8ec @ a111de5;T6 守卫每个 finance 工具有摘要,hasToolSummary 复用安全提交已有,全绿) |
| 017 | 观测/指标路由内联 SQL 下沉到数据层 | P2 | M | — | DONE(代码已审核·带合并警告)— worktree-agent-a231ce2f8b60cb629 @ a111de5;8 个代码/测试文件正确(无内联 SQL 残留、响应结构不变、新增 7+9 断言全绿)。⚠️ 提交误含 package-lock.json,删除了 @emnapi/core/runtime 跨平台可选依赖(c47a8e2 专门补的,合并会再弄坏 release CI)——合并前务必 `git checkout a111de5 -- package-lock.json`,只合那 8 个文件 |
| 018 | Markdown 插件/组件 + NavContext value memo(消除流式重解析) | P2 | M | — | DONE — 已审核(worktree-agent-a977c893a9b9366b6 @ a111de5;常量上提 + memo/useMemo,无新增 lint 警告,全绿) |
| 019 | file-preview 的 exceljs 改动态导入 | P2 | S | — | DONE — 已审核(worktree-agent-af3fb79cf01d48bed @ a111de5;import type + 动态 import,全绿) |
| 020 | 知识预览切换清空行 ref Map(修内存泄漏) | P2 | S | — | DONE(带 nit)— 已审核(worktree-agent-a3ed878ce78371d87 @ a111de5;功能正确、0 error、全绿;但 cleanup 直用 lineEls.current 引入 1 条 lint 警告 40 vs 39,合并前可把 ref 复制到局部再 clear) |
| 021 | UX/a11y 小集:搜索框标签 + mention listbox + 外点关闭 + 防重复提交 | P2 | S | — | DONE — 已审核(worktree-agent-a371cfd15694081a5 @ a111de5;4 项修复均正确,全绿)。合并注:与 011/018 同改 chat-page.tsx、与 019 同改 file-preview、与 020 同改 knowledge/page,按 011→018→021 等顺序合 |
| 022 | 统一 formatCny + 移除失效的 Bash 确认豁免 | P3 | S | — | DONE(部分)— formatCny 统一已落地(worktree-agent-a1a912158a7842ef0 @ a111de5,全绿)。Bash 死豁免移除按 STOP 正确暂缓:agent-confirm-flow.test.ts 孤立测 createRiskConfirmHook,豁免在该测试里承重——移除需同时把 createUnwiredToolHook 加进测试链(或改断言),见 Backlog |
| 023 | 收紧 Tauri fs/assetProtocol 作用域 + 启用 CSP | P2 | M | — | DONE(合并落地,commit ec1288b)— csp(生产严格)+ devCsp(开发宽松,放开 eval/inline/ws 让 HMR 正常)+ assetProtocol scope []。JSON/schema 校验通过。⚠️ 生产 csp 的运行时正确性需 `tauri:build` 实测(若打包后白屏/缺样式,放宽 prod csp)。fs:allow-read-file `**` 仍未收窄(本地预览读任选路径),架构后续 |
| 024 | API Key 进程内缓存 + 落库失败可见 | P2 | S | — | DONE — 已审核(worktree-agent-a0d1be1ffb05cf4e1 @ a111de5;缓存 + boolean 返回 + apiKeyPersisted,全绿) |
| 025 | ADR 记录 PII 脱敏边界 + 守卫导出不含原文表 | P3 | S | 007 | DONE — 已审核(worktree-agent-a8f736e919b14d61f @ a111de5;ADR 边界表 + 导出守卫测试 + CLAUDE.md 指针,全绿)。合并注:与 007/009 同改 safety-redaction.test.ts,按 007→009→025 顺序合 |

### 依赖与编排(第二轮)

- 绝大多数互相独立,可并行。建议先做安全快赢 **007 / 008**(各一行级改动、低风险、验证清晰),再做钱路径 **010**。
- **脱敏簇**:007(落盘/导出点)、009(正则覆盖)、025(边界 ADR + 导出守卫)语义相关;025 软依赖 007(先落 007 再写边界图最准确)。三者可顺序落地。
- **文件访问簇**:008(Next 路由路径穿越)与 023(Tauri 插件作用域)是两条正交的文件读取面,互补,各自独立。
- 023 含**必须人工桌面验证**的步骤(CI 无法启动 webview);执行环境若无 Rust 工具链,落配置 + typecheck 后标 BLOCKED 交人工跑 `tauri:dev`。
- 015 / 016 / 017 触碰 Agent 编排与观测,均行为保持型重构,改完跑 `npm test` 回归即可。

Status values: TODO | IN PROGRESS | DONE | BLOCKED(附一行原因)| REJECTED(附一行理由)

## 第三轮 · Backlog 落计划(026–029,基准 `a111de5`)

用户要求把 backlog 落成计划并执行。这 4 项即 022 残留 + M2–M4。

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 026 | 移除 Bash 死确认豁免(连带测试链对齐真实链) | P3 | S | — | DONE — 已审核(worktree-agent-ae8a716ff3a607255 @ a111de5;豁免清空 + 测试链 [unwired,risk-confirm] Bash→deny,全绿)。补齐 022 残留 |
| 027 | analyze_csv 整数分累加(去浮点漂移,M2) | P3 | S | — | DONE — 已审核(worktree-agent-a20b32228f2a9aa7c @ a111de5;整数分累加、响应结构不变、0.3 精确,全绿) |
| 028 | calculate_payroll_batch 直测:冷启动/接续推算/失败(M3) | P3 | M | — | DONE — 已审核(worktree-agent-a6cd5b0effd5124a8 @ a111de5;3 例断言均真实,接续推算 monthsEmployed=7 已验证,全绿) |
| 029 | 对账日期严格 YYYY-MM-DD(UTC,M4) | P3 | S | — | DONE — 已审核(worktree-agent-a7d7cf5d890a7c047 @ a111de5;regex+Date.UTC,新增 throw 断言,reconciliation 7 例全绿) |

合并注:027 与 028 都改 `tests/all.test.ts`(各注册一个新测试),按 027→028 顺序合(不同行,通常自动合)。

## 第四轮 · 继续清 backlog(030–032,基准 `a111de5`)

drift 发现:backlog 的「无 CI」已过时——`.github/workflows/ci.yml` 已存在并跑 lint+typecheck+test+golden。但它只装 Node、不装 Python/venv,`npm test` 的 python 相关用例(smoke/skill-*)会失败 → CI 实为红/未真正强制。故 030 改为「修 CI 的 Python 配置」。

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 030 | CI 加 Python+venv 配置(让 npm test 的 python 用例真跑过) | P2 | S | — | DONE — 已审核(worktree-agent-aaf31dfa24f2af448 @ a111de5;ci.yml +setup-python+venv+pip install,本地带 venv 的 npm test 通过)。⚠️ 真实绿需下次 CI run 确认 |
| 031 | 抽出 schema.ts(sqlite 拆分的安全子集,WP4 第一步) | P3 | M | — | DONE — 已审核(worktree-agent-af1f7e49dcb9310ea @ a111de5;schema.ts 不依赖 ./sqlite 无环、barrel 兼容、30 调用方不变、sqlite.ts 981→710、smoke/db-hardening 全绿) |
| 032 | requirements.txt 版本固定(>= → ==,005 残留) | P3 | S | — | DONE — 已审核(worktree-agent-a25d7821ad9f1bd43 @ a111de5;9 行 >=→==,版本号不变,全绿)。注:本机 dev venv 缺 pymupdf/xlsxwriter/python-pptx,故定到文档下限而非 pip freeze |

三者文件互不重叠,任意顺序合。031 仅抽 schema(DDL/迁移),完整域拆分(chat-store/observability-store)是更大的后续。

## 第五轮 · 性能专项(033–035,基准 `64e614a`,2026-06-21)

实测驱动(对真实库 32 会话/5919 事件 + 热点精读)。背景:打开重会话卡顿已先行修复(commit `64e614a`,折叠时间线改为展开才挂载),本轮处理其余性能项。

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 033 | 缓存 AssistantTurn 时间线派生计算(消除打字时按键重算所有消息) | P2 | M | — | DONE — sonnet executor(worktree-agent-a471c82452f6faed1)@ 98b2013;chat-page.tsx +24/-12,6 处时间线计算 useMemo + persistedTimelines 按 messages 缓存;reviewer 复验 typecheck/lint 0 error/chat e2e 6 passed,合入 `ad98805` |
| 034 | cockpit 当日聚合改可走索引的范围谓词 + 加 (event_type,created_at) 索引 | P3 | S | — | DONE — sonnet executor(worktree-agent-aeb47fd810f502e9e)@ 98b2013;两查询改 `>= datetime('now','start of day')` + 加索引 + 新测 cockpit-today-counts(验日期切割×类型过滤,非空壳);reviewer 复验 diff/typecheck/集成 npm test 全绿,合入 `a2492c2` |
| 035 | agent 事件持久化卫生:每回合硬上限 + 持久化端噪声过滤 +(可选)留存裁剪 | P3 | M | — | DONE(Step 3 留存裁剪按计划暂缓)— sonnet executor;新增 lib/agent/persist-hygiene.ts(sanitizeTurnEvents:丢 thinking_tokens/status、保 turn_duration、超 500 截断)+ route.ts loop 过滤(toolCallCount 仍用原始事件)+ 14 条单测(T4 验 turn_duration 保留);reviewer 复验集成 npm test 全绿(persist-hygiene/cockpit-today 均 pass,# fail 0),合入 `a2245d9`。注:执行隔离串台,改动落在 orchestrator worktree,已 rebase 到 main 干净合入 |

三者文件互不重叠,任意顺序执行。033 只动 `app/chat/chat-page.tsx`(+ 读 chat-types),034 只动 `lib/db/{sqlite,schema}.ts`,035 只动 `app/api/agent/query/route.ts`(+ 新工具模块/测试)。

**已完成的非代码动作**:会话 38 的 5369 个 `thinking_tokens` system 噪声事件已手工清理(`DELETE ... subtype='thinking_tokens'`,5919→550 行,payload 1.5MB→38KB,已先备份 `finance-agent.db.bak-*`)。现行 emit 层 `isMeaningfulSystemEvent` 白名单已不再产生此类噪声,故 035 是纵深防御(防绕过 + 无界增长),非活体 bug。

**本轮缓做(未写计划,记 Backlog)**:
- **PERF-04 — run_python 每次调用冷启 Python 进程**(`run-python.ts:30` 每次 `spawn(finance_worker.py)`;顶层只 import 标准库,故冷启较轻,~解释器启动 + 模型代码自身的 `import pandas` 等)。常驻 worker 复用是架构活(Effort L、Risk MED:状态隔离/并发),对单机小团队收益有限,**缓做**。

## 第六轮 · 搜索功能(036–037,基准 `b0fa1ee`,2026-06-24)

需求驱动(非审计):用户 grill 敲定两个搜索功能。设计共识见两计划开头。跨平台快捷键走既有 `app/shared/shortcuts.ts`(mod = mac ⌘ / win Ctrl),mod+f / mod+g 与现有组合不冲突。

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 036 | 对话内查找(Cmd+F / Ctrl+F)右上角 find-in-page 浮窗 | P2 | M | — | DONE — sonnet executor(worktree a128630918f396acd)；审阅者整合于 `5eb3f98`。CSS Custom Highlight API 高亮 + ↑↓ + Esc，读 ?find= 供 037 复用。修:e2e test① 去抖(搜用户消息不等 agent)。typecheck/lint/全量 npm test/036 e2e 2/2 全绿 |
| 037 | 全局搜索(Cmd+G / Ctrl+G)居中浮窗:文件搜标题 + 对话搜标题与内容 | P2 | M | 036 | DONE — sonnet executor(worktree a6a475871b41601b8)；审阅者整合于 `5eb3f98`。/api/search + sqlite LIKE(通配转义)+ GlobalSearchDialog + 导航栏图标；files/knowledge 读 ?file=/?doc= 自动开预览(Step6 未触发 STOP)。037 e2e 2/2 全绿 |

**执行顺序:先 036 再 037。** 036 更独立、风险小,且产出 037 复用的"导航到 `/chat/recent?id=X&find=<kw>` 自动定位"接口;037 点"对话内容命中"靠该接口跳转,不另写消息高亮。两计划都已含跨平台快捷键、SQLite LIKE 效率结论(单机毫秒级、不建 FTS)、e2e 坑(首启 gate 拦点击、索引慢用 toPass、用 `app-shortcut` CustomEvent 绕开平台按键差异)。设计取舍:文件只搜标题(召回低但快,v1 接受;内容搜留后续走 ripgrep 镜像)。

## 执行与合并指引(2026-06-15 全量执行)

19 个计划全部由执行子 Agent 在隔离 worktree 中实现(均 `git reset --hard a111de5` 对齐基线),并经逐份审核(typecheck/lint/test 在各自 worktree 重跑、范围核对、读 diff)。**合并是你的决定——我不替你 merge/push。** 每个分支名见上表对应行。

**结果**:17 份干净 DONE · 1 份部分(022,formatCny 落地、Bash 豁免暂缓)· 1 份 BLOCKED(023,需人工桌面验证)。

**合并顺序(同文件簇按序合,冲突多为不同区块、易解)**:
- `tests/safety-redaction.test.ts`:**007 → 009 → 025**(三者都在 `console.log` 前追加测试块,合并时保留全部、重命名 T 序号)
- `app/chat/chat-page.tsx`:**011 → 018 → 021**(loadConversation 守卫 / Markdown memo / mention 角色,不同区块)
- `app/components/tool-cards.tsx`:**013 → 016 → 022**(ToolResultCard 重构 / 导出常量 / formatCny import)
- `app/shared/file-preview-page.tsx`:**019 → 021**;`app/knowledge/page.tsx`:**020 → 021**
- 其余 **010 / 012 / 014 / 015 / 017 / 023 / 024** 互不冲突,任意顺序。

**合并前务必处理的三点**:
1. **017**:其提交误含 `package-lock.json`(删了 @emnapi 跨平台可选依赖,会再弄坏 release CI)。合并该分支后执行 `git checkout a111de5 -- package-lock.json`,只取 8 个代码/测试文件。
2. **023**:CSP + assetProtocol 已收紧但**未经桌面验证**——合并前跑 `npm run tauri:dev` 确认应用加载/流式/预览/打开方式正常;`fs:allow-read-file:**` 经核实不可收窄(本地文件预览读任选路径),收窄需把本地读改走 Next API(架构后续)。
3. **020**:功能正确,但 effect cleanup 直用 `lineEls.current` 引入 1 条 lint 警告;合并前可把 `lineEls.current` 复制到局部变量再 `clear()`(0 error,纯整洁性)。

## Backlog(已审计、未写计划的发现,按价值排序)

第二轮新增(本轮选择范围外的钱/正确性与前端长尾):

- **analyze_csv 浮点累加漂移**(M2 / PERFORMANCE-02,S):`workers/finance_worker.py:20,27` 改整数分或 `Decimal`,by_category 合计须到分准确。
- **calculate_payroll_batch 零测试覆盖**(M3 / COVERAGE-01+03,M):最高风险路径(冷启动/YTD 接续/monthsEmployed 推断)无直测;补 `payroll.ts` handler 测试。
- **对账日期解析非整数 diffDays**(M4 / CORRECT-04,S):`reconciliation.ts:168` `Date.parse` 混格式 → 同日错配丢成未匹配;`normalizeRow` 强校验 `YYYY-MM-DD`。
- **insertChatMessage / recordInvoices 多写非事务**(S):崩溃原子性(非并发——node:sqlite 同步);见 Plan 010 维护注记。
- **withIdempotency 双执行窗口**(CORRECT-07,M):`await handler` 前后非原子;PRIMARY KEY + INSERT OR IGNORE 兜底,数据无损,仅冗余执行/审计重复 → 低优先。
- **inspect_excel 两次全表扫描**(PERFORMANCE-01,S):formula_count 第二次无界 iter_rows,并入首遍计数。
- **listKnowledgeDocuments `SELECT *` 无界**(PERFORMANCE-03 backend,S):rg-search 仅需 id/storage_path,加投影函数。
- **前端长尾**:停止生成后 onDone 仍可写状态(CORRECT-03,S)· @mention 每键触发 fetch(CORRECT-05,S)· getMessageFiles O(消息×文件)(PERF-INVEST-01,S)· details 折叠丢焦点(A11Y-02,S)· observability 轮询 offset 闭包脆弱(UX-04,S)· urlUpdatedRef 不复位(CORRECT-06,latent)· 常量串 useMemo(TECH-DEBT-03,XS)。
- **sidebar resize 逻辑 chat↔knowledge 重复**(TECH-DEBT-02,S):抽 `useSidebarResize` hook;见 Plan 022 维护注记。
- **highlight.js 静态注入主 bundle**(PERF,M):`app/layout.tsx` 读 CSS 注入;ExcelJS 已由 Plan 019 处理,highlight.js 仍待。
- **移除 Bash 死确认豁免(Plan 022 Step 3 残留,S)**:`built-in.ts:63` 的 `CONFIRM_EXEMPT_TOOLS=["Bash"]` 在生产链里不可达(createUnwiredToolHook 先 deny),但 `agent-confirm-flow.test.ts:56` 孤立测 createRiskConfirmHook,豁免在该测试承重。移除时需把 createUnwiredToolHook 一并加进测试链(对齐真实链),或将该断言改为 Bash→deny。

第一轮遗留(仍未做):

- **requirements.txt Python 版本固定**(Plan 005 Step 4 残留,S):需带 venv 环境跑 `pip freeze` 固定 `==`。
- **xlsx 高危 CVE 无修复版本**(SEC-07/DEP-01,L):替换 exceljs 或下沉 Python openpyxl(预览 + 报表两处);Plan 019 只是懒加载,未解 CVE。
- **`lib/db/sqlite.ts` god 文件拆分**(DEBT-01,L):方案见 `docs/spec/spec-arch-hardening.md` WP4。
- **claude-adapter 流式路径零测试**(TEST-01,M);**Python worker 无测试**(TEST-02,M,与 M3 邻近,`cmd_run` 沙箱边界尤需);**无 CI**(DX-02,M)。
- **子 Agent 工具计时 FIFO 配对**(CORRECT-02,M);**税额舍入顺序需专业核实**(CORRECT-01,M);**pending question 无归属校验**(CORRECT-05,S);**dev getDb 竞态**(CORRECT-06,M);**file-preview 测试是源码字符串匹配**(TEST-04,M);**conventions 确认链路无集成测试**(TEST-03,S);**PDF execFileSync 阻塞事件循环**(PERF-05,M)。
- **lucide-react 锁 1.17.0 + 三套图标库并存**(DEP-02,M);**tests 下 TS5097**(开 `allowImportingTsExtensions`)。
- **DX/Docs 小项**:缺 `.env.example` 与 env 文档(DX-01)、`AGENTS.md` 引用不存在的 DESIGN.md(DOCS-01)、`docs/architecture.md` 驾驶舱描述过时(DOCS-02)、无 prettier/watch(DX-04/05)。(spec-feature-flags 幽灵引用已并入 Plan 014。)
- **方向类**(维护者决策):发票 OCR 结构化摄入(DIR-01)· 银行流水对账卡片/UX 收尾(DIR-02,工具已产 structuredContent 但无卡片,见 Plan 016 已知缺口)· golden eval 扩充财务核心场景含算薪冷启动/接续(DIR-03)· 金蝶只读科目接口(DIR-04)· 观测导出「脱敏导出」开关(DIR-05,基于 Plan 007 证据)。

## Findings considered and rejected

- **删除 `lib/integrations/accounting-adapter.ts`(ARCH-06/12)**:**第二轮再次驳回**——第一轮已决定保留为金蝶集成预留接口(DIR-04 证据),非死代码意义上的删除目标。
- **DEBT-06「demo-workflow.ts 是孤儿死代码」**:误报——`app/api/demo/route.ts` 在用 `runDemoWorkflow`。
- **SEC-05 按「漏洞」定级(子 Agent 缺 unwired hook)**:降级——无 skill 的 tools 含 Bash,属纵深防御缺口(已并入第一轮 Plan 002 + 本轮 Plan 022 顺手清理 Bash 死豁免)。
- **CORRECT-07「rg OR 分项注入」**:`--fixed-strings` 已防正则注入,textDir 末位约束搜索根;记录在第一轮 Plan 002。
- **recordInvoices「并发重复发票漏报」按并发竞态定级**:修正——`node:sqlite` 同步 + 单线程,整函数原子,描述的并发竞态不可达;仅崩溃原子性意义,已并入 Backlog/Plan 010 注记,不单独成计划。

## 第七轮 · 动效专项（038–044，基准 `5d26309`，2026-07-13）

| Plan | Title | Priority | Depends on | Status |
|------|-------|----------|------------|--------|
| 038 | 收紧共享原语 transition 属性 | P1 | — | DONE |
| 039 | 键盘触发的全局对话框即时响应 | P1 | — | DONE |
| 040 | 对话动效性能与 reduced-motion | P2 | 043 | DONE |
| 041 | 进度条只走 compositor transform | P2 | — | DONE |
| 042 | 侧栏折叠、选中态与分区连续性 | P2 | 043 | DONE |
| 043 | Motion presets 使用完整 transform | P2 | — | DONE |
| 044 | 预览面板开合与最大化连续性 | P3 | 043 | DONE |

推荐执行顺序已完成：**038 → 043 → 040 → 041 → 039 → 042 → 044**。实现同时通过动效源码契约、typecheck、lint、全量单测与 production build；详见 `docs/spec/audit-improve-animations.md`。

## 第八轮 · bug/UX/UIUX 审计（045–058，基准 `a3e6777`，2026-07-15）

standard 强度，聚焦正确性 bug + UX 流程 + UI 约定（安全/性能/依赖不在本轮范围，前七轮已覆盖）。4 个只读子代理扫描后由主循环逐条开源码核实。用户选择「全部」落计划。

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 045 | 用户消息去重命中时新附件仍落库（修附件静默丢失） | P1 | M | — | DONE — 已审核（S6/S7 新测试，typecheck/直测全绿，合入 bcd024b） |
| 046 | conversationId 穿透到 ExpandedDetail（激活缩略图死代码） | P2 | S | — | DONE — 已审核（三层穿透含 RetryGroupRow，UI 测试 10 断言过，合入 39bce2f） |
| 047 | spawnDetached 等 spawn 事件再 resolve（打开文件失败可见） | P2 | S | — | DONE — 已审核（GET ?action= 纠偏合理，合入 cb3d56e） |
| 048 | withIdempotency 回放失败抛真 Error（消灭 [object Object]） | P2 | S | — | DONE — 已审核（7 项断言全过，合入 65ef1bd） |
| 049 | writeTextMirror 原子写（tmp+rename） | P2 | S | — | DONE — 已审核（tmp+rename+防残留断言，合入 ef91b9f） |
| 050 | fetchConversationFiles 陈旧响应守卫（切会话不串台） | P2 | S | — | DONE — 已审核（id 比对守卫 + null 放行，合入 5a7558d） |
| 051 | 流式进行中禁用「撤回」（防错误恢复覆盖） | P3 | S | — | DONE — 已审核（turnKey 守卫 + disabled 呈现，suppress 111 未变，合入 d928ca2） |
| 052 | run_python 会话信任可撤销（revoke API + 对话内入口） | P2 | M | — | DONE — 已审核+1轮返工（revoke 加 res.ok 门控；ST-f/ST-g 16 断言，合入 f44b142+07f0c08） |
| 053 | 侧栏会话操作失败可见/可回滚/可重试 | P1 | S | — | DONE — 已审核（四步齐 + 回滚正确，nav-v3 全过，合入 28a47a4） |
| 054 | 原生 window.confirm/prompt 替换为应用内对话框（Tauri 兼容） | P1 | S | — | DONE — 已审核（四流程全替换，残留 grep 0，合入 575e736） |
| 055 | 失败态≠空态（知识库/总览/派发/搜索） | P2 | S | — | DONE — 已审核（五文件四步齐，与 054 抽屉自动合并复验绿，合入 3ccaa81） |
| 056 | 流式进行中关窗先确认（Tauri，需桌面实测） | P2 | M | — | DONE(代码) — 已审核（bypass+close 保 Rust kill 路径；桌面实测待人工 tauri:dev，合入 86a5729） |
| 057 | composer 草稿按会话持久化（sessionStorage） | P2 | M | — | DONE — 已审核（惰性初始化+防抖+卸载 flush+发送清除；与 051/052 合并复验绿，合入 c0ad723） |
| 058 | UI 约定清扫（文案/焦点环/disabled/间距/高亮/空态/标签） | P2 | M | 053,054,055 | DONE — 已审核（22 点位全落+4 道 grep 门过；lint 0 error(+2 warn 为 053 重试按钮等 warn 级)，合入 f40e304..a27f5b6） |

### 依赖与编排（第八轮）

- **推荐顺序**：045 → 053 → 054 → 055 → 047 → 048 → 049 → 046 → 050 → 051 → 052 → 057 → 056 → 058。
- **058 必须最后**：与 053（app-nav.tsx）、054（agent-detail-drawer.tsx）、055（knowledge/page.tsx）同文件，先合前三个再清扫。
- **051 与 057** 都动 chat-page.tsx 的 draft 相关代码（不同函数），按序执行可自动合。
- **056** 需本机 Rust 工具链桌面实测；无则完成前端部分后标 BLOCKED 交人工跑 `tauri:dev`。
- 其余互不重叠，可并行。

### 第八轮已核实但降级/不落计划的发现

- **analyze_csv `round(float*100)` 半分边界**：两位小数金额下数学精确，仅 ≥3 位小数出错；发票场景基本不出现，属 Plan 027 既定取舍。不做。
- **sessionStorage pendingChatAttachments 反序列化无形状校验**（use-attachments.ts:45）：纯防御项，当前被 try/catch 与使用场景兜住。记录不修。
- **find-in-chat Esc 陈旧闭包**（find-in-chat.tsx:149-159）与 **ask-user-panel Esc 空依赖闭包**（ask-user-panel.tsx:117-127）：当前分别被 setter 稳定性与调用点 `key={questionId}` 重挂载兜住，纯潜在项。记录不修；若未来移除 key 或改 onClose 语义须回看。
