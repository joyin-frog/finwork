# 智能体 IA · UI 抛光 Spec

> 版本 v1.0 / 2026-07-17
> 状态：已批准（用户确认 5 点后实施）
> 依赖：`docs/spec/design-agents-ia.md`（刀 9 F3 标签适配 + 工作台抛光）
> 分支 / worktree：`claude/session-1-d34af2` / `confident-williamson-02801b`
> 架构事实：应用标签走 `nav-state.pageTabFromRoute` + `app-shell.RouteTabSync`；预览壳是 `ResizablePreviewPanel`（知识库/文件页把 header 放进 `list` 槽，预览与标题同顶）；角色文案来自 `ROLE_REGISTRY` + `skillLabel`。

## 0. 评估结论（用户 5 点 → 判定）

| # | 用户反馈 | 判定 | 根因（一句话） |
|---|---|---|---|
| 1 | 标签栏应展示具体智能体名，而非统一「智能体」 | **成立 · 本期修** | `pageTabFromRoute` 把所有 `/agents/*` 压成 `page:agents` / title「智能体」（正是设计刀 F3） |
| 2 | 工作/记忆/…页签样式不像技能页，底下多一条横线 | **成立 · 本期修** | `.app-page-header::after` 已有分割线，页签行又加了 `border-b border-border` → 双线 |
| 3 | 预览应像知识库一样在最外层，现在在标题下面 | **成立 · 本期修** | 知识库把 header 放进 `ResizablePreviewPanel` 的 `list`；工作台把 header/tabs 放在 Panel **外**，预览只能挤在标题下方 |
| 3b | 概况「数据权限 / 会做的活」中英混杂，英文要有中文名 | **成立 · 本期修** | `dataScope` 原样透传 registry（含 `fact_invoices` 等）；技能名虽走 `skillLabel`，通用技能 `xlsx`/`pdf` 等仍可能落英文 id |
| 4 | 侧栏已有状态圆点，不要再跟「在忙/待拍板」文字 | **成立 · 本期修** | `app-nav.renderRoleRow` 圆点 + `tag` 文字双重表达；工作台 header 的 pill 保留（有底色胶囊，不是侧栏圆点） |
| 5 | 标题旁 domain 副标题多余（如「经营分析师 · 管理会计」） | **成立 · 本期修** | header 渲染 `role.domain`；删展示即可，registry 字段可留作内部归类 |

## 1. 目标与非目标

**目标**：把角色工作台的应用标签、页内 tabs、预览壳、概况文案、侧栏状态表达对齐既有产品模式（对话标签 / 技能页 / 知识库预览），消除冗余文案。

**非目标（本期不做）**：
- F1 删除旧 `/agents` 花名册页、cockpit「查看看板」改链（另刀）
- 记忆自动沉淀 / 专员直聊 / 越权转交（设计刀 6–8）
- 改动知识库/文件页既有预览对齐算式（只让智能体对齐它们，不反向改它们）
- 重构 `ROLE_REGISTRY.dataScope` 机器 token 语义（只加展示映射层）

## 2. 成功标准

- [ ] **应用标签**：打开 `/agents/analyst` 与 `/agents/bookkeeper` 各产生独立标签；标题分别为「经营分析师」「记账专员」（或 roster 中文名）；切换角色不覆盖另一角色标签。验证：真机点两个角色 + 截图标签栏。
- [ ] **页内 tabs**：工作/记忆/相关对话/概况 选中态仍为下划线；页签行与 header 之间**只有一条**分割线（无双线）。验证：截图对比技能页。
- [ ] **预览壳**：工作页签有选中任务且预览展开时，预览卡顶边与页面顶对齐（与知识库一致：标题栏只跨列表列，不横压预览）。验证：截图并排对照知识库。
- [ ] **概况文案**：数据权限 pill 全部中文可读（无裸 `fact_*` / 英文 token）；会做的活 pill 全部中文（含 xlsx/pdf/docx/pptx 等通用技能）。验证：打开概况页签截图。
- [ ] **侧栏**：角色行仅圆点表达在忙/待拍板，行尾无「在忙」「待拍板」文字；圆点保留 `title`/`aria-label`。验证：截图侧栏展开态。
- [ ] **工作台标题**：header 不再显示 `role.domain`。验证：截图 header。
- [ ] 相关单测绿：`tests/nav-v3.test.ts`（若断言触及标签文案则同步）；必要时补 `pageTabFromRoute` 角色路径断言。

## 3. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/shared/nav-state.tsx` | 修改 | 放宽 `PageTab.key`；`pageTabFromRoute` / `appTabKeyFromRoute` 对 `/agents/<roleId>` 产出 `page:agents:<roleId>`；title 可先用 ROLE_LABELS 兜底 |
| `app/shared/app-shell.tsx` | 修改 | `RouteTabSync`：有 roster 时用角色中文名覆盖 title |
| `lib/domain/role-ui.ts` | 修改 | 已有 `ROLE_LABELS`；新增 `dataScopeLabel`（或同文件映射表） |
| `lib/agent/tools/renderers.ts` 或 `lib/domain/role-ui.ts` | 修改 | 补齐通用技能中文名（xlsx/pdf/docx/pptx 等），保证 `skillLabel` 不落裸英文 |
| `app/api/agents/route.ts` | 修改 | roster `dataScope` 经 `dataScopeLabel` 后再下发 |
| `app/agents/[roleId]/page.tsx` | 修改 | 去 domain；tabs 去容器 `border-b`；预览壳重构（header+tabs 进 list 槽） |
| `app/agents/[roleId]/workspace-work-tab.tsx` | 修改 | 配合把 `ResizablePreviewPanel` 上提到 page，或接收 chrome 插槽；保留任务态逻辑 |
| `app/shared/app-nav.tsx` | 修改 | `renderRoleRow` 去掉 tag 文字，圆点加 a11y |
| `tests/nav-v3.test.ts` | 修改 | 同步标签 / 侧栏契约断言 |
| `docs/spec/design-agents-ia.md` | 修改 | 刀 9 F3 标为进行中/本 spec 覆盖 |

## 4. 实施步骤

### 4.1 应用标签（F3）

1. 将 `PageTab.key` 类型从 `` `page:${PageKind}` `` 放宽为 `string`（或联合 `` `page:${PageKind}` \| `page:agents:${string}` ``）。
2. `pageTabFromRoute(pathname, search)`：若匹配 `/agents/:roleId`（roleId 非空且不是纯 `/agents`），返回：
   - `key: \`page:agents:${roleId}\``
   - `pageKind: "agents"`
   - `title: ROLE_LABELS[roleId] ?? roleId`（client-safe）
   - `href: pathname + search`
3. 纯 `/agents`（旧花名册，若仍可进）保持 `page:agents` /「智能体」。
4. `RouteTabSync`：若 key 以 `page:agents:` 开头，用 `agentRoster.find` 的 `name` 覆盖 title（roster 未就绪时保留 ROLE_LABELS）。
5. 复制对话标签模式：不同 key → `openPage` 追加而非覆盖。

### 4.2 页内 tabs 去双线

1. `page.tsx` 页签容器：删 `border-b border-border`，保留按钮 `border-b-2 -mb-px` 选中下划线。
2. 参考：`app/skills/skills-manager.tsx` 筛选行无额外 `border-b`。

### 4.3 预览壳对齐知识库

1. 目标 DOM（与 `app/knowledge/page.tsx` 同构）：

```
ResizablePreviewPanel
  list = <>
    <header className="app-page-header">…角色名 + 派任务…</header>
    <tabs>工作/记忆/…</tabs>
    {tab==="work" ? 任务流水 : 其他页签内容}
  </>
  preview = tab==="work" && selected ? <TaskPreview/> : null
```

2. 推荐重构：`page.tsx` 持有 `ResizablePreviewPanel` + tab 状态；`WorkspaceWorkTab` 改为导出「列表体 + 预览体」或接收 `chrome` 不再自建 Panel。非工作页签时 `collapsed=true`（或 preview=null），list 仍含 header+tabs，视觉上全宽。
3. 不要改 `preview.css` 知识库对齐算式；智能体 TaskPreview 已有自有预览头即可。

### 4.4 概况中文映射

1. 在 `lib/domain/role-ui.ts`（client-safe）增加 `DATA_SCOPE_LABELS` + `dataScopeLabel(raw)`：
   - 覆盖 registry 中出现的 token：`documents`、`fact_invoices`、`fact_payroll`、`fact_metrics`、`fact_obligations`、`company_profile` 等；
   - 带括注的长串（如 `fact_payroll（全产品唯一…）`）整串映射为短中文，如「工资明细（本角色独有）」；
   - 未命中时：若已是中文则原样，否则降级可读文案而非裸英文 id。
2. `route.ts`：`dataScope: role.dataScope.map(dataScopeLabel)`（若 label 函数只在 client，则把映射表放到双方都能 import 的 `lib/domain`）。
3. 通用技能：确保 `skillLabel("xlsx")` 等 →「表格 / PDF / Word / 演示文稿」类中文（查现有 `SKILL_LABELS`，缺则补）。

### 4.5 侧栏去状态文字

1. 删除 `tag` 渲染；圆点 `title`/`aria-label` 设为「在忙」或「待拍板」。
2. **不动**工作台 header 的「进行中 / 待拍板」pill。

### 4.6 去掉 domain 副标题

1. 删除 header 中 `{role.domain}` 那一 span。
2. 概况「职责」继续用 `charter`，不展示 domain。

## 5. 测试与验证

```bash
cd /Users/gyro/codex/finance-agent-public/.claude/worktrees/confident-williamson-02801b
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx --test tests/nav-v3.test.ts
# 若有 pageTab 单测文件一并跑；tsc：
npx tsc -p tsconfig.typecheck.json --noEmit
```

**截图验收（必须，UI 项）**——开发服务起来后对下列状态截图，贴进 `docs/spec/audit-agents-ia-ui-polish.md`：

1. 标签栏：两个角色标签并存，标题为角色名
2. 工作台页签区：单分割线 + 下划线选中
3. 工作页签 + 预览展开：预览顶对齐（对照知识库一张）
4. 概况：数据权限 / 会做的活 全中文
5. 侧栏：圆点无文字；header 无 domain

## 6. 风险与开放问题

- `PageTab.key` 放宽后，依赖 `` key === `page:agents` `` 的代码需 grep 确认（关闭标签、图标映射按 `pageKind` 仍安全）。
- 预览上提可能影响 `WorkspaceWorkTab` 的 `usePreviewResize` 默认展开逻辑——验收时确认切到记忆页再回工作页，预览态合理。
- roster 异步：标签 title 可能先 ROLE_LABELS 后换成 roster.name（通常一致）；不一致时以 roster 为准。
