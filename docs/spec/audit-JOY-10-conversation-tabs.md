# JOY-10 应用级标签 Audit

## v2.2 标题自适应与中性灰复验

- 宽度 RED：原实现下“总览”和“知识库”均被 flex 平均拉伸到约 124px，标题长度没有影响宽度。
- 宽度 GREEN：改为 `flex: 0 1 auto` + `fit-content`；未选中范围 80–208px、选中范围 92–224px，保留最大宽度省略号与选中态适度加宽。
- 颜色 RED：原未选中背景计算为带 a/b 色相分量的 `oklab(...)`，在蓝灰背板上存在偏粉/偏暖错觉。
- 颜色 GREEN：亮暗模式分别使用零色度中性灰 token，并由 E2E 对亮色计算背景做精确中性灰比较。
- 回归：`nav-v3`、typecheck、design-compliance、ESLint（0 errors）、diff check 通过；exact `app-tabs.spec.ts` 最终 `3 passed (1.7m)`。

## v2.1 Files changed（历史，宽度与颜色值已由 v2.2 覆盖）

- `app/shared/nav-state.tsx` — 新增纯 `resolveSelectedAppTabKey`；routeKey 存在时仍以路由为事实源，仅允许已移除的 `page:chat-new` 在 replace 提交前回退到 reducer 中仍存在的真实 conversation activeKey，普通未建签页面不错误回退。
- `app/shared/app-tab-bar.tsx` — 生产渲染直接复用选中态 helper；移除顶部“关闭全部标签”入口但保留 Provider/reducer action；关闭当前标签判断也使用同一选中结果；close 图标缩小到 10px。
- `app/globals.css` — Windows/`?winchrome=1` 标签尾部净空为 6.75rem；close 为 20px、999px 圆角、默认透明且不可命中，hover/focus-within/focus-visible 时显示；active 采用更大 basis、较低 shrink 与 120–256px，inactive 保持 104–224px 并使用淡背景/淡边框；移除暗色 inactive 透明边框覆盖。
- `tests/nav-v3.test.ts` — TDD 覆盖 chat-new 升级竞态、路由优先和普通页面不得错误回退；静态契约补充关闭全部入口不存在、Windows 净空、两档宽度与 999px 圆角。
- `e2e/mock/app-tabs.spec.ts` — 一级页面真实会话内补充关闭按钮显隐/宽度不抖、键盘 Tab+Enter、active 宽度优势和交换、窄窗最小宽度/横向滚动、亮暗色非透明层级、Windows 右侧净空；新对话发送前用 MutationObserver 记录 selected 数量。
- `docs/spec/audit-JOY-10-conversation-tabs.md` — 本 v2.1 实施、RED→GREEN 与门禁证据。

## v2.1 RED → GREEN

- selected helper RED：新增行为测试首次按预期失败为 `TypeError: resolveSelectedAppTabKey is not a function`。
- selected helper GREEN：`page:chat-new` 已被升级移除、active 为仍存在的 `conversation:9` 时返回真实会话；routeKey 已存在时路由优先；普通 `page:knowledge` 尚未建签时返回 null，不高亮旧 `page:files`。AppTabBar 直接复用 helper，`nav-v3` 通过。
- UI 契约 GREEN：移除 close-all UI；设计合规测试确认不再使用非法 9999px 圆角；exact E2E 的一级页面场景已经运行并通过 close 默认/hover、标签宽度不抖、active/inactive 宽度交换、Windows 108px 尾部净空、亮暗色非透明且有层级、窄窗 overflow/min width 与真实键盘 Tab+Enter 关闭断言，之后才在逐标签关闭路由等待处失败。

## v2.1 门禁结果

| 命令 | 结果 |
|---|---|
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/nav-v3.test.ts` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/chat-stream-store.test.ts` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run typecheck` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/design-compliance.test.ts` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run build` | 通过；仅仓库既有 CSS/ESLint warnings |
| `FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | 通过；完整串行契约测试完成 |
| Spec 指定核心文件 ESLint | 0 errors；仅 `chat-page` / `app-nav` 既有 warnings |
| `git diff --check` | 通过 |
| `npx playwright test e2e/mock/app-tabs.spec.ts` | 最终通过；`3 passed (2.1m)` |

Exact E2E 在首次失败定位后按 orchestrator 批准逐项做确定性等待与 URL pathname 修正；最终完整运行：

- PASS：一级页面建签、close 显隐/宽度不抖、真实键盘 Tab+Enter、active 宽度优势与切换交换、窄窗 overflow/min width、亮暗色淡层级、Windows 108px 净空、逐个关闭到 cockpit，`45.1s`。
- PASS：ask-user observer 先等待 `chat:new` 已 selected 再开始采样；meta→recent 与最终标题窗口从未出现 0 selected，关闭/重开/继续同一回合通过，`54.3s`。
- PASS：历史对话进入新对话后的标题、消息、附件、反馈隔离，`3.3s`。

最终结果 `3 passed (2.1m)`。最后的确定性修正只把路由等待改为比较 `new URL(page.url()).pathname`，保留 `?winchrome=1` 用于真实 Windows 预览，不掩盖 query。本轮未创建分支、commit、push 或 PR。

# v2 Files changed

- `app/shared/nav-state.tsx` — 新增并实际接管 Provider 的 `AppTab` 可辨识联合与统一 reducer；页面路由映射、pageKind 单例最新 href、会话去重、`chat-new` 原位升级、混合标签相邻回退和 cockpit 兜底共用同一状态机；异步删除从实时 AppTab ref 取有效 href。
- `app/shared/app-shell.tsx` — 在显式 `Suspense` 中挂载 `RouteTabSync`，由 pathname/search 统一建立或激活一级页面标签。
- `app/shared/app-tab-bar.tsx` — 改为统一渲染页面/会话标签；路由 key 是视觉激活态事实源；所有标签均可关闭。
- `app/chat/chat-page.tsx` — meta 到达时原位升级新对话标签，并用 `router.replace` 真正进入 recent；recent 页继续通过全局 stream store 的真实 ID 解析接管原 turn。
- `app/chat/new/page.tsx` / `app/chat/recent/page.tsx` — 分别使用 `chat:new` 和按 conversation ID 区分的 route key，防止新旧 ChatPage 本地状态复用。
- `app/shared/app-nav.tsx` — 保留 v1 实时删除路由守卫，落点由统一 AppTab 的活动 href 决定。
- `app/shared/chat-stream.tsx` — 保留 v1 已验证的 `c:<id>` 到 `new:<uuid>` 解析和 get/stop/consume 生产 operations。
- `app/globals.css` — 统一标签使用 `flex: 1 1 11rem`、`min-width: 6.5rem`、`max-width: 14rem`，溢出横向滚动，close hover 为圆形热区。
- `tests/nav-v3.test.ts` — 新增 v2 reducer、路由事实源、页面单例/最新 href、原位升级/去重、统一关闭和生产接线契约。
- `tests/chat-stream-store.test.ts` — 关闭行为改用 AppTab reducer，继续证明标签关闭不会丢失后台 turn/controller。
- `e2e/mock/app-tabs.spec.ts` — 新增一级页面建签/切换/关闭，以及 ask-user 阻塞时关闭、真实 ID 重开、继续同一回合的真浏览器验证。
- `docs/spec/audit-JOY-10-conversation-tabs.md` — 追加本 v2 实施审计；v1 审计保留在后作为基线历史。

## v2 RED → GREEN 证据

- 路由/reducer RED：新测试首次失败为 `TypeError: pageTabFromRoute is not a function`；GREEN：页面路由、单例 href、原位升级、去重与关闭兜底全部通过。
- 升级标题 RED：去重升级实际得到“已有”而非“权威标题”；GREEN：目标标签已存在时以当次 DB/meta 标题刷新原位置。
- 路由激活 RED：`TypeError: appTabKeyFromRoute is not a function`；GREEN：页面和 recent ID 均从当前 URL 得到唯一视觉 key。
- 视觉 RED：`JOY-10 v2 FAIL: 标签宽度应自适应在 104–224px 之间`；GREEN：自适应 basis/min/max、横向滚动与圆形 close hover 契约通过。
- E2E：一级页面用例通过；ask-user 用例单独运行 `1 passed (43.0s)`，证明真实 ID/recent、关闭后 cockpit 回退、从最近重开仍显示同一待答问题，提交“方案甲”后完成同一回合。

## v2 计划偏差

- 无计划外业务文件、新依赖、持久化、数据库/API/Tauri 改动。
- 首次将两条 E2E 一起运行时，第一条因多页面首次编译耗时，第二条刚进入 `page.goto('/chat/new')` 时被主动中断，留下的 `ERR_ABORTED` 是中断证据而非产品断言失败；随后只单跑 ask-user 一次并通过，未无限重试。

## v2 最终门禁

| 命令 | 结果 |
|---|---|
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/nav-v3.test.ts` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/chat-stream-store.test.ts` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run typecheck` | 通过 |
| `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run build` | 通过；仅仓库既有 CSS/ESLint warnings |
| `FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | 通过；`pass 11 / fail 0`，约 52s |
| `npx playwright test e2e/mock/app-tabs.spec.ts` | review round 1 后 exact 命令一次完整通过；`3 passed (2.7m)` |
| Spec 指定核心文件 ESLint | `0 errors / 11 warnings`；4 条 `chat-page` 与 7 条 `app-nav` 均为 v2 前既有 warning |
| `git diff --check` | 通过 |

本实施未创建分支，未 commit/push，未创建 PR。

## v2 实现审查 round 1（fix first）

- **完整 E2E 确定性**：`beforeAll` 串行 warm 本 spec 覆盖的 Next dev 路由，待 HTTP 成功后才开始 UI 导航，避免客户端点击与首编译 frame replacement 竞态。
- **ask-user 重开定位**：历史会话 locator 收窄到 `navigation[aria-label="主导航"]` 内，不再使用全页 raw href，避免顶部标签与侧栏的严格模式多匹配。
- **新对话隔离真浏览器回归**：先用真实 xlsx 附件建立历史对话 A，确认旧用户消息、文件名和反馈操作已渲染；再从 recent A 点击侧栏“新对话”，验证 H1/空态问候已重建，旧消息、附件文件名和反馈操作全部不存在。
- **敏感性 RED**：仅移除 route key 时，当前 `router.replace` 仍会使页面重建，用例直接通过，因此不将它当作 RED。随后局部回退到已知旧基线组合（无 new/recent key + `window.history.replaceState`），URL 已到 `/chat/new`，但 30s 内找不到 H1“新对话”，断言按预期 RED；trace 记录于当次 `test-results/.../历史对话.../trace.zip`。
- **GREEN**：完整恢复 `router.replace` 与 `chat:new` / `chat:recent:<id>` key 后，exact `npx playwright test e2e/mock/app-tabs.spec.ts` 一次运行三条均通过：页面建签 `55.2s`，ask-user 关闭/重开/继续 `1.0m`，历史 A → 新对话隔离 `3.8s`，总计 `3 passed (2.7m)`。
- round 1 后复验：`nav-v3` 通过，`typecheck` 通过，`git diff --check` 通过。最终生产代码与 round 1 前的 v2 实现一致，本轮持久改动只是 E2E 确定性/隔离回归与 audit。

# v1 Files changed（历史基线）

- `app/shared/nav-state.tsx` — 增加并实际复用纯会话标签 reducer；Provider 暴露打开、激活、关闭、关闭全部动作；同步 state ref 保持异步 DELETE 等待期间的实时标签状态；运行期最新标题可先于标签到达；提供删除后的纯路由决策，以及由完成态 effect 实际复用、可行为测试的标题同步 helper。
- `app/shared/app-tab-bar.tsx` — 将 Linear 单页签扩展为运行期对话标签列表，支持切换、单独关闭、关闭全部、生成状态提示和可访问关闭按钮。
- `app/chat/chat-page.tsx` — 历史对话加载成功和新对话获得真实 ID 时注册并激活标签；done/incomplete 收尾把 `finalConversation.title` 同步到页面本地标题与 Nav 标签标题单一源。
- `app/shared/chat-stream.tsx` — 增加真实 conversation key 到原始运行 key 的统一解析，以及生产 Provider 与测试直接共用的公开 operations 工厂；`getTurn`、`stopTurn`、`consumeTurn` 均由工厂提供。
- `app/shared/app-nav.tsx` — DELETE 返回后读取实时 URL；仅仍停留在被删对话时按 reducer 结果跳转到右邻、左邻或总览。
- `app/globals.css` — 增加 Linear 风格多标签活动态、溢出、关闭控件和生成状态样式。
- `tests/nav-v3.test.ts` — 增加标签 reducer 的去重、激活、相邻关闭、关闭全部、删除、标题先到后打开、meta→done 最终标题同步和 DELETE 等待期间邻居关闭的实时路由行为测试；直接执行生产完成态标题 helper，验证 done/incomplete 的真实 ID/标题参数与非完成态不调用。
- `tests/chat-stream-store.test.ts` — 直接调用生产 operations 工厂返回的三个公开形态动作，验证真实 ID 回退、同一临时 key/controller、真实 abort/consume，以及关闭标签后重开仍可见 turn。
- `docs/spec/audit-JOY-10-conversation-tabs.md` — 本实施审计。

## 实现结果

- 同一会话 ID 在运行期只保留一个标签，重复打开会激活并刷新其权威标题。
- 关闭当前标签按右邻优先、左邻兜底；没有剩余标签时进入 `/cockpit`。关闭非当前标签保持当前路由。
- 普通页面保留静态页签，新对话在获得真实 ID 前显示不可关闭的“新对话”；已打开的对话标签在普通页面仍可见并可返回。
- 关闭标签不调用 `stopTurn`，不删除流式 turn；真实 `c:<id>` 可解析到仍在运行的 `new:<uuid>` key。
- 标签状态仅存在于现有 `NavStateProvider` 的内存状态中；未增加持久化键、数据库/API/依赖或 Tauri 改动。
- 标题事件先于标签注册时会暂存在 reducer 的运行期 `latestTitlesById`；后续打开标签优先采用该标题，删除对话时清理，应用重启不保留。
- DELETE 请求等待期间若用户已切换到其他对话或页面，响应返回后不会再触发旧删除动作的路由跳转。
- DELETE 等待期间若原候选邻居被关闭，完成后从 Provider 的实时标签 state ref 重新取得有效右邻、左邻或空落点，不使用请求开始时的快照。

## Reviewer fix-first 修复

- 修复标题时序：`updateTitle -> open` 的纯 reducer 回归测试证明旧标题不会覆盖先到的权威标题。
- 修复 store 行为证据：`createStreamTurnOperations` 返回与 Context 相同签名的 get/stop/consume，Provider 直接使用工厂方法；测试也直接调用同一生产工厂，用真实 `AbortController` 证明 stop abort，consume 删除同一 turn/controller，标签关闭不影响 turn 且真实 ID 重开仍可见。
- 修复异步删除路由：DELETE 完成后从 `window.location` 获取实时路由，再由纯 helper 决策；测试覆盖仍在被删会话、已切其他会话、已切其他页面三类路径。
- 最终修复删除邻居竞态：所有标签 action 同步更新 Provider state ref；DELETE 返回时才生成结果。行为测试覆盖“删除目标开始等待 → 原右邻关闭 → 响应完成”，最终改用仍存在的左邻。
- 用户 D1 授权的单点修复：`consumeTurn` 首次解析后固定真实 `resolvedKey`；延迟 state updater 只删除该 key，不再按外部 `c:<id>` 二次解析。回归测试在 updater 执行前插入同会话新精确 turn，证明只删除旧临时 turn/controller，新 turn/controller 保留。
- 用户 F1 授权的单点修复：手工 UI 证明新会话 H1 已取 `finalConversation.title`，但 done 收尾未调用 Nav 标题入口，标签停留在 meta 阶段的“新对话”。现在同一 done/incomplete 分支以 `realId + finalTitle` 调用 `updateConversationTitle`，同步侧栏摘要与已打开标签。
- F1 reviewer round 1：原 reducer 行为 + 源码字符串只能分别证明 action 有效和文本存在，不能证明生产完成态把正确参数传给 Nav。提取 `syncCompletedConversationTitle`，由生产 effect 直接调用；helper 自己限定 done/incomplete，并接收真实 conversation ID、final title 与两个 sink。
- F1 reviewer round 2：独立 reviewer 裁决 `ship`；完成态标题同步逻辑无需继续修改。

## 与计划的偏差

- 功能范围与批准的 v1.1 Spec 一致，无功能偏差。
- 2026-07-16 按用户 E1 授权执行桌面端手工 UI 验证时发现阻塞：新会话完成后 URL 已切到 `/chat/recent?id=1`，页面 H1 已显示权威标题“测试多标签：第一条对话”，但选中的顶部标签仍显示“新对话”。因此未继续多标签、窄窗和发布验证，也未提交或创建 PR。
- F1 round 2 ship 后重新执行桌面 UI，原标题阻塞已关闭：新会话完成后 URL 为 `/chat/recent?id=2`，页面 H1 与活动标签均显示“F1 标题同步完整验证”。
- 完整 UI 继续验证时发现新的发布阻塞：从已完成会话 `id=3` 点击侧栏“新对话”后，URL 已变为 `/chat/new`，侧栏“新对话”链接也呈 active，但主内容仍保留 `id=3` 的 H1“后台生成关闭后重开验证”和旧消息，没有进入新会话空态。现场无 Next/Vite overlay，console error 为空。
- 因 `/chat/new` 主内容未重置，本轮未继续后台生成关闭后重开、窄窗、主题与窗口控制区验证；不得发布，且未创建分支、commit、push 或 PR。
- worktree 初始没有 `node_modules`，通过仓库自带 `node scripts/link-worktree-node-modules.mjs` 链接到主工作区依赖，没有安装或修改依赖。
- Spec 中原始完整回归命令首次运行时因 worktree 缺少 `workers/.venv/bin/python3` 输出 `ENOENT`；改用主工作区已有 Python runtime 的 `FINANCE_AGENT_PYTHON_PATH` 后完整回归通过。未修改 Python/runtime 文件。

## 测试结果

通过：

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/nav-v3.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/chat-stream-store.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run typecheck
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npx eslint app/shared/app-tab-bar.tsx app/shared/nav-state.tsx app/shared/chat-stream.tsx app/shared/app-nav.tsx
```

- 两项 JOY-10 定向测试通过。
- TypeScript 类型检查通过。
- 完整测试套件通过；套件按既有设计输出若干预期错误路径日志和可选 OCR skip，不影响退出状态。
- Reviewer fix-first 三项修复后再次完整运行测试套件：11 项 Node test 汇总全部通过（`pass 11 / fail 0`），其余串行契约测试也全部完成。
- 最终 fix-first 的实时邻居与公开 operations 修复后再次全量运行：`pass 11 / fail 0`，总耗时约 56 秒；所有串行契约测试完成。
- D1 单点修复后重新运行 `chat-stream-store`、typecheck、`app/shared/chat-stream.tsx` ESLint 与 diff check，全部通过；该变更只收紧已覆盖的 consume 竞态，未再次运行全量套件。
- F1 TDD 红证据：新增 meta 打开“新对话”→ done 得到“生成后的真实标题”的 reducer 行为断言后，生产接线断言失败，错误为 `F1 FAIL: 新会话 done 的最终权威标题应同步到 Nav 标签标题单一源`。
- F1 绿证据：补充 done/incomplete 的 Nav 标题接线后，`nav-v3`、typecheck、diff check 全部通过；`chat-page.tsx` ESLint 为 0 errors，保留 4 条既有 hooks/unused warnings，本轮接线未引入 warning。
- F1 reviewer round 1 红证据：行为测试先调用尚不存在的生产 helper，按预期失败为 `TypeError: syncCompletedConversationTitle is not a function`；这证明测试不再依赖源码字符串判断行为。
- F1 reviewer round 1 绿证据：行为测试直接执行生产 helper，证明 done 把 `{ id: 17, title: "完成标题" }`、incomplete 把 `{ id: 18, title: "部分完成标题" }` 传给 Nav sink，error 不调用；`nav-v3`、typecheck、diff check 通过，核心 ESLint 0 errors（`chat-page.tsx` 仍为 4 条既有 warnings）。
- JOY-10 核心新改文件的定向 ESLint 为 0 errors；`app-nav.tsx` 保留 7 条既有外观规则/未使用 disable warnings，本轮新增路由守卫未引入 warning。其余三个核心文件为 0 warnings。

## 2026-07-16 历史手工 UI 复验（v2.1 前，已被最终复验覆盖）

已通过：

- F1 标题同步：新会话完成后 `/chat/recent?id=2`，H1 与活动标签同为“F1 标题同步完整验证”。
- 多标签打开与切换。
- 关闭非活动标签，当前会话保持不变。
- 关闭活动标签，正确落到左邻标签。
- 关闭全部标签，正确进入 `/cockpit`。
- 删除活动会话后，对应标签移除并进入 `/chat/recent?id=1`。

当时未执行：

- 后台生成中关闭标签并按真实 ID 重开。
- 窄窗口横向溢出。
- 深浅主题、标签活动态与窗口控制区净空。

当时未执行原因：点击侧栏“新对话”后 URL/侧栏 active 已切换，但主内容仍停留旧会话，无法建立可信的新会话空态继续后续步骤。该问题已由 v2.1 的路由隔离与 exact E2E 覆盖解除，最终状态见下节。

## v2.1 最终复验与剩余风险

- 全新独立 reviewer 裁决 `SHIP`，并独立复跑 `nav-v3`、`chat-stream-store`、typecheck、diff check 与 exact App Tabs E2E；E2E 结果为 `3 passed (2.6m)`。
- exact E2E 已覆盖新对话主内容隔离、meta 原位升级、最终标题同步期间选中态连续、后台回合关闭后重开、窄窗横向滚动、亮暗主题、活动/非活动宽度与层级、Windows 108px 净空及键盘关闭；此前本节记录的发布阻塞已解除。
- 桌面浏览器补充复验：`/cockpit` 无框架错误覆盖层；顶部无关闭全部入口；单标签关闭按钮默认 `opacity: 0`、宽度 20px，键盘 focus-within 后为 `opacity: 1`；`?winchrome=1` 下 `--window-controls-inset` 为 `6.75rem`，标签列表实测保留 108px。
- 当前无已知发布阻塞。尚未创建分支、commit、push 或 PR；这些外部发布动作不在本轮已执行范围内。
