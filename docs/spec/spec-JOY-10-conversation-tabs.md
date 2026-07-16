# JOY-10 应用级多标签 Spec

> 版本 v2.2 / 2026-07-16
> 状态：v2.2 标签宽度与中性灰修正已实施并通过回归
> 用户授权：H1，直接按完整应用级标签方案重构；不再由 Linear 或 automation 驱动
> 基线：工作区保留此前尚未提交的对话标签、后台 turn key、删除路由与标题同步修复；本方案在其上演进，不撤销已通过的行为。

## v2.1 标签视觉与活动态修复

用户在 v2 实现后新增并明确授权以下六项调整；本节覆盖 v2 中冲突的关闭全部与视觉规则。

### v2.1 产品契约

1. 顶部标签栏不再显示“关闭全部标签”按钮；底层 `closeAll` reducer/API 可保留供内部测试或未来入口使用，本轮不做无关公共状态重构。
2. 标签栏最右侧必须预留窗口三键净空。现有 macOS 系统红绿灯在左侧、Windows 三键在独立标题栏；本轮不重排窗口控件，只新增 `--window-controls-inset`：默认 `0.5rem`，Windows/`?winchrome=1` 预览约 `6.75rem`，作为标签栏 `padding-inline-end`。
3. 新对话 meta 先升级标签、Next `router.replace` 尚未提交时，不得出现 0 个活动标签。增加纯 helper `resolveSelectedAppTabKey(routeKey, activeKey, tabs)`：当前 routeKey 仍存在时优先；**仅当 routeKey 为已被升级移除的 `page:chat-new` 且 activeKey 指向仍存在的 conversation 标签时**回退 activeKey；普通 A→尚未建签 B 不得回退高亮 A。标题更新前后最终真实 conversation 标签必须保持选中。
4. 单标签关闭按钮缩小为约 20×20px，图标约 10px；默认透明且不可鼠标命中，仅在标签 hover、focus-within 或按钮 focus-visible 时显示。按钮始终占位，不使用 `display:none`，避免标签宽度抖动并保留键盘可达性；圆形半径使用仓库设计门禁允许的 `999px`，不使用 `9999px`。
5. 活动标签必须明显但适度长于非活动标签：非活动使用约 `flex: 1 1 10.5rem`、104px min、224px max；活动标签使用不同的 basis 与更低 shrink（建议 `flex: 1.25 0.6 12rem`）、120px min、256px max。这样正剩余与负剩余区间均保持 active 更宽；切换活动态后宽度优势随之交换；达到最小宽度后继续横向滚动。
6. 非活动标签不得完全透明：亮/暗色统一使用淡背景和淡边框，active 使用完整 `var(--background)` + `var(--border)`，inactive 使用现有语义 token 的低透明混合，hover 使用 `var(--accent)`。删除暗色下 inactive border 完全透明的覆盖。

### v2.1 成功标准

- [x] 顶部不存在“关闭全部标签”按钮，单标签关闭与相邻回退继续有效。
- [x] Windows/`?winchrome=1` 下标签列表最右保留约 108px，不进入窗口三键区域；其他平台保留常规尾部间距。
- [x] 新对话从输入、meta、标题更新到 recent 路由稳定期间，tablist 始终恰好有一个 `aria-selected=true` 标签；最终真实标题标签被选中。
- [x] 关闭按钮默认不可见，hover 与键盘 focus 时可见；显隐前后标签 bounding box 宽度不变。
- [x] 同一可用宽度下 active 标签宽于 inactive；切换后宽度关系交换；多标签达到最小宽度后横向滚动。
- [x] 浅色/深色下 inactive 均有可辨识的淡背景和淡边框，但视觉层级弱于 active。

### v2.1 TDD 切片与文件

1. 在 `app/shared/nav-state.tsx` 与 `tests/nav-v3.test.ts` 先为 `resolveSelectedAppTabKey` 写 RED：routeKey=`page:chat-new` 已不存在、activeKey=`conversation:9` 仍存在时返回 conversation；正常情况下 routeKey 优先；普通 routeKey=B 尚未入 tabs 时不得返回旧 activeKey=A。GREEN 后 AppTabBar 必须直接复用 helper。
2. 在 `app/shared/app-tab-bar.tsx` 移除关闭全部 UI 和无用解构/函数；E2E 改为断言按钮不存在，并继续验证逐个关闭回退。
3. 在 `app/globals.css` 和标签 JSX 完成右侧 Windows 净空、active 宽度优势、inactive 淡背景/边框、20px hover-only close；`tests/nav-v3.test.ts` 只做必要静态契约补充。
4. 在 `e2e/mock/app-tabs.spec.ts` 增加行为验证：发送新对话前安装 MutationObserver，直到 recent + 最终标题出现期间从未观察到 0 个 selected；验证 close 默认/hover 与宽度不抖，并用真实键盘 Tab/Shift+Tab 到达隐藏关闭按钮、Enter 关闭；在受限宽度验证 active 宽于 inactive且切换后关系交换；在窄 viewport 打开足够标签，断言 tablist `scrollWidth > clientWidth`、inactive/active 不低于各自 104/120px 最小宽度且 active 仍更宽；Windows 预览下列表尾端不进入控制区；亮暗色 inactive/active 的 computed background 与 border 不同且均非透明。

v2.1 最小 Files touched：`app/shared/nav-state.tsx`、`app/shared/app-tab-bar.tsx`、`app/globals.css`、`tests/nav-v3.test.ts`、`e2e/mock/app-tabs.spec.ts`、本 Spec 与 audit。若真实验证证明现有平台探测无法提供 Windows 净空，implementer 必须停止并报告，不得自行重排 `WindowTitleBar`。

## v2.2 标题自适应与中性灰修正

- 标签不再平均瓜分剩余宽度，改为按标题内容自适应：未选中 80–208px，选中 92–224px；超出最大宽度继续由标题 `truncate` 显示省略号。
- 选中同一标签时仍会比其未选中状态适度加宽，但短标题不会被默认拉满。
- 未选中标签使用零色度中性灰 token：亮色 `oklch(0.96 0 0)`，暗色 `oklch(0.22 0 0)`；不再与蓝灰 `shell-canvas` 混色，避免出现偏粉或偏暖错觉。

## 0. 目标与非目标

**目标**：把顶部“对话标签”升级为一次应用运行期间的浏览器式应用标签。总览、智能体、知识库、对话文件、技能、设置、新对话和多个历史对话都进入同一套打开、激活、关闭与相邻回退模型；同时修复从历史对话进入 `/chat/new` 后旧标题、消息和附件残留的问题。

**非目标**：

- 不持久化标签，不新增 localStorage、数据库字段、迁移或 API。
- 不实现拖拽排序、固定标签、跨窗口、恢复上次会话或标签右键菜单。
- 不改变聊天生成、停止、消费和落库语义；关闭标签仍只关闭视图，不停止后台任务。
- 不把开发、E2E、预览等非一级产品路由纳入标签系统。
- 不引入新依赖，不修改 Tauri 主进程。
- 本期是“路由标签/最近位置”模型，不同时挂载多个普通页面实例；普通页面切走后，其未持久化的滚动、筛选或草稿状态不保证保活。对话后台生成由现有全局 `ChatStreamProvider` 单独保证。

## 1. 产品与交互契约

### 1.1 标签类型与唯一性

- 使用可辨识联合 `AppTab`，状态只保存渲染和导航所需字段，不保存 React icon：
  - 页面标签：`kind: "page"`，稳定 key 为 `page:<pageKind>`，保存 `pageKind`、`title`、`href`。
  - 对话标签：`kind: "conversation"`，稳定 key 为 `conversation:<id>`，保存 `conversationId`、`title`、`href`。
- 页面类型包括 `cockpit`、`chat-new`、`agents`、`knowledge`、`files`、`skills`、`config`。
- 同一页面类型只保留一个标签；页面内 query 或详情路径变化时更新该标签的最新 `href`，不新增标签。
- 同一 conversation ID 只保留一个标签；再次打开时刷新标题与 href，并激活原位置，不移动排序。

### 1.2 打开、升级和路由同步

- `AppShell` 内新增置于 `<Suspense>` 下的客户端 `RouteTabSync` 子组件；只有该子组件读取 `usePathname` + `useSearchParams` 并建立或激活一级页面标签，因此侧栏、快捷键、搜索结果和页面内 Link 不需要各自维护一套标签调用，也不让 AppShell 根组件产生生产构建的 CSR bailout。
- `/chat/recent?id=<id>` 由 `ChatPage` 在取得 DB 权威标题后建立/激活对话标签；当前路由决定活动态。
- `/chat/new` 进入单例临时页面标签 `page:chat-new`。
- 新对话收到服务端 meta 的真实 conversation ID 后，将 `page:chat-new` **原位替换**为 `conversation:<id>`；若目标对话标签已存在，则去重并激活已有标签。随后必须使用 Next `router.replace('/chat/recent?id=<id>')` 完成真实路由切换，不再用 `window.history.replaceState` 只改地址栏。
- 页面标签的 icon 与标题由 `pageKind` 的常量映射渲染，状态层不依赖图标组件。

### 1.3 关闭与回退

- 关闭非活动标签：只移除该标签，当前 URL 不变。
- 关闭活动标签：优先进入右邻，其次左邻。
- 关闭最后一个标签时建立并进入默认 `cockpit` 标签，应用不出现空白工作区；内部 `closeAll` action 保留纯状态测试，但不提供顶部 UI 入口。
- 删除对话：移除对应对话标签；若删除的是当前路由，复用同一相邻回退结果。
- 关闭任何标签都不得调用 `stopTurn`、`consumeTurn` 或删除后台 turn/controller。

### 1.4 新对话状态隔离

- 从历史对话进入 `/chat/new` 时，新的 ChatPage 实例不得继承旧 conversation ID、标题、消息、附件、生成文件、反馈或文件面板状态。
- meta 后的 `router.replace` 必须真正进入 recent page；在路由页面边界为 new/recent 提供稳定且不同的 React key，使 ChatPage 本地状态按路由身份重建。recent 新实例通过现有 `stream.getTurn('c:<id>')` / `resolveTurnKey` 接管仍以 `new:<uuid>` 运行的 turn；`ChatStreamProvider` 保持在 AppShell 上层，后台任务不因页面实例重建而停止。
- 从一个历史 conversation ID 切到另一个 ID 时也使用不同 route key；重新打开生成中的对话后由现有 store 解析逻辑接管对应 turn。

### 1.5 视觉与自适应宽度

- 每个应用标签均可关闭；关闭按钮 hover 热区使用圆形或接近圆形的圆角，消除生硬的小方框观感。
- 标签采用同一 flex 尺寸契约：理想宽度约 `176px`、最大约 `224px`、最小约 `104px`。
- 标签少时共享剩余空间并自然变宽；标签增加时共同收窄；达到最小宽度后标签列表横向滚动。
- 标题保持单行省略；关闭按钮、状态点和窗口控制区不被压缩。
- 深浅色下活动、hover、非活动和关闭按钮 hover 均使用现有语义 token。

## 2. 成功标准

- [ ] 总览、智能体、知识库、对话文件、技能、设置和新对话可建立、切换、关闭标签。
- [ ] 普通页面按 pageKind 单例；相同历史对话按 conversation ID 单例。
- [ ] 页面内部 query/详情变化更新原标签 href，不产生重复标签。
- [ ] 新对话临时标签在真实 ID 到达后原位升级，标题完成后同步更新。
- [ ] 关闭活动标签右邻优先、左邻兜底；非活动关闭不改路由；逐个关闭到最后一个时回到唯一总览标签。
- [ ] 删除当前与非当前对话继续满足统一标签与路由规则。
- [ ] `/chat/recent?id=A -> /chat/new` 不残留 A 的标题、消息、附件和文件状态。
- [ ] 关闭生成中的标签不停止任务；按真实 ID 重开仍可看到、停止或消费同一任务。
- [ ] 标签少时变宽、多时收窄，最小宽度后横向滚动；关闭 hover 更圆；深浅色和窗口控制区正确。
- [ ] 定向行为测试、类型检查、完整测试、核心 ESLint、diff check 和桌面端完整 UI 验证通过。

## 3. Files touched

| 文件 | 动作 | 计划改动 |
|---|---|---|
| `app/shared/nav-state.tsx` | 修改 | 把 ConversationTabs reducer 演进为 AppTabs reducer；加入页面路由解析、单例打开、临时新对话原位升级、统一关闭回退和标题同步 |
| `app/shared/app-shell.tsx` | 修改 | 增加 Suspense 内的 RouteTabSync，观察 pathname/search 并为一级页面建立/激活标签；把路由身份传给标签栏 |
| `app/shared/app-tab-bar.tsx` | 修改 | 渲染统一 AppTab、页面 icon、对话状态点、切换和单独关闭；不渲染关闭全部入口 |
| `app/chat/chat-page.tsx` | 修改 | 新会话 meta 时升级临时标签并用 router.replace 真实进入 recent page；recent 实例从全局 store 接管原 turn；保留 DB/完成态标题同步 |
| `app/chat/new/page.tsx` | 修改 | 为新对话 ChatPage 提供明确 route key，确保旧本地状态不复用 |
| `app/chat/recent/page.tsx` | 修改 | 按 conversation ID 提供 route key，确保历史会话间本地状态隔离 |
| `app/shared/app-nav.tsx` | 修改 | 保留现有删除路由修复并改为统一 AppTab 删除结果 |
| `app/shared/chat-stream.tsx` | 保留/必要时最小修改 | 保留已实现的真实 conversation key 到临时运行 key 解析；只在新回归暴露问题时改动 |
| `app/globals.css` | 修改 | 统一应用标签自适应 flex 宽度、最小宽度横向滚动、更圆关闭 hover、深浅色状态 |
| `tests/nav-v3.test.ts` | 修改 | 逐个 TDD 覆盖 AppTab reducer、路由映射、页面单例、新对话升级、关闭回退、标题/删除与生产接线 |
| `tests/chat-stream-store.test.ts` | 保留/必要时补充 | 继续证明关闭/重建 ChatPage 不影响后台 turn，真实 ID 重开命中同一任务 |
| `e2e/mock/app-tabs.spec.ts` | 新增 | 用真实浏览器路由覆盖应用页面建签/切换/关闭，以及“历史对话 → 新对话”不残留旧内容 |
| `docs/spec/audit-JOY-10-conversation-tabs.md` | 修改 | 记录 v2 实际 diff、逐轮红绿证据、审查结论、测试和 UI 证据 |

超出列表的业务文件必须先由 orchestrator 更新 Spec；implementer 不得自行扩散范围。

## 4. TDD 垂直切片

严格一次一个行为，先观察新增测试失败，再写最少代码转绿；不得先批量写完所有测试。

1. **页面标签 tracer bullet**：给定总览路由，公开 route helper 生成 `page:cockpit`，reducer 打开并激活；随后让 `AppShell` 使用同一 helper。
2. **页面单例与最新 href**：重复打开 knowledge/files/skills 等 pageKind 不新增标签，只更新 href 并激活。
3. **统一关闭**：混合页面与对话标签时验证右邻、左邻、非活动关闭；逐个关闭到最后一个时得到单一 cockpit 标签及 `/cockpit`；closeAll 只保留 reducer 定向测试。
4. **新对话升级**：`page:chat-new` 在数组原位置升级为 `conversation:<id>`，重复目标去重，完成态标题继续更新同一标签。
5. **对话删除**：删除对话标签后沿用统一 active key/href；异步 DELETE 仍读取实时 state ref。
6. **页面接线**：AppShell 的 Suspense RouteTabSync、ChatPage 历史打开/meta 升级 + router.replace、标签栏 router push 使用生产 helper；只增加必要的源码契约作为行为测试补充。
7. **ChatPage 隔离与接管**：公开 route-key helper 对 new、recent A、recent B 产生稳定且不同的 key，new/recent page 实际使用；行为/E2E 证明 meta 后进入 recent 不丢流、recent A→new 清空、recent A→recent B 隔离。
8. **视觉契约**：CSS 使用可伸缩 basis/max/min，移除标签上的 `shrink-0`，最小宽度后列表滚动，关闭按钮使用圆形圆角；最终以真实桌面 UI 验证为准。

## 5. 验证命令

```bash
cd /Users/gyro/.codex/worktrees/66fb/finance-agent-public

FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/nav-v3.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/chat-stream-store.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run build
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
npx playwright test e2e/mock/app-tabs.spec.ts
npx eslint app/shared/nav-state.tsx app/shared/app-shell.tsx app/shared/app-tab-bar.tsx app/shared/app-nav.tsx app/shared/chat-stream.tsx app/chat/chat-page.tsx app/chat/new/page.tsx app/chat/recent/page.tsx
git diff --check
```

桌面 UI 必须覆盖：

1. 依次打开总览、智能体、知识库、对话文件、技能、设置，验证单例、切换、关闭。
2. 打开至少三个历史对话，混合页面标签验证活动/非活动、首/中/尾关闭，并逐个关闭到最后一个验证 cockpit 兜底；确认界面不存在“关闭全部标签”按钮。
3. 新对话空态、meta 原位升级、最终标题同步。
4. 从历史对话切新对话，验证标题、消息、附件、生成文件和文件面板不残留。
5. 使用 mock Agent 的 ask-user 确定性阻塞脚本：发送“这两个方案我该选哪个”，等待真实 ID、recent 路由和待答面板出现；此时关闭活动对话标签，按捕获的真实 ID 重开，确认仍显示同一待答问题，再选择方案提交并验证回合完成/消费。该流程无需依赖 12ms 普通流式窗口；若 ask-user 脚本变化，才退回为该 Playwright webServer 显式设置足够的 `FINANCE_AGENT_MOCK_AGENT_DELAY`。
6. 宽窗少标签变宽；逐步增加标签观察收窄；窄窗达到最小宽度后横向滚动。
7. 浅色/深色的活动态、hover、圆形关闭 hover、键盘焦点与窗口控制区净空。

## 6. 风险与约束

- **路由是活动态事实源**：reducer 的 activeKey 只用于关闭回退，视觉选中必须由当前 pathname/search 推导，避免状态与 URL 分叉。
- **页面单例不等于固定 href**：query/详情路由需覆盖原 tab.href，切回时回到最近位置。
- **临时标签升级竞态**：真实 conversation 标签已存在时必须去重，不能同时保留 chat-new 与重复 conversation 标签。
- **React key 与后台任务边界**：只重建 ChatPage，不重建 ChatStreamProvider；否则会破坏关闭后继续生成。
- **地址栏替换不等于路由切换**：禁止继续用 `window.history.replaceState` 完成 new→recent；必须由 Next router.replace 触发 recent page 与 route key 生效。
- **Next search 参数边界**：`useSearchParams` 只存在于 AppShell 内显式 Suspense 包裹的 RouteTabSync 和已有边界中；生产构建是门禁的一部分。
- **删除异步竞态**：DELETE 返回时继续基于实时 AppTabs state 选择落点，不使用请求开始时快照。
- **发布门禁**：任何定向测试、完整回归、独立 reviewer 或桌面 UI 失败都不得创建 PR；先记录证据并修复。

## 7. 审查与审计

- 方案必须由全新 reviewer 审查；阻塞问题修正后才交 implementer。
- 代码由 implementer 编写，主循环不自审实现。
- 实施完成后 audit 以 v2 Files changed 开头，记录每个 tracer bullet 的 RED 与 GREEN 证据、计划偏差、全部命令结果和 UI 证据。
- 实现由另一个全新 reviewer 审阅 Spec + audit + 范围内 diff，裁决 `ship` 或 `fix first`；fix-first 最多两轮。
