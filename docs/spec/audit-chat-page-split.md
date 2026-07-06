# audit-chat-page-split

> 任务：WP9a chat-page 巨石拆解第一刀（纯结构搬迁，行为零变化）
> 实施日期：2026-07-06
> 实施分支：claude/strange-mendel-cfd23e

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `app/chat/chat-page.tsx` | 修改 | 抽出私有组件和 hooks 后只剩装配层；1823→1073 行 |
| `app/chat/components/assistant-turn.tsx` | 新增 | AssistantTurn + ThinkingStatusLine + TimelineRow + useLiveElapsed + getDisplayContent + stripLegacyThinking + formatDuration + fileNameFromStoragePath |
| `app/chat/components/user-bubble.tsx` | 新增 | UserBubble（含 rounded-2xl → Surface token 收敛） |
| `app/chat/components/file-tray.tsx` | 新增 | FileTray |
| `app/chat/components/mention-popup.tsx` | 新增 | MentionPopup |
| `app/chat/hooks/use-chat-navigation.ts` | 新增 | findOpen/findInitial + URL ?find= 参数读取 + useShortcutEvent("find-in-chat") |
| `app/chat/hooks/use-attachments.ts` | 新增 | attachments/referencedAttachments/conversationFiles/generatedFiles 状态 + addFiles/removeAttachment/fetchConversationFiles |
| `tests/chat-features.test.ts` | 修改 | chatContent 拼接路径扩为文件集（含4个新组件文件），断言字符串不变 |

（无 `tests/chat-hooks.test.ts`：hooks 无可独立测试的纯逻辑——useAttachments 的 addFiles 依赖 fetch/readAttachment，useChatNavigation 依赖 DOM/window；最小单测无法在 Node mock 环境运行，audit 说明不创建。）

（`tests/all.test.ts` 未追加：没有新增 chat-hooks.test.ts。）

## hooks 切割清单与参数量

### use-chat-navigation.ts
**拥有**：`findOpen`（state）、`findInitial`（state）、URL `?find=` 读取 effect、`useShortcutEvent("find-in-chat")` 订阅

**参数**：1 个（`setFilePanelOpen`）

**说明**：交叉最少（不依赖 conversationId/turn/draft），按 spec 必切。`setFindInitial` 由 hook 内部 URL 读取 effect 调用，不需暴露给 chat-page.tsx。

### use-attachments.ts
**拥有**：`attachments`、`referencedAttachments`、`conversationFiles`、`conversationFilesLoaded`、`generatedFiles` 状态；`addFiles`、`removeAttachment`、`fetchConversationFiles` 函数；sessionStorage 消费 effect；conversationId 变化时拉文件 effect

**参数**：1 个（`conversationId`）

**说明**：文件面板自动弹开逻辑（`shouldDefaultOpenFilePanel`/`shouldAutoOpenOutputPanel` effects）留在 chat-page.tsx，依赖多个 ref；刻意不并入 hook 以避免将 refs 作为参数注入造成耦合。初版设计了 4 个 ref 参数（`setFilePanelOpen/userClosedPanelRef/panelDefaultResolvedRef/outputCountRef`），实施后发现 hook 内部从未使用，已精简为 1 个参数。

### 技能菜单 + @提及网（保留主文件）
`handleDraftChange`、`selectMentionFile`、`selectSkill`、`openSkillMenu`、`getFilteredSkills`、`getFilteredMentionFiles`，及相关 6 个 state（mentionActive/mentionFilter/mentionAtPos/mentionSelectedIdx/skillMenuActive/skillFilter/skillAtPos/skillSelectedIdx）——handleDraftChange 是状态枢纽，引用 7+ 个主作用域值；selectMentionFile 依赖 draft/textareaRef/mentionAtPos/mentionFilter/setReferencedAttachments。切出后参数明显超过 7 且有 stale closure 风险，整体留主文件，audit 说明。

## 12 处 rounded 逐处处置

原始文件行号（L1xxx 属搬迁后的新文件位置）：

| 原始行 | 位置 | 内容 | 处置 | 目标文件 |
|---|---|---|---|---|
| L987 | quickPrompts button | `rounded-xl` | `surfaceVariants({ level: "card", edge: "hairline", shape: "panel" })` | chat-page.tsx |
| L1008 | composer form | `rounded-2xl` | `surfaceVariants({ level: "card", edge: "hairline", shape: "overlay" })` via `cn()` | chat-page.tsx |
| L1084 | Add (+) button | `rounded-full` | `surfaceVariants({ level: "page", edge: "none", shape: "pill" })` via `cn()` | chat-page.tsx |
| L1197 | UserBubble 消息气泡 | `rounded-2xl` | `surfaceVariants({ level: "page", edge: "none", shape: "overlay" })` via `cn()` | user-bubble.tsx |
| L1554 | 重试按钮 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1564 | 复制按钮 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1577 | 点赞按钮 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1593 | 踩踩按钮 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1621 | 反馈标签 | `rounded-full` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1632 | 反馈文本框 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1640 | 提交按钮 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |
| L1651 | 跳过按钮 | `rounded` | eslint-disable（交互元素豁免，WP8a 规则） | assistant-turn.tsx |

容器类（4 处）用 `surfaceVariants()` 提取 token class；Surface 组件不直接用于非 div 元素（form/button 等），改为 `cn(surfaceVariants({...}), "...其他 class")` 模式。UserBubble 的气泡 div 用 `surfaceVariants` 而非 `<Surface>` 组件以避免引入额外 `bg-background` 与 `shadow-[var(--elevation-1)]`（level="page"/edge="none" 输出空 bg+edge class，tailwind-merge 无歧义）。

## 与计划的偏差

### 偏差1：`tests/chat-float.test.ts:75` 哨兵折断（未在 spec 清单中）

**现象**：`chat-float.test.ts` 第 75 行断言 `chat-page.tsx` 必须包含 `from "@/app/chat/markdown-message"` 或 `from "./markdown-message"`。原 `chat-page.tsx` 直接使用 MarkdownMessage，重构后 MarkdownMessage 移至 `assistant-turn.tsx` 和 `user-bubble.tsx`，`chat-page.tsx` 不再直接 import。

**后果**：Node 测试运行器输出 `# Error: A resource generated asynchronous activity after the test ended`（unhandledRejection）；`# fail 0`（测试计数不含异步断言失败）。

**处置**：此测试文件不在 spec 的 Files touched 列表，修改它超出授权范围。修改 `chat-page.tsx` 添加死 import 会引入 lint unused-var 警告。架构事实：chat-page 模块系统通过 assistant-turn.tsx / user-bubble.tsx 传递性依赖 markdown-message.tsx，共享模块唯一实现的不变量仍成立。已在 audit 记录，待 reviewer 裁决：① 修改 chat-float.test.ts 扩展读取路径（推荐）；② 或接受此次偏差。

**规则符合性**：spec §1 哨兵规则"除此清单外发现其他哨兵断言折断：停下报告"——已停下记录，未自行修改规则外文件。

### 偏差2：`TimelineItem` 类型从主文件提取为导出

`TimelineItem` 类型原来定义在 `chat-page.tsx` 主作用域，由 AssistantTurn 和主函数共用。搬迁后定义并导出于 `assistant-turn.tsx`，`chat-page.tsx` 以 `type TimelineItem` 形式 re-import。行为零变化，但 `TimelineItem` 的"权威定义位置"变了。这是不可避免的结构性影响，已在 spec §1 中预见（"只改 import/export，不改实现"）。

### 偏差3：`fileNameFromStoragePath` 保留为死代码

spec §1 明确："`fileNameFromStoragePath`（L1697）经 grep 确认零引用是死代码，随搬并在 audit 标注（本刀不删，删除留给独立清理任务）"。已搬至 `assistant-turn.tsx` 并以注释标注死代码，未删除。

### 偏差4：`use-attachments.ts` 参数从 5 个精简为 1 个

设计时准备了 5 个参数（含文件面板 refs），实施后发现文件面板自动弹开逻辑保留在 chat-page.tsx 侧效，hook 内部从未读取这些 refs。精简为 1 个参数更干净，no stale closure 风险，符合 spec "≤7 参数不视为纠缠信号" 的标准。

## 基线对照测试结果

**基线（重构前）**：
- `npm test`：11 tests, 11 pass, 0 fail
- `npm run typecheck`：通过（零错误）
- 存在预先存在的异步 unhandledRejection：`F3-T4a FAIL: asOf 应为 2026-02` (finance-tools-f3.test.ts，与本任务无关)

**重构后**：
- `npm test`：11 tests, 11 pass, 0 fail
- `npm run typecheck`：通过（零错误）
- 新增异步 unhandledRejection：`A3 FAIL: chat-page.tsx 应改为引用共享的 markdown-message 模块` (chat-float.test.ts:75，详见偏差1)
- 预存 F3-T4a 错误仍存在（无关）

**chat 相关测试全过**：
- chat-features: 所有 10 个断言通过（含 fileNameFromStoragePath / stripLegacyThinking / ToolStepList 哨兵，已扩展拼接路径）
- shortcuts-wiring: 全部通过（useShortcutEvent("toggle-file-panel") 保留在 chat-page.tsx）
- settings-skills-redesign: 全部通过（initialSkill ? [initialSkill] : [] 保留在 chat-page.tsx）

**e2e**：环境未启动（`npm run test:e2e:serve` 需本地服务器，非 mock 环境）；已如实记录。

## 行数对比

| 文件 | 行数 |
|---|---|
| chat-page.tsx（重构前） | 1823 |
| chat-page.tsx（重构后） | 1073 |
| components/assistant-turn.tsx（新） | ~590 |
| components/user-bubble.tsx（新） | ~75 |
| components/file-tray.tsx（新） | ~55 |
| components/mention-popup.tsx（新） | ~40 |
| hooks/use-chat-navigation.ts（新） | ~50 |
| hooks/use-attachments.ts（新） | ~80 |

chat-page.tsx 行数下降 41%（750 行），未达到 ≤500 的指标，原因：技能菜单+@提及网的 8 个 state + 3 个 handler（约 200 行）留在主文件；sidebar+layout 的 handlers（约 100 行）留在主文件；turn 收尾 effect + 流式逻辑（约 150 行）留在主文件。所有保留均符合 spec §1 "不引入 stale closure > 平移完整性 > 行数" 的硬约束优先级。

## 开放风险

1. **chat-float.test.ts:75** 哨兵折断待处理（见偏差1）
2. **技能菜单+@提及网** 未切 hook：handleDraftChange 引用 7+ 个主作用域值，切出后参数超限，spec 允许留主文件（"默认整体留在主文件"）
3. **文件面板 auto-open refs** 留主文件：`panelDefaultResolvedRef/userClosedPanelRef/outputCountRef` 需与 conversationFiles effect 紧耦合，不适合作为 hook 参数
