# 智能体 IA · UI 抛光 — 实施审计

> 对应 spec：`docs/spec/spec-agents-ia-ui-polish.md`（v1.0）
> 分支 / worktree：`claude/session-1-d34af2` / `confident-williamson-02801b`

## Files changed

- `lib/domain/role-ui.ts` — 新增 `DATA_SCOPE_BASE_LABELS` / `DATA_SCOPE_FULL_LABELS` / `dataScopeLabel()`（数据权限 token → 中文展示映射，client-safe）。
- `lib/agent/tools/renderers.ts` — `SKILL_LABELS` 补 `"receivables-ledger": "往来台账"`（往来专员技能此前缺映射，会落裸英文 id）。
- `app/api/agents/route.ts` — import `dataScopeLabel`；roster 的 `dataScope` 经 `role.dataScope.map(dataScopeLabel)` 后再下发。
- `app/shared/nav-state.tsx` — `PageTab.key` 放宽为 `` `page:${PageKind}` | `page:agents:${string}` ``；`pageTabFromRoute` 对 `/agents/<roleId>` 产出独立 `page:agents:<roleId>` 标签（title 用 `ROLE_LABELS[roleId] ?? roleId` 兜底），裸 `/agents`（旧花名册）保持原 `page:agents`/「智能体」不变。
- `app/shared/app-shell.tsx` — `RouteTabSync`：命中角色标签时，若 `agentRoster` 已取到该角色，用其权威中文名覆盖 `pageTab.title`（未到位时保留 `pageTabFromRoute` 的 ROLE_LABELS 兜底）。
- `app/shared/app-nav.tsx` — `renderRoleRow`：删除跟随状态圆点的「在忙/待拍板」文字 `<span>`；圆点（含空闲态弱化点）补 `title` + `aria-label` + `role="status"` 承载可读状态。
- `app/agents/[roleId]/page.tsx` — 头部删除 `role.domain` 展示 span；页签容器删除 `border-b border-border`（避免与 `.app-page-header::after` 双线）；整页重构为持有唯一 `usePreviewResize(460)` + `ResizablePreviewPanel`，header + 页签进 `list` 槽（与 `app/knowledge/page.tsx` 同构），`preview` 槽仅在 `tab==="work"` 时接 `useWorkspaceWorkTab` 的预览内容。
- `app/agents/[roleId]/workspace-work-tab.tsx` — 导出从 `WorkspaceWorkTab`（组件，自持 `ResizablePreviewPanel`）改为 `useWorkspaceWorkTab(roleId, resize)`（hook，返回 `{ list, preview }`），不再自建 Panel；`resize` 由 page.tsx 传入（仅消费 `collapsed`/`maximized`/`open`/`toggle`/`maximize`，宽度与拖拽仍由 page.tsx 持有的 `usePreviewResize` 管）；`fetchDispatches` 补 `roleId` 为空时的早退（page.tsx 在角色详情加载完成前传空串占位，避免打无效请求）。
- `tests/nav-v3.test.ts` — 新增两个契约块：① F3（`pageTabFromRoute`/`appTabsReducer` 对 `/agents/<roleId>` 的独立标签行为，含未知 roleId 降级、裸 `/agents` 不受影响、两角色标签并存不互相覆盖）；② 侧栏圆点 a11y（`renderRoleRow` 不再渲染跟随文字 tag，圆点带 `title`/`aria-label`）。

## 逐项对照 spec 成功标准

| # | 成功标准 | 实现 | 状态 |
|---|---|---|---|
| 1 | 应用标签：`/agents/analyst`、`/agents/bookkeeper` 各开独立标签，标题为角色中文名，互不覆盖 | `nav-state.pageTabFromRoute` 按 roleId 产出 `page:agents:<roleId>`；`app-shell.RouteTabSync` 用 roster 名覆盖；`appTabsReducer` 天然按 key 去重/并存（无需改 reducer） | 完成（单测覆盖，见下方测试结果） |
| 2 | 页内 tabs：选中态下划线不变，页签行与 header 间只一条分割线 | 删除页签容器 `border-b border-border`，只留 header 的 `::after` 分割线 | 完成（视觉核验受限，见「开放风险」） |
| 3 | 预览壳：工作页签选中任务且预览展开时，预览顶边与页面顶对齐 | page.tsx 唯一持有 `ResizablePreviewPanel`，header+tabs 进 `list` 槽，preview 槃与 list 槽同级、无更高层遮挡 | 完成（结构已对齐知识库；视觉核验受限，见「开放风险」） |
| 4 | 概况文案：数据权限 / 会做的活全中文，无裸 `fact_*`/英文 token | `dataScopeLabel` 覆盖 registry 现有全部 dataScope token（含所有带括注长串）；`SKILL_LABELS` 补齐 `receivables-ledger`，其余技能（xlsx/pdf/docx/pptx 等）已有映射 | 完成（逐条核对见下） |
| 5 | 侧栏：角色行仅圆点表达状态，无「在忙/待拍板」文字；圆点保留 title/aria-label | `renderRoleRow` 删 tag span，圆点补 a11y 属性 | 完成 |
| 6 | 工作台标题：header 不再显示 `role.domain` | 删除对应 span；`RoleDetail.domain` 类型字段保留但不再展示（registry 字段仍留作内部归类，API 仍下发，非本刀范围） | 完成 |
| 7 | 相关单测绿 | `tests/nav-v3.test.ts` 补充 F3 + 侧栏 a11y 契约并全部通过 | 完成 |

### 数据权限 token 逐条核对（ROLE_REGISTRY.dataScope，6 个角色全量）

| 原始 token | `dataScopeLabel()` 输出 |
|---|---|
| `documents` | 文档资料 |
| `fact_invoices` | 发票流水 |
| `金蝶科目表` | 金蝶科目表（已是中文，原样） |
| `报销制度文件` | 报销制度文件（原样） |
| `fact_payroll（全产品唯一有工资明细权限的角色）` | 工资明细（本角色独有） |
| `税率配置` | 税率配置（原样） |
| `fact_invoices（读）` | 发票流水（只读） |
| `company_profile（读）` | 企业档案（只读） |
| `薪资状态汇总（非明细）` | 薪资状态汇总（非明细）（原样） |
| `知识库政策文件` | 知识库政策文件（原样） |
| `银行流水文件（用户上传）` | 银行流水文件（用户上传）（原样） |
| `documents 合同收付义务（读）` | 合同收付义务（只读） |
| `fact_obligations（读，kind=receive）` | 收付义务（应收，只读） |
| `fact_invoices（sales，direction=out）` | 销项发票流水 |
| `fact_metrics（只读）` | 经营指标（只读） |
| `用户上传的报表/费用/工资汇总文件` | 用户上传的报表/费用/工资汇总文件（原样） |

全部 16 个 distinct token 均命中中文映射或已是中文，无裸英文 id 残留。

### 技能 token 逐条核对（ROLE_REGISTRY.skills 全量）

`reimbursement-check`/`kingdee-draft`/`contract-extract`/`payroll-calc`/`tax-incentive`/`rnd-deduction-check`/`business-analysis`/`finance-analysis`/`xlsx`/`pdf`/`docx`/`pptx` 此前已在 `SKILL_LABELS` 中；本次新增 `receivables-ledger`→「往来台账」（此前缺失，会落裸英文 id）。全量技能 id 现已无遗漏。

## 与计划的偏差

- spec §3 Files touched 未列出 `lib/agent/tools/renderers.ts` 的具体改动内容，实际只加了一行 `receivables-ledger` 映射（文件本身在计划的候选列表 `lib/agent/tools/renderers.ts 或 lib/domain/role-ui.ts` 中已预留，未越界）。
- `docs/spec/design-agents-ia.md` 的刀 9 F3 状态标注在我开始实施前已是「🟨 F3+工作台抛光见 spec-agents-ia-ui-polish.md；F1 仍待办」（`git diff` 显示这一改动先于本次会话存在，非本次改动引入），本次未再改动该文件——符合计划要求，未越界补充。
- `useWorkspaceWorkTab` 相比原计划描述的「WorkspaceWorkTab 改为导出列表体+预览体或接收 chrome」，选择了 hook（而非组件）导出形式：因为原组件内部同时持有 `usePreviewResize`（含 `mainRef`/`beginResize`/`previewW`/`resetWidth`，这些必须被提升到 page.tsx 唯一持有，否则无法在非 work 页签也共用同一个 `ResizablePreviewPanel`），拆成 hook 后只需把 `collapsed`/`maximized`/`open`/`toggle`/`maximize` 这几个字段传入，语义比继续叫「组件」更贴切。此改动的直接收益：切到记忆/相关对话/概况页签再切回工作页签时，任务列表/选中态/预览展开态不再因组件卸载而丢失（原实现是条件渲染 `{tab === "work" ? <WorkspaceWorkTab/> : ...}`，切走即卸载）——直接化解了 spec §6 风险项「预览上提可能影响 usePreviewResize 默认展开逻辑」。

## 测试结果

```
$ FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx --test tests/nav-v3.test.ts
nav-v3: JOY-10 + C5–C7 checks passed ✓
✔ tests/nav-v3.test.ts (175ms)
ℹ tests 1 / pass 1 / fail 0

$ npx tsc -p tsconfig.typecheck.json --noEmit
（无输出，0 错误）
```

补充跑了受影响面相邻的现有测试（未改动内容，仅验证无回归）：

```
$ FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx --test \
  tests/agent-board.test.ts tests/role-registry.test.ts \
  tests/agents-space.test.ts tests/team-panel.test.ts
四个文件全部通过（pass 4 / fail 0）
```

```
$ FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx --test \
  tests/shortcuts-wiring.test.ts tests/chat-float.test.ts tests/chat-features.test.ts
三个文件全部通过（pass 3 / fail 0）
```

ESLint（仅本次改动文件）：0 error，9 warning，且全部为改动行之外的既有告警（`app-nav.tsx` 里 pre-existing 的 `no-restricted-syntax` 外观类提示 + 未使用的 eslint-disable，均不在本次编辑的 `renderRoleRow` 代码块内；`tests/nav-v3.test.ts` 的 ignore-pattern 提示是测试目录的通用规则，非本次引入）。

## 开放风险

- **截图验收（主循环已补，2026-07-17）**：截图存于 `docs/spec/screenshots-agents-ia-ui-polish/`：
  1. `agents-ia-01-analyst-work.png` — header 仅「经营分析师」、无 domain；页签下划线；侧栏角色仅圆点无「在忙」文字
  2. `agents-ia-02-two-role-tabs.png` — 标签栏并存「记账专员」「经营分析师」
  3. `agents-ia-03-profile-zh.png` — 概况数据权限 / 会做的活为中文（后续将 docx/pptx 标签从「Word/PPT 处理」改为「文稿处理 / 演示文稿」）
- **预览顶对齐**：本机当前无该角色本月任务，无法截「选中任务 + 预览展开」态；代码结构已与知识库同构（header+tabs 进 `list` 槽）。有任务数据后需再截一张确认。
- `useWorkspaceWorkTab` 现在无条件调用（不再随 tab 切换挂载/卸载），`fetchDispatches` 在 `roleId` 为空时提前返回；切走 work 页签不再丢状态——建议真机再点一次「切记忆再回工作」确认预览态。
