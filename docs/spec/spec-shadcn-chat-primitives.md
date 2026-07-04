# Spec: shadcn 对话基础组件接入

> 状态：已实施，最终 E2E 复跑受环境额度限制
> 日期：2026-07-04
> 范围：全屏对话页的滚动容器、运行中状态标记与 shimmer；不改变 Agent、SSE、工具、问答、附件和持久化契约。

## 1. 目标

把 shadcn 2026-06 发布的三个能力接入现有全屏对话页：

1. `MessageScroller` 接管对话滚动、流式跟随、用户上滚释放和回到底部按钮。
2. `Marker` 统一非交互状态行的结构与无障碍语义。
3. 官方 `shimmer` utility 替换项目自维护的 `.fa-shimmer-text`。

接入只替换展示层基础设施。现有 `Message`、`AgentEvent`、`StreamTurn`、`TimelineItem` 和请求协议保持不变。

## 2. 当前真实链路

### 2.1 消息与流式状态

- `app/shared/chat-stream.tsx` 持有跨页面存活的 `StreamTurn`，SSE chunk 和 agent event 分别进入 `streamedContent` 与 `timeline`。
- `app/chat/chat-page.tsx` 的 `displayMessages` 在历史消息上叠加当前用户消息和流式助手消息。
- `AssistantTurn` 从 `timeline` 构造过程段，继续负责工具、Bash、系统事件、问答摘要、附件、错误和最终答案。
- 因此 `MessageScroller` 只能包装消息行，禁止接管或重塑上述状态。

### 2.2 当前滚动实现

全屏对话页目前自行维护：

- `threadRef`：滚动容器，同时供 `FindInChat` 建立文本索引。
- `threadEndRef`：末尾锚点。
- `shouldStickToBottomRef`：用户是否仍在跟随最新输出。
- `showScrollToBottom`：自定义回到底部按钮显隐。
- `[displayMessages]` effect：每个流式更新执行 `scrollIntoView({ behavior: "smooth" })`。
- `handleThreadScroll`：以 96px 为阈值判断用户是否离开底部。

这套逻辑必须整体迁移，不能和 `MessageScroller` 并存，否则会出现双重滚动、位置抢占和按钮状态不一致。

### 2.3 不能破坏的旁路

- `FindInChat` 依赖滚动 viewport 的 DOM ref，并通过 `Range` + `scrollIntoView` 跳到命中。
- `AskUserPanel` 位于输入框上方，不在消息滚动容器里；未答问题仍必须阻断普通输入。
- Bash/工具详情是 `AssistantTurn → ToolStepList → ToolCallStep` 的嵌套交互，滚动组件只把整条 assistant turn 当作一个 row。
- 文件预览侧栏会改变聊天列宽，但不改变消息结构。
- `app/shared/chat-float.tsx` 是独立简化小窗，且明确不渲染工具卡/确认门，本期不迁移。

## 3. 上游组件与版本约束

### 3.1 已核实的 registry 变更

`npx shadcn@latest add message-scroller marker --dry-run` 报告：

- 新增 `components/ui/message-scroller.tsx`
- 新增 `components/ui/marker.tsx`
- 新增运行时依赖 `@shadcn/react`
- 尝试覆盖 `components/ui/button.tsx`

禁止覆盖现有 `Button`。仓库版本包含自定义 `text-meta`、`text-caption` 与 `icon-btn` token/类，直接覆盖会影响大量页面。实施时只添加两个新文件，并让 MessageScroller 复用现有 `Button`。

### 3.2 CSS utility 兼容

仓库 lockfile 当前解析为 `shadcn@4.11.1`，其 `dist/tailwind.css` 尚无 `shimmer` 和 `scroll-fade`；官网最新 CLI/npm 版本为 `4.13.0`。因此必须：

- 把 devDependency `shadcn` 升到兼容新 utilities 的版本；
- 保留 `app/globals.css` 的 `@import "shadcn/tailwind.css"`；
- 验证构建产物包含 `.shimmer`、`.scroll-fade-b`；
- 不复制一份同名 utility 到项目 CSS，避免后续双源漂移。

`@shadcn/react@0.2.0` 的 peer requirement 是 React 19，当前项目满足；包解压约 26KB，实际客户端 bundle 由 tree-shaking 决定。

## 4. 设计决策

### D1 — MessageScroller 只包裹主消息 transcript

结构：

```tsx
<MessageScrollerProvider
  autoScroll
  defaultScrollPosition="end"
  scrollEdgeThreshold={96}
>
  <MessageScroller>
    <MessageScrollerViewport ref={threadRef}>
      <MessageScrollerContent>
        {displayMessages.map((message, index) => (
          <MessageScrollerItem
            key={...}
            messageId={...}
          >
            {/* 原 UserBubble / AssistantTurn 原样保留 */}
          </MessageScrollerItem>
        ))}
      </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton />
  </MessageScroller>
</MessageScrollerProvider>
```

- `defaultScrollPosition="end"` 保留当前打开历史会话时落在末尾的行为；暂不改成官网推荐的 `last-anchor`。
- `scrollEdgeThreshold={96}` 保留当前“距底部 96px 内仍算跟随”的手感，避免采用上游 8px 默认值造成行为突变。
- 持久化消息使用 `message:${message.id}` 作为 `messageId`；流式临时消息不伪造数据库 ID。React row key 继续保持当前稳定规则。
- viewport 保留 `[scrollbar-gutter:stable_both-edges]`，防止滚动条出现时 800px 内容列偏心。
- 删除旧 `threadEndRef`、stick ref、按钮 state、滚动 effect、scroll handler 和 `shouldShowScrollToBottom` 调用。
- 首期不启用 `scrollAnchor`：当前 store 同批追加临时 user+assistant，并在 done 后立即替换为 DB 消息；实测上游自动锚定会与 following-bottom 结算竞争。现有产品语义本就是跟随底部，先保持不变。历史锚点导航作为独立功能另行设计。

### D2 — 查找继续使用 viewport ref

`threadRef` 直接传给 `MessageScrollerViewport`。`FindInChat` 的公开行为保持：

- 能索引当前 transcript 的可见 DOM 文本；
- Enter/Shift+Enter 可在匹配间跳转；
- 跳转命中会释放自动跟随，不被下一批 token 立即拉回底部。

如果 `content-visibility: auto` 在目标 WKWebView 上导致自定义查找漏文本，首选从本地 `MessageScrollerItem` 去掉该优化，不改查找协议。

### D3 — Marker 只用于非交互状态行

接入位置：

- `ThinkingStatusLine`：`role="status"`，`MarkerIcon` 放 `ThinkingSpark`，`MarkerContent` 放状态文本。
- `TimelineRow`：系统/压缩等普通说明行。

明确不替换：

- `ToolCallStep`、重试组和工具详情按钮；它们有展开、错误、计时和 Bash 高亮语义。
- 过程区 `<details>/<summary>`；它是交互控件，不是 marker。
- `AskUserPanel`；它是阻断式表单。

### D4 — 官方 shimmer 使用项目语义 token

把四处 `.fa-shimmer-text` 替换为官方 `shimmer`：

- 起手“正在思考”
- “正在处理”摘要
- 运行中工具行
- ask-user 的“正在询问”

文字基色显式使用 `text-muted-foreground`；如需要保留品牌色扫光，只允许使用 `shimmer-color-primary`，不得写死颜色。官方 utility 已内置 `prefers-reduced-motion` 降级。

完成后删除：

- `.fa-shimmer-text`
- `@keyframes fa-shimmer`
- reduced-motion 中针对 `.fa-shimmer-text` 的重复规则

## 5. 不变量

接入后以下行为必须保持：

1. 流式正文逐 token 出现，最终消息仍以服务端落库消息为权威。
2. 工具 `tool_use/tool_result` 配对、运行时间、错误、重试和结构化卡片不变。
3. Bash 输入输出仍能在技术模式展开并保持代码高亮。
4. `ask_user` 未答时仍替换输入区；回答后继续同一回合。
5. `usage_blocked`、`turn_incomplete`、停止生成和继续按钮不变。
6. 附件、生成文件、预览侧栏、反馈和复制全文不变。
7. 暗色模式、项目 typography token 和 reduced-motion 生效。

## 6. TDD 垂直切片

严格一条行为一个 RED→GREEN，不先批量写测试。

### Slice 1 — transcript 使用单一滚动控制器

**RED**：新增对话滚动契约测试，要求主对话页挂载 `MessageScroller`，且旧 `scrollIntoView`/stick/button state 不再控制 transcript。

**GREEN**：添加依赖和本地组件文件，仅完成 transcript 包装与旧滚动逻辑删除。

**验收**：现有 mock 对话能发送并完成；对话区域有 `region`/`log` 语义；没有双重回到底部按钮。

### Slice 2 — 流式跟随尊重用户意图

**RED**：Playwright 用延迟 mock 产生长流式回复：位于 live edge 时输出持续可见；用户上滚后后续 token 不把 viewport 拉回；点击回到底部后重新跟随。

**GREEN**：启用 `autoScroll`、96px threshold 和官方 button，按测试调整容器尺寸/refs。

### Slice 3 — 查找兼容

**RED**：扩展现有 `find-in-chat` E2E，跳到较早命中后继续收到 token，命中仍保持在视口中。

**GREEN**：确保 `threadRef` 指向 viewport；必要时关闭 item 的 `content-visibility`。

### Slice 4 — Marker 与 shimmer

**RED**：状态语义与样式契约测试要求运行中状态有 `role=status`、使用 `.shimmer`、不再出现 `.fa-shimmer-text`，reduced-motion 由官方 utility 提供。

**GREEN**：迁移两个 Marker 位置和四处 shimmer，删除旧 CSS。

### Slice 5 — 回归工具/问答/Bash

不为现有行为重写实现；运行已有公开旅程：

- `e2e/mock/chat.spec.ts`：普通流式、工具卡、ask-user、多工具流程、附件/markdown。
- `e2e/mock/find-in-chat.spec.ts`：全文查找。
- `tests/chat-stream-store.test.ts`：流式 store 与收尾叠加。
- `tests/tool-call-step-ui.test.ts`、`tests/chat-process-polish.test.ts`：工具/Bash/过程展示。

## 7. 文件级改动

预计修改：

- `package.json`
- `package-lock.json`
- `components/ui/message-scroller.tsx`（新增，保留项目 Button/token）
- `components/ui/marker.tsx`（新增）
- `app/chat/chat-page.tsx`
- `app/components/tool-call-step.tsx`
- `app/components/ask-user-panel.tsx`
- `app/globals.css`
- `tests/all.test.ts`
- 新增定向测试和/或扩展 `e2e/mock/chat.spec.ts`、`e2e/mock/find-in-chat.spec.ts`

不修改 API route、数据库 schema、Agent 工具或共享事件类型。

## 8. 验证门

每个 slice 先跑定向测试。全部完成后运行：

```bash
FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_MOCK_AGENT_DELAY=0 SKIP_LLM=true npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e:fast -- e2e/mock/chat.spec.ts e2e/mock/find-in-chat.spec.ts
```

另做一次 Chromium 与 Tauri/WKWebView 手工检查：滚动 fade、暗色、reduced-motion、长 Bash 展开后的锚点稳定性。

## 9. 风险与回退

| 风险 | 控制措施 |
|---|---|
| 两套滚动逻辑并存 | Slice 1 直接删除旧控制器，源码契约负面断言 |
| registry 覆盖项目 Button | 不执行 overwrite，手工合并新增文件 |
| shadcn CSS 版本过旧 | 升级并验证 utility 构建产物 |
| active message 无稳定 DB id | 不伪造 id；锚定依赖 row 元素，持久化后再注册 messageId |
| FindInChat 与 `content-visibility` 冲突 | E2E 守卫，必要时移除该单项优化 |
| 工具详情展开改变行高导致跳动 | 覆盖 live-edge/用户上滚两态；让 MessageScroller 的 ResizeObserver 单独处理 |
| WKWebView 不支持 scroll-driven fade | utility 有 fallback；视觉异常时先去掉 fade，不回退滚动行为 |

回退边界清晰：移除 provider/组件包装并恢复旧滚动控制器即可，消息和后端状态没有迁移成本。

## 10. 待确认决策

1. 首期按本 spec 只迁移全屏聊天，不动 `ChatFloat`。
2. 历史会话继续默认打开到末尾，不改为 `last-anchor`。
3. 首期不启用新回合顶部锚定，保持当前 live-edge 语义。
4. shimmer 默认跟随 `text-muted-foreground`；品牌主色高光仅在视觉验收认为太弱时加入。
