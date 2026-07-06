# chat-page 巨石拆解·第一刀（WP9a：纯结构搬迁，行为零变化）Spec

> 版本 v1.1 / 2026-07-06（v1.0 fix first → 修订 → 限定范围复审**批准**）
> 状态：**已实施并通过审查（ship）**。实施审查零阻塞：纯平移逐块核实无逻辑改写；hooks 参数各 1 个；哨兵三处更新语义保持。已知接受项：e2e mock 冒烟未跑（audit 如实记录，纯结构迁移风险低）；chat-float 哨兵由 orchestrator 按既定规则修复。
> 依赖：WP8a（已ship）。**WP9 衔接契约**：拆出的组件按 spec-ui-foundation.md 的 Surface API 收敛外观类（chat-page 现存 12 处 rounded 在本刀顺带处置——spec-ui-foundation 附录 A 已把它划给 WP9）。
> 架构事实（2026-07-06 scout 摸底）：`app/chat/chat-page.tsx` 1737 行单文件——L1-130 约 30 个 import；L131-277 状态与 refs 声明（30+ useState、useMemo 派生 displayMessages/persistedTimelines、useChatStream，refs 到 L276 mainRef）；**L278-876 handlers 与 useEffect**（约 600 行，从 handleSidebarDividerDown 起）；**L877-1144 渲染 JSX**（return 起于 L877）——行段地图经 reviewer 逐行核实修正（v1.0 的 250/700 分界错了约 400 行）（RoleModeProvider > 两列布局：消息列 map(UserBubble/AssistantTurn) + AskUserPanel 浮层 + ComposerArea(FileTray/textarea/SkillPopup/MentionPopup/DeepThinkToggle)）；L1146-1837 文件末尾私有组件：UserBubble(1146)、AssistantTurn(1206)、useLiveElapsed(1667)、ThinkingStatusLine(1680)、TimelineRow(1702)、FileTray(1726)、MentionPopup(1776)。测试运行器 tests/all.test.ts 手动列表；chat 相关既有测试：chat-features/chat-panel-state/chat-preview-selection/chat-stream-store/chat-process-polish 等。

## 0. 目标与非目标

**目标**：第一刀只做**无行为变化的结构搬迁**，把巨石拆成可独立演进的模块：① 文件末尾私有组件搬出为独立文件；② 状态与副作用收敛为自定义 hooks；③ 顺带完成本文件 12 处 rounded 的处置（容器收敛+交互豁免，见 §1）。目标态 `chat-page.tsx` 只剩装配与布局（行数目标见 §1 优先级条款）。**渲染输出与交互行为逐位不变**。

**非目标**：
- 不做"按消息类型注册式渲染"（那是 WP9b——注册机制是新抽象，等本刀落定再上）；
- 不改任何 UI 行为/样式/文案；不动 useChatStream（已是独立 hook）；
- 不拆 ComposerArea 内部逻辑链（技能/@提及弹层的状态耦合密，第一刀只搬得动的）。

## 1. 成功标准

- [ ] 新目录 `app/chat/components/`：user-bubble.tsx、assistant-turn.tsx（含 ThinkingStatusLine/TimelineRow/useLiveElapsed 同文件，引用关系紧密）、file-tray.tsx、mention-popup.tsx——从 L1146-1837 平移，只改 import/export，不改实现。**主作用域自由工具函数的归宿（reviewer B1）**：`getDisplayContent`/`formatDuration`/`stripLegacyThinking`（均为无闭包自由函数）随 assistant-turn.tsx 一起搬并导出；`fileNameFromStoragePath`（L1697）经 grep 确认零引用是死代码，随搬并在 audit 标注（本刀不删，删除留给独立清理）。
- [ ] 新 hooks `app/chat/hooks/`，**切割优先级按纠缠度排序（reviewer B2）**：① `use-chat-navigation.ts`（URL 参数/滚动/find-in-chat，交叉最少，必切）；② `use-attachments.ts`（附件/paste/drag&drop；与 draft/textareaRef 有交叉，通过参数传入，参数可控则切）；③ 技能菜单+@提及网（handleDraftChange 是状态枢纽，selectMentionFile 引用 7+ 个主作用域值）——**默认整体留在主文件**，除非切出后参数 ≤7 且无 stale closure 风险。切不动的留主文件在 audit 说明，**不为了拆而重写逻辑**。
- [ ] **哨兵测试处置（reviewer A2）**：以下测试用 readFileSync 对 chat-page.tsx 源码做字符串断言，平移后必断——处置规则统一为**把新组件/hook 文件路径追加进它们的源码拼接列表，断言字符串本身不变**（行为验证语义保持，只是验证范围扩为拆分后的文件集）：`tests/chat-features.test.ts:186`（fileNameFromStoragePath）、`:198`（stripLegacyThinking）、`tests/shortcuts-wiring.test.ts:10`（useShortcutEvent，若随 hook 搬移）、`tests/settings-skills-redesign.test.ts:29`（initialSkill 表达式，state 留主文件应不受影响，验证即可）。除此清单外发现其他哨兵断言折断：停下报告。
- [ ] chat-page.tsx 行数显著下降；**硬约束优先级（reviewer B4）：不引入 stale closure > 平移完整性 > 行数**——≤500 行是次优先指标，为凑行数强切纠缠 state 即 fix first；每个新 hook 的参数量在 audit 报告，>7 个视为纠缠信号需说明理由。全部既有 chat 测试跑绿（哨兵类按上一条规则更新拼接路径）；e2e mock 冒烟跑绿。
- [ ] 外观类收敛（reviewer B3 核实实为 **12 处 rounded**，非 5 处）：L987 rounded-xl（quickPrompt）、L1008/L1197 rounded-2xl（composer/气泡）、L1084 rounded-full 等容器类收敛为 Surface/token；L1554/1564/1577/1593/1621/1632/1640/1651 的裸 rounded 均为交互元素（按钮/input/标签），按 WP8a 豁免规则 eslint-disable 并注明。audit 逐处列出 12 处的处置。
- [ ] TDD 边界：纯搬迁没有新行为可写红测试——纪律改为**搬迁前先跑绿基线并记录**（全量+e2e 输出存 audit），搬迁后同命令对照零回归；新 hooks 若有可独立测试的纯逻辑（如附件去重），补最小单测并注册 all.test.ts。
- [ ] typecheck/lint 绿；新文件零 eslint 护栏告警（新代码不许带外观类散落）。

## 2. Files touched

| 文件 | 动作 |
|---|---|
| `app/chat/chat-page.tsx` | 修改：抽出后只剩装配 |
| `app/chat/components/user-bubble.tsx` 等 4-6 个 | 新增：平移 |
| `app/chat/hooks/use-attachments.ts` 等 3 个 | 新增：切割 |
| `tests/chat-hooks.test.ts` | 新增（如有可测纯逻辑；没有则省略并在 audit 说明） |
| `tests/all.test.ts` | 修改（若新增测试） |
| `tests/chat-features.test.ts` | 修改（哨兵拼接路径扩为文件集，断言字符串不变） |
| `tests/shortcuts-wiring.test.ts` | 修改（同上，视 hook 搬移情况） |
| `tests/settings-skills-redesign.test.ts` | 验证（state 留主文件应免改；若受影响按哨兵规则处理） |

实施中发现必须动列表外文件（例如某私有组件被外部文件引用），停止报告。

## 3. 实施步骤

1. 基线：跑全量测试+e2e mock 冒烟，输出存档（audit 用）。
2. 平移私有组件（一次一个，每移一个跑 typecheck）：保持 props 类型原样导出。
3. 切割 hooks：先圈定每个 hook 拥有的 state/effect/handler 清单写进 audit，再机械搬移；跨 hook 依赖用参数传递，禁止新建 context。
4. 按 §1 清单处置 12 处 rounded（容器收敛对照 WP8a variant 表，交互元素豁免注明）。
5. 对照基线复跑全部验证。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test && npm run typecheck && npm run lint
npm run test:e2e:serve   # 终端1
npm run test:e2e:fast    # 终端2（chat 流程用例必须过）
```

## 5. 风险与开放问题

- **最大风险是隐性闭包耦合**：handler 们共享 30+ state，切割时容易漏依赖造成 stale closure。缓解：hooks 切割清单先行（步骤 3）+ e2e 冒烟必跑。reviewer 审 diff 时重点看 hook 参数是否完整。
- 1737→≤500 的量意味着 diff 大但**几乎全是平移**——reviewer 按"移动+改 import"审，发现任何逻辑改写（哪怕"顺手优化"）即 fix first。
- 被否决：① 一步到位上消息类型注册机制（新抽象与大搬迁混在一个 diff，审不动）；② 用 barrel export（index.ts 再导出，加一层间接无收益）。
