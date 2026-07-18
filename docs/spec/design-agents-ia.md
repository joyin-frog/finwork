# 智能体 IA 重构 · 设计总纲 + 实施交接

> 设计与用户五轮确认收敛（2026-07-16/17）。分支 `claude/session-1-d34af2`，worktree `confident-williamson-02801b`。**5 刀已实施+真机验证+全绿，未提交**；余 4 项待续。
> 交互稿：https://claude.ai/code/artifact/f2755cbf-adbe-44d1-bce3-de676e20e166 （v4，可点击）
> 相关记忆：agent-menu-strengthen-initiative（E 节）
>
> **续接一句话**：读本文件「六、实施交接」→ 按「待办刀」挑一刀 → 照其「文件/做法/坑/验证」实施 → 高风险刀（迁移/运行时）完成后派 reviewer 独立审。
>
> **进度速览**：
>
> | 刀 | 内容 | 状态 |
> |---|---|---|
> | 1 | 导航壳（A 侧栏分组 + B1 工作台骨架 + 概况页签） | ✅ ship |
> | 2 | 工作页签三态预览（B2/B3） | ✅ ship |
> | 3 | 启停开关（B6） | ✅ ship |
> | 4 | 相关对话（B5） | ✅ ship |
> | 5 | 独立记忆 C（第一版，不含自动沉淀） | ✅ ship（经 reviewer，修掉 1 BLOCKER） |
> | 6 | C 自动沉淀 | ✅ ship（2026-07-17，机制与粒度经用户拍板，见刀6节） |
> | 7 | E 专员会话（和它对话） | ✅ ship（2026-07-17，v19 迁移 + 运行时装配 + UI 标识，见刀7节） |
> | 8 | D 越权转交排队 | ✅ ship（2026-07-18，v20 迁移 + propose_transfer + 排队态 + 结果回流；经 reviewer 修 1 BLOCKER+1 HIGH+3 MEDIUM，真机验证排队组/移除端到端） |
> | 9 | F1 删花名册 + F3 标签适配 | 🟨 F3+工作台抛光见 `spec-agents-ia-ui-polish.md`；F1 仍待办 |

## 一、背景与现状事实

- 「智能体」已是一级菜单（`app/shared/app-nav.tsx` → `/agents`），现 `/agents` 页 = 团队视图（等你拍板 `AttentionPanel` + 角色卡 2 列 + 右侧 `AgentDetailDrawer` 抽屉）+「本月任务」看板切换。
- 用户始终与主管（orchestrator）对话；角色经 `spawn_subagent`（`lib/agent/mcp-tools/subagent.ts`）派发，对话流渲染"派给{角色}:{label}"（`lib/agent/tools/renderers.ts`）。角色从不直接与用户对话。
- 角色 = `lib/agent/roles/registry.ts` 的 `ROLE_REGISTRY` 纯数据（name/domain/charter/skills/tools/dataScope/rolePrompt），运行时零角色分支；每次派发是独立 `sdk.query`。
- 会话与角色是多对多：`lib/db/sqlite.ts` `getRecentConversations` JOIN `subagent_dispatches` 聚合出 `roleIds[]`（现仅 cockpit `recent-work-card.tsx` 消费）。
- 产物链路已有：子代理 `finalize_deliverable` → dispatch `label`/`files` 列 → 抽屉「文件产物」内嵌 `FilePreviewPage`。
- 「派任务」现状 = `buildTemplateDispatchHref`（`lib/agent/roles/task-templates.ts`）→ `/chat/new?prompt=…`（仅支持 `prompt`/`skill` 两个参数）。

## 二、核心决策（已拍板）

1. **花名册页取消**：`/agents` 团队视图（等你拍板 + 角色卡）删除。等你拍板归总览页（已有同源 `deriveAttentionItems`）；卡片信息与工作台重复。
2. **侧栏「智能体」父项 = 纯分组开关**：点击只展开/收起，不导航、无落地页。徽标 = 待拍板总数（**不计在忙**——徽标只代表"需要你"）。
3. **点角色 = 进全页工作台**（`/agents/<roleId>`），替代抽屉。
4. **对话不进角色菜单**：会话永远在全局「最近」；一条会话可涉及多角色（roleIds 数组），塞进任何单一角色菜单都不对。角色下挂的是**任务**（dispatch），不是对话框。
5. **专员会话（直聊）成立**：允许绕过主管单独和某专员对话；**归入工作台「相关对话」页签**（与主管会话混排，靠角色标识区分）。
6. **越权即引导**：职责 + 数据权限双重边界；职责外请求不硬拒，给一键转交卡；**转交走异步队列**（进目标角色排队组，结果回原对话），不当场拉人进会话。
7. **记忆自动沉淀**：任务中的用户确认/纠正自动写入角色记忆，对话内轻提示「已记住这条口径」；不要求用户手动"教"。

## 三、功能点清单

### A. 侧栏（`app/shared/app-nav.tsx`）

| # | 功能点 | 要点 |
|---|---|---|
| A1 | 父项开关化 | 「智能体」整行点击 = 展开/收起（状态持久化，同 `pinnedOpen`）；移除导航；chevron 随开合旋转 |
| A2 | 待拍板徽标 | 父项行尾红色计数徽标；数据与总览 attention 同源；收起时仍可见（收起态唯一"有事"信号）；无事项不显示 |
| A3 | 角色子列表 | 展开显示启用角色行：状态点（在忙=主色呼吸 / 待拍板=alarm 红 / 空闲=空心，复用会话列表状态点体系）+ 角色名 + 行尾状态短文案；未启用角色置灰或不显示 |
| A4 | 子项直达 | 点角色行 → `/agents/<roleId>`；当前角色高亮（active pill 体系） |

### B. 角色工作台（新页 `/agents/<roleId>`）

| # | 功能点 | 要点 |
|---|---|---|
| B1 | 路由与骨架 | 动态路由替代现团队视图；头部 = 角色头像/名称/domain/状态 + 「和它对话」+「派任务」；四页签：工作（默认）/ 记忆 / 相关对话 / 概况；无返回上级（无花名册可回） |
| B2 | 任务流水（工作页签左列） | dispatch 记录按状态分组：**等你拍板 → 进行中 → 排队 → 已交付**，疑点永远在前；行 = 状态标签 + 任务名 + 时间 |
| B3 | 右侧产物预览 | 复用 `ResizablePreviewPanel`；按任务状态三态：**待拍板**=疑点卡逐条 +「去处理」（跳回会话拍板）+「全部通过」；**进行中**=实时步骤（✓/●）+ 跳会话；**已交付**=文件产物内嵌 `FilePreviewPage` + 打开/下载。所有预览标注来源会话可跳回。拍板动作只在对话里完成，预览只做入口（防表单化退行） |
| B4 | 记忆页签 | 见 C 节；列表 + 单条删除 + 来源任务标注 + "仅本角色可见"说明 |
| B5 | 相关对话页签 | 按 roleIds 过滤全局会话（数据已在 `getRecentConversations`）+ 该角色的专员会话（role_id 精确匹配）；行内标注类型（"涉及：薪税+税务" / 专员会话角色头像）；点击跳转会话 |
| B6 | 概况页签 | 职责范围（✓ 列表）、边界（✗ 列表 + 越权转交对象）、数据权限（dataScope）、**启用/停用开关**（自花名册卡片迁入；停用 = 不接受派发 + 侧栏置灰） |
| B7 | 派任务 | 保留现有机制：模板菜单 → `/chat/new?prompt=…`（主管派发、对象化进看板）；与「和它对话」职责区分：派任务=结构化任务，直聊=轻量问答 |

### C. 独立记忆系统（每角色）

| # | 功能点 | 要点 |
|---|---|---|
| C1 | 按角色隔离存储 | 记忆按 roleId 分区，互不共享（隔离即隐私边界：如分析师无薪酬明细记忆）；主管不自动继承角色记忆 |
| C2 | 自动沉淀 | 任务/会话中的用户确认与纠正自动写入；写入时对话内轻提示「已记住这条口径」；不做手动"教记忆"入口 |
| C3 | 可追溯可管理 | 每条标注来源任务/会话 + 日期；工作台记忆页签可单条删除（后续可编辑） |
| C4 | 运行时注入 | 派发（`subagent-runner`）与专员会话构建上下文时加载该角色记忆 |

### D. 越权边界与转交

| # | 功能点 | 要点 |
|---|---|---|
| D1 | 边界数据化 | 角色边界（不可做事项 → 转交对象映射）落 `ROLE_REGISTRY` 或派生数据，供概况页签展示与运行时提示复用 |
| D2 | 转交卡 | 角色（派发中或专员会话中）收到职责外请求：份内照做，份外说明双重边界（职责+数据权限）+ 转交卡；上下文自动带过去，用户不重新描述 |
| D3 | 异步队列 | 转交生成目标角色的排队任务（dispatch 新增排队态），出现在其工作台「排队」组；预览给「现在开始 / 移除」 |
| D4 | 结果回流 | 转交任务完成后结果回到原发起对话 |

### E. 专员会话（直聊）

| # | 功能点 | 要点 |
|---|---|---|
| E1 | 会话角色维度 | `conversations` 加 `role_id`（NULL=主管会话，现状零改动）；迁移编号遵守 [[migration-numbering-across-worktrees]] 三查 |
| E2 | 入口 | 工作台头部「和它对话」→ `/chat/new?role=<roleId>`（`/chat/new` 新增 `role` 参数）；默认「新对话」仍是主管 |
| E3 | 运行时装配 | 系统提示 = 角色 rolePrompt B 段；`allowedTools` = 角色工具白名单（比主管更窄）；数据域 = dataScope；记忆 = 该角色独立记忆（C4） |
| E4 | 不越级 | 专员会话不注入 `spawn_subagent`（两层组织结构不变）；跨域需求走 D2 转交卡（转对应专员 / 带上下文回主管会话，两出口） |
| E5 | 身份标识 | 会话头部角色头像+名称+「工具与数据仅限本角色」；输入框占位"和薪税专员说…"；侧栏「最近」该会话带角色小头像 |
| E6 | 归属 | 专员会话归全局「最近」+ 该角色工作台「相关对话」页签（B5）；**架构红利**：交互式会话中角色可直接问用户/走确认卡，补上子代理不能提问的缺口（税务 filing-precheck 曾被迫走 main-skill 模式的根因） |

### F. 迁移与善后

| # | 功能点 | 要点 |
|---|---|---|
| F1 | 删除花名册 | 移除 `/agents` 团队视图（`agent-card`/`attention-panel` 该页用途）与 `AgentDetailDrawer`（能力并入工作台）；总览「去处理」等深链改指会话或 `/agents/<roleId>` |
| F2 | 看板去处 | 跨角色「本月任务」看板（`TaskBoardView`）暂无家；到看板阶段再定（候选：总览页区块）。本次重构不处理，但别删数据链路 |
| F3 | 标签页适配 | application tabs（PR #57）的 agents 页签路由适配新结构 |

## 三·五、UI 要点（交互稿 v4 定案，拆 spec 时引用）

> 原则：全部走 `app/globals.css` token（双风格体系自动生效），遵循 `docs/ui-conventions.md`；本节只记录本次新增界面的**结构与状态决策**，不重复全局规范。角色颜色复用 `lib/domain/role-ui.ts` 的 `ROLE_UI` 既有映射。

**侧栏（A）**
- 角色子行：7px 状态点（在忙=`--primary` 呼吸动画 / 待拍板=`--tone-alarm` 实心 / 空闲=空心描边），与会话列表状态点同体系；行尾弱化状态短文案（"在忙"/"待拍板 2"），空闲不显示。
- 父项徽标：alarm 色胶囊计数，仅 >0 显示；收起态保留（唯一"有事"信号）。
- 展开/收起复用 `CollapsibleSectionMotion` + chevron 旋转；尊重 `useReducedMotion`。

**工作台（B）**
- 头部：角色头像（ROLE_UI 色底 + 单字）+ 名称/domain/状态短语；右侧「和它对话」（secondary）+「派任务」（primary，一屏一个主按钮）。
- 页签：下划线式（active = `--primary` 下边线 + 加粗），四页签顺序固定：工作 / 记忆 n / 相关对话 n / 概况。
- 任务行：状态胶囊（待拍板=alarm 淡底 / 进行中=primary 淡底 / 排队=muted / 已交付=ok 淡底）+ 标题（truncate）+ 时间 meta；选中行 = primary 描边。
- 右侧预览：复用 `ResizablePreviewPanel`，外观统一 `preview-card-frame`（勿给页面自带外框，见 agent-menu 记忆 C 节教训）。**明确：是 files/knowledge 同款的内嵌双栏预览面板（in-flow、可拖宽/放大/收起），不是浮窗/overlay**。四个默认值钉死：①进入工作台默认选中任务流水第一条（分组排序后即最高优先级项）并展开预览；②尺寸对齐 files 页：`usePreviewResize(460)` + 列表 `min-w-[420px]`；③收起后顶栏出现「展开预览」图标按钮（对齐现 /agents 页行为）；④选中任务同步 URL `?task=<dispatchId>`（总览「去处理」深链到具体待拍板任务、标签页恢复选中态都靠它）。
- 预览三态：**疑点卡** = 左 alarm 色条卡片（与总览 attention 同视觉语言），逐条"疑点 N · 对象"+ 说明，操作 = 「去处理」(primary) +「全部通过」(secondary)，卡下一行小字"拍板动作在对话里完成，这里只做入口与预览"；**进行中** = 步骤列表（完成 ✓ ok 色 / 当前 ● primary 呼吸）+「查看会话」；**已交付** = 文件卡（文件名头 + 表格片段预览，内嵌 `FilePreviewPage`）+「打开/下载」，疑点行黄色（warn 淡底）高亮。所有预览顶部"来源会话：<链接>"。

**记忆页签（C）**
- 顶部说明条（primary 淡底）："独立记忆 · 仅「XX」可见，不与其他角色共享"。
- 记忆条目：muted 底圆角卡，正文 + 小字来源（"来自 3/12 个税复核"），hover 出「删除」；底部一行小字说明自动沉淀机制。

**转交卡（D）**
- 对话流内卡片：左 warn 色条 + 标题"建议转交 · <角色>" + 一句话说明；主按钮「转给X处理」+ 次按钮（"不用了"或"回主管会话"）。转交成功 toast 说明去向（"任务进入其队列，结果回到原对话"）。

**专员会话（E）**
- 会话头部：角色头像 + "<角色名> · 专员会话" + chip「工具与数据仅限本角色」。
- 输入框占位："和薪税专员说…"。
- 侧栏「最近」条目：前置 15px 角色小头像区分专员会话。
- 工具调用行沿用现有"⚙ 摘要"样式。

**文案**：界面全部财务语言，禁止出现模型/token/置信度等 AI 术语；按钮动词开头（去处理 / 派任务 / 和它对话 / 转给税务专员）；参照 `docs/ui-conventions.md` 界面文案约定。

## 四、依赖与建议实施顺序

```
A（侧栏）──┐
           ├→ B1 骨架 → B2/B3（任务流水+预览）→ B6/B7
C（记忆）──┤                ↑
           ├→ E（专员会话，依赖 C4、E1 迁移）→ B5（相关对话，依赖 roleIds + E1）
D（转交）──┘（D3 排队态先行，D2 转交卡可与 E 并行）
F1 删花名册放最后（新工作台可用后再删旧页），F2 明确不做
```

粗略量级：A=轻；B1-B3=重（新页面+预览三态）；B4-B7=中；C=中（新存储+注入）；D=中（新状态+卡片）；E=中（迁移+装配+UI）；F=轻。

## 五、未决事项（实施前需拍板）

1. 「本月任务」看板最终归属（总览区块 vs 独立入口）——看板阶段再议。
2. 专员会话中产出的交付物是否落 dispatch 卡进任务流水（MVP 倾向不落：直聊是问答不是任务对象）。
3. ~~记忆沉淀的判定粒度~~ **已拍板（2026-07-17）**：严格粒度——仅记跨任务复用的口径（计算口径/名单例外/流程偏好），一次性拍板、数值结果、任务状态不记；判定由模型按工具描述执行，护栏 = 对话内轻提示可见 + 记忆页签可删（**非**事前确认卡）。同时拍板：整个记忆体系去确认卡改静默（含全局 remember_convention），对齐 Claude Code 自动记忆模式；update_company_profile 保留确认（事实数据非口径）。
4. 徽标与总览 attention 的同源刷新机制（轮询/事件）。当前徽标数据来自 nav-state 挂载时取一次 /api/agents，`agentPendingCount` = roster 中 blockedReason 非空的角色数（近似"待拍板专员数"，非事项级计数）。

---

## 六、实施交接（续接指南）

> 目标：另开 session 读本节即可上手。以下是已落地代码的地图、可复用的约定、不可省的纪律、每个待办刀的可执行方案、验证方法。

### 6.1 已完成刀的代码落点（当前仓库真实状态）

**新增文件**：
- `app/agents/[roleId]/page.tsx` —— 角色工作台主页（头部 + 四页签路由）。含 `ProfileTabView`（概况+启停开关 B6）、`ConversationsTabView`（相关对话 B5）、`MemoryTabView`（记忆 C）。默认页签 `work`。
- `app/agents/[roleId]/workspace-work-tab.tsx` —— 工作页签（B2/B3）。`WorkspaceWorkTab`（任务流水+`ResizablePreviewPanel`）、`TaskRow`、`TaskPreview`（三态）、`TipButton`（**图标+hover 提示的通用按钮，仅此文件内部，未导出**）。
- `app/api/agents/[roleId]/conversations/route.ts` —— B5 后端（GET）。
- `app/api/agents/[roleId]/memory/route.ts` —— C 后端（GET/POST/DELETE）。
- `lib/db/role-memory-store.ts` —— 角色记忆 CRUD + `getRoleMemoryForPrompt`。

**改动文件**：
- `app/shared/nav-state.tsx` —— 加 `agentsOpen`/`setAgentsOpen`、`agentRoster`/`agentPendingCount`/`fetchAgentRoster`（挂载取一次 /api/agents，`cache:"no-store"`）。
- `app/shared/app-nav.tsx` —— 「智能体」父项从 `<Link>` 改为展开/收起 `<button>`（`setAgentsOpen`）+ 待拍板徽标 + 角色子列表（`renderRoleRow`，状态点，直达 `/agents/<roleId>`）。用 `usePathname` 取 `currentRoleId` 高亮子项。
- `lib/db/sqlite.ts` —— 加 `listConversationsForRole(roleId, limit)`（B5）。
- `lib/db/migrations.ts` —— 加 **v18** 迁移建 `role_memory` 表 + `idx_role_memory_role`。
- `lib/agent/subagent-runner.ts` —— `buildSubagentSystemPrompt(role, memories=[])` 追加「你的记忆」段；派发处 try/catch 读 `getRoleMemoryForPrompt(task.roleId)` 注入。
- `tests/nav-v3.test.ts` —— C5a/C5b 契约随设计改（父项不再 href="/agents"，改 setAgentsOpen + 子项 /agents/<roleId>）。
- `tests/fixtures/golden-schema.json` —— 加 `role_memory` 表快照（最小追加，勿整体重序列化）。

**尚未动**：`app/agents/page.tsx`（旧花名册团队视图）、`app/agents/agent-card.tsx`、`agent-detail-drawer.tsx`、`attention-panel.tsx`、`task-board.tsx` 仍在——F1 最后删。旧 `/agents` 路由目前无侧栏入口（父项成开关后不再导航到它），但页面还在、可直接访问。

### 6.2 已建立的约定（复用，别重造）

- **角色色/名（client-safe）**：`lib/domain/role-ui.ts` 的 `ROLE_UI`（tone + iconName）、`ROLE_LABELS`。禁 import `lib/agent/*` 到 client。
- **状态点**：`fa-tone-dot`（+ `fa-dot-pulse` 呼吸）+ `style={{"--tone": ...}}`；空闲点用 `fa-tone-dot opacity-30` + `--tone-neutral`（**别用裸 `rounded-full`/`border`**）。徽标/头像圆形用 inline `style={{borderRadius:"50%"/"999px"}}`。
- **图标按钮 + hover 提示**：`workspace-work-tab.tsx` 的 `TipButton` 模式（`Tooltip`+`TooltipTrigger asChild`+ ghost icon `Button`）。用户明确要求：文字按钮尽量换 hugeicon + hover 文字。图标名从仓库已用的取（`ArrowRight01Icon`/`BubbleChatIcon`/`CheckmarkCircle02Icon`/`FileSearchIcon`/`PanelRight`/`ArrowExpand01/Shrink01`/`MessageAdd01Icon`/`Delete02Icon` 均已验证存在）。
- **预览面板**：`ResizablePreviewPanel` + `usePreviewResize(460)`，列表 `listMinWidthClass="min-w-[420px]"`，外观统一 `preview-card-frame`（勿自带外框）。
- **乐观态**：开关（B6）、删除（C）都用乐观本地态即时反映 + 失败回滚 toast（因 `/api/agents` GET 会被浏览器缓存，纯 refetch 不即时；跨组件刷新用 `fetchAgentRoster` 带 `no-store`）。
- **lint 硬规矩**（`tests/ui/suppress-lock.test.ts`，上限 **111**）：`no-restricted-syntax` 禁硬编码外观类（`rounded-*`/`shadow-*`/`border`）。**新交互元素别加 eslint-disable**，改用 `rounded-[var(--radius)]` / inline `borderRadius` / `fa-tone-dot` / `ring-*`（ring 不在禁列）/ `Surface`+`Input`+`Switch` 组件做到零新增抑制。

### 6.3 环境与纪律（不可省）

- **venv**：worktree 无 `workers/.venv`，已软链接主仓库 `→ /Users/gyro/codex/finance-agent-public/workers/.venv` 并加进 `.git/info/exclude`（本地忽略防提交，因带斜杠的 `.gitignore` 规则 `.venv/` 只匹配目录不匹配符号链接）。新 worktree 若缺 venv 照做。
- **迁移三查**：加迁移前查「本 worktree 链尾 / 主仓库链尾 / 各 worktree 链尾 / 共享 dev 库 PRAGMA user_version」取最高 +1。**当前最新 = v18**（下一个迁移 = v19，但须现查，别默认）。命令见 6.5。改 golden-schema **只追加**目标表条目（原文件列是紧凑单行，`JSON.stringify(,2)` 会 churn 全文）。
- **测试门禁**：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`（+ venv）。UI 改动用 typecheck + 相关契约测试（nav-v3/agents-space/agent-board）+ 浏览器走查；迁移改动必跑 `db-migration-discipline`。
- **真机验证**：dev server = `.claude/launch.json` 的 `next-dev`（端口 3000，`autoPort`）。新路由首次访问编译慢（曾见 5-12s，非死循环）。dev 库无派发数据时工作台/相关对话为空——用脚本经 store 真实写入函数种 dispatch/memory 验证，**用后删**（scratchpad 有过 seed/cleanup 脚本样例）。
- **高风险刀必派 reviewer**：迁移 / agent 运行时 / 金额 / 公共契约的 diff，完成后派 `reviewer`（全新上下文、只读）审一轮，ship / fix first（至多两轮）。**C 刀正因此抓到 BLOCKER（删除未按 role 隔离）**——写者自审照不到这类。
- **dev 库残留**：v18 的 `role_memory` 曾带 `updated_at`，后按简单原则删列；dev 库可能残留该列（无害漂移，测试用 fresh :memory: build 不受影响）。

### 6.4 待办刀方案

#### 刀 6 — C 自动沉淀（✅ 已 ship 2026-07-17）
- **实际方案（与原设想不同，经用户两轮拍板）**：不侵入 agent 循环、不走确认门切入点，而是**角色分区版 remember_convention**——新增 MCP 工具 `remember_role_convention(roleId, text, source)`（`lib/agent/mcp-tools/role-conventions.ts`），模型按工具描述侦测"用户确认/纠正了某专员职责域口径"时调用，**静默写入** `role_memory`（不弹确认卡），对话内轻提示 = 工具行摘要「记住口径「…」→ 薪税专员」+ 返回文案「已记住这条口径」。
- **连带拍板**：全局 `remember_convention` 一并去确认卡改静默（从 `ALWAYS_CONFIRM_TOOLS`/`CONFIRM_REQUIRED_TOOL_NAMES` 移除，回到 ALLOWED_TOOLS 自动放行）；安全模型从"事前确认"改为"可见+可删"（对齐 Claude Code 自动记忆）。`update_company_profile` 保留确认卡。
- **判定粒度（严格版）**：仅跨任务复用口径；一次性拍板/数值结果/任务状态不记；全局偏好走 remember_convention、专员域口径走 remember_role_convention（分流写进两工具描述 + SYSTEM_PROMPT.md）。
- **护栏**：未知 roleId 拒写；同角色同内容去重（主对话看不到既有角色记忆，防跨会话重复沉淀）；工作台记忆页签可单条删除（刀5 已 ship）。
- **验证**：`tests/role-conventions.test.ts`（RC-1..6：落库/隔离/拒写/去重/成员契约/摘要渲染）+ `confirm-gate-fix`/`agent-confirm-flow` 契约更新，全套件绿。注入链路复用 `getRoleMemoryForPrompt`（刀5 已验证）。

#### 刀 7 — E 专员会话（"和它对话"）（✅ 已 ship 2026-07-17）
- **迁移 v19**：`chat_conversations.role_id TEXT`（NULL=主管会话）；带 sqlite_master 表存在性守卫（policy-rules 测试构造的局部库没有该表）。golden-schema 追加 cid 8。
- **角色穿线**：客户端 `role` 参数（`/chat/new?role=` → ChatPage `initialRole` → 首条消息请求体）只在**创建会话**时生效并经 `validRoleId` 校验（未知/未启用/停用角色回落主管+告警）；此后每回合 `sessionStage` 从 DB 行读 `roleId`（服务端权威，防客户端伪造扩权）→ `routerStage` 跳过路由器 → `runClaudeAgent(roleId)`。
- **运行时装配（claude-adapter 按 specialistRole 分支）**：系统提示 = `buildSpecialistChatSystemPrompt`（**新建的交互式 A 段**——子代理 A 段的"不能提问"纪律对直聊是错的，财务纪律段抽成共享常量防漂移）+ rolePrompt B 段 + 角色记忆 + 输出目录；`allowedTools = resolveRoleAllowedTools`（免确认名单收窄）；`skills = role.skills`；不注入主管的全局记忆/画像/反馈段（C1 隔离）。
- **工具边界两层**：新增 `resolveRoleScopeTools`（域全集，**不**与 ALLOWED_TOOLS 取交集）+ `createRoleScopeHook`——域外 MCP 工具（含 spawn_subagent、他角色工具）在确认门**之前** deny 并给转交引导文案；**域内高风险工具（如薪税的算薪）穿过 role-scope 落到确认门弹卡**——这正是"角色可走确认卡"的架构红利，一刀切拦掉就把红利砍了。
- **归属与标识**：`listConversationsForRole` 改 LEFT JOIN 并集（dispatch 会话 ∪ `c.role_id=?` 直聊，`isDirect` 标记）；会话头部 = 角色头像 +「角色名 · 专员会话」+ chip「工具与数据仅限本角色」；输入框占位「和薪税专员说…」；侧栏「最近」条目 15px 角色小头像（`ConversationSummary.roleId`）。
- **验证**：`tests/specialist-session.test.ts`（SS-1..6：scope/hook 边界/确认门/提示词/落库归属/源码契约）；真机：工作台「和它对话」→ 专员会话头部标识 + 占位 ✓，服务端日志 `router skipped (specialist session)` ✓，侧栏「最近」角色小头像 ✓，相关对话页签「专员会话」标注 ✓（dev 环境 API key 无效，真实 LLM 回合待用户真机）。
- **reviewer 结论 SHIP**（独立审过越权面/SQL/迁移/回归面）；两条 MEDIUM 已修：/chat/new 客户端也校验 `available`（防 UI 宣称边界与服务端回落不一致）、ALWAYS_CONFIRM 确认文案按工具名显式分发（新增成员落通用兜底不误用画像文案）。已知取舍：已存在的专员会话在角色被停用后仍可继续对话（停用只拦新建与派发）。~~专员会话暂不给记忆沉淀工具~~ **已补（2026-07-18）**：role-scope hook 放行 remember_role_convention 并锁定 `input.roleId === 会话角色`（防越权写他角记忆），专员系统提示带沉淀指引（roleId 固定本角色）。

#### 刀 8 — D 越权转交排队（✅ 已 ship 2026-07-18）
- **D1 边界数据化**：`RoleDefinition.boundaries: Array<{cannot; transferTo}>`（六角色各填真实边界，transferTo 均有效 roleId，测试守）；概况页签「职责边界与转交」段展示 ✗ 列表+转交对象；专员/子代理系统提示注入边界，指引调 propose_transfer 不硬拒。
- **D2 转交卡**：新工具 `propose_transfer`（`lib/agent/mcp-tools/propose-transfer.ts`，safe/静默/只发提议不执行；校验目标 available+未停用，**fail-closed**；工具端生成 proposalId UUID 进结构化返回，供卡片 localStorage 已处理态稳定去重）。渲染 = `app/components/transfer-proposal-card.tsx`（warn 色条 +「转给X处理/不用了」，注册进 tool-cards `KIND_CARD_REGISTRY`）。POST `/api/agents/transfer` 落 queued dispatch。主管会话（ALLOWED_TOOLS）+ 专员会话（role-scope 放行）可用；**子代理 `createSubagentBoundaryHook` 显式 deny**（无前端渲染上下文）。
- **D3 排队态**：迁移 v20 `subagent_dispatches.instructions TEXT`（三查后取号，sqlite_master 守卫，golden cid 18 追加）；`dispatch-store` 加 `enqueueTransferDispatch`/`startQueuedDispatch`(CAS queued→running)/`removeQueuedDispatch`。工作台 `TASK_GROUPS` 加 queued，顺序 **pending→running→queued→failed→done**（疑点永在前）；预览「现在开始」(POST `/api/agents/dispatches/[id]/start`，fire-and-forget 跑 runSubagent) /「移除」(DELETE，仅 queued 行)。**B1 修复**：`SubagentTask.existingDispatchId` 复用 start 端点已 CAS 的行，跳过 runSubagent 内 recordDispatchStart，杜绝台账双行。
- **D4 结果回流**：转交任务完成/失败均 `insertChatMessage(originConversationId, "assistant", "【转交任务完成/失败】<角色>·<label>\n"+结果)`，经 updated_at 浮回「最近」，不静默丢。
- **审查与验证**：reviewer 独立审出 1 BLOCKER（B1 双行）+1 HIGH（分组序）+3 MEDIUM（fail-open/子代理 deny/键碰撞）全部已修；真机验证排队组渲染+移除端到端（DB 行确删）；端点边界齐全（404 gone/409 非 queued）。
- **已知取舍**：start 端点 fire-and-forget 依赖桌面常驻进程（serverless 需队列 worker，已注释）；`/api/agents/transfer` 的 originConversationId 未做会话归属校验（本地单机端点，已注释）。

#### 刀 9 — F1 删花名册 + F3 标签适配（最后）
- 删 `app/agents/page.tsx` 团队视图 + `agent-card`/`agent-detail-drawer`/`attention-panel`（能力已并入工作台）。
- 总览页「去处理」等指向 `/agents`（团队视图）的深链改指会话或 `/agents/<roleId>`。
- `agents-space.test.ts` 有对 `app/agents/page.tsx` 的源码契约（T4）+ `team-panel.tsx「查看全部→」链接 /agents`（T5）——删页时**同步改这些契约**。
- application tabs（PR #57）的 agents 页签路由适配新结构（`app/shared/nav-state.tsx` 的 `PAGE_ROUTE_META` 已含 `/agents` 前缀，`/agents/<roleId>` 会归到「智能体」页签，标题暂为通用「智能体」——可选优化为角色名）。
- **F2 明确不做**：跨角色「本月任务」看板（`TaskBoardView`）暂无家，别删数据链路，看板阶段再定归属。

### 6.5 验证命令速查

```bash
# 类型
npm run typecheck
# 全套件（需 venv + mock 环境）
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# 单个契约测试
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/<name>.test.ts
# lint 棘轮（新增抑制会红，上限 111）
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/ui/suppress-lock.test.ts
# 迁移三查（本/主仓/各 worktree 链尾 + 库实际版本，取最高 +1）
grep -oE "version: [0-9]+" lib/db/migrations.ts | tail -1
grep -oE "version: [0-9]+" /Users/gyro/codex/finance-agent-public/lib/db/migrations.ts | tail -1
for f in /Users/gyro/codex/finance-agent-public/.claude/worktrees/*/lib/db/migrations.ts; do grep -oE "version: [0-9]+" "$f" | tail -1; done
# 库实际 user_version：tsx 脚本 getDb().prepare("PRAGMA user_version").get()
```
