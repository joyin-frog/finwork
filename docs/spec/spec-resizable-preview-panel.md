# 抽共享预览壳 ResizablePreviewPanel（TDD）Spec

> 版本 v1.1 / 2026-07-05
> 状态：~~草案~~ → **已批准**（plan review 修改后批准，P1/P2/P3 + 三条建议已并入）→ 已实施
> 依赖：B 团队看板（`agent-detail-drawer.tsx` 已用 `usePreviewResize`，是第 4 个消费者，触发本次抽取）。
> 落地分支：当前 `claude/suspicious-solomon-ba059a`（含 B）。
> 架构事实（写给全新上下文实现者）：
> - **已共享**：`app/shared/use-preview-resize.ts`（hook：`collapsed/previewW/dragging/maximized/mainRef/beginResize/toggle/open/resetWidth/maximize`）；`app/shared/file-preview-page.tsx`（`FilePreviewPage` 内容渲染器，自带缩放/翻页/打开方式头部）。
> - **重复的是"装配层"**：`app/knowledge/page.tsx`、`app/files/page.tsx`、`app/agents/agent-detail-drawer.tsx` 各自手写同一套布局——`<div flex flex-1 overflow-hidden ref={mainRef}>` 容器 + 左列 `flex-1 min-w-[…] overflow-hidden`（`maximized && "hidden"`）+ 拖拽分隔条（`w-1 cursor-col-resize onMouseDown={beginResize}`）+ 右面板（`maximized ? flex-1 : style={{width: previewW}}`）。
> - **clamp 数学在 hook 里内联**（`use-preview-resize.ts` 的 onMove）：`raw = startW - deltaX; max = Math.max(200, containerW - handleW - listMinW); previewW = Math.max(200, Math.min(max, raw))`。
> - **chat 不一样**：`app/chat/chat-preview-sidebar.tsx` 是 props 驱动（`collapsed/width/isMaximized` 由 chat 页父级传入 + `FilePreviewPage docked`），hook 归父级持有——结构与另三处不同（见非目标/风险）。
> - 测试栈：`npm test` = `node --import tsx tests/all.test.ts`（聚合、无 jsdom/DOM 栈、含 AC6.2 typecheck 门禁）。纯函数测试仿 `tests/ask-user-multi.test.ts`；源码契约仿 `tests/tool-call-step-ui.test.ts`。

## 0. 目标与非目标

**目标**：把重复的"可拖宽/可放大预览面板**外层装配**"抽成一个**表现型组件 `<ResizablePreviewPanel>`**（内容用插槽 `list` + `preview`，不揉内容），并把 clamp 宽度数学抽成**纯函数 `clampPreviewWidth`**（真正可 TDD）。让 knowledge / files / 智能体抽屉复用同一个壳；消除各页手写装配的漂移。**基于 TDD**：先写测试（clamp 纯函数 + 壳/采纳的源码契约），红了再抽到绿。

**收益的诚实边界（评审 P1/P2 校正）**：本次抽的是**外层四层 DOM 装配 + clamp 数学**这两块真重复，收益是「一处壳 + 一个可测函数 + 消除漂移 + 未来新预览面直接复用」，**不是各页内容的大幅缩行**。具体：files 收益最大（外层全删）；knowledge 只删外层约 15 行（150 行三路内容原样进插槽）；智能体抽屉本就半组件化，收益是把分隔条收归壳、结构对齐另两处。别把本次当成"大幅简化 knowledge/抽屉"。

**非目标（本期不做，已知并接受）**：
- ❌ **改任何预览的行为/外观**：files/knowledge/智能体抽屉预览的观感与交互必须**逐像素/逐行为不变**——这是纯重构，不是重设计。
- ❌ **把不同内容揉成一个大组件**：`FilePreviewPage`（文件内容）、知识列表、智能体抽屉内容各自照旧，只塞进壳的插槽。壳只管"容器 + 分隔条 + 放大/宽度"。
- ❌ **重写 `usePreviewResize` 的公有 API**：只把内联 clamp 数学抽成纯函数供 hook 调用 + 单测；hook 返回值不变（各页照旧解构）。
- ❌ **chat 迁移可选、且不阻塞**：`chat-preview-sidebar` 结构不同（props 驱动、hook 在 chat 页父级、docked 模式）。**优先迁 knowledge/files/智能体抽屉三处**；chat 若能低风险纳入则纳入，否则本期不动、列为 follow-up（不为迁 chat 牺牲三处的稳妥）。
- ❌ 引入 jsdom / 新依赖 / 改 `FilePreviewPage`。

## 1. 成功标准

**A. 纯函数 `clampPreviewWidth`（真 TDD，可单测）**
- [ ] 从 `use-preview-resize.ts` 抽出 `clampPreviewWidth({ startW, deltaX, containerW, listMinW, handleW })`：`raw = startW - deltaX`；`max = Math.max(200, containerW - handleW - listMinW)`；返回 `Math.max(200, Math.min(max, raw))`。hook 的 onMove 改为调它（行为不变）。**注意（评审建议 2）**：`handleW` 是 `usePreviewResize(listMinW, handleW=4)` 的外层参数，onMove 闭包里调 `clampPreviewWidth` 时须把这个外层 `handleW` 显式传进去，别在函数内写死 4。
- [ ] **先写单测**（红→绿）：向右拖变窄、向左拖变宽；下限 200；上限 = `containerW - handleW - listMinW`；`listMinW` 大到 max<200 时回落 200；deltaX=0 返回 startW（钳制内）。

**B. 组件 `<ResizablePreviewPanel>`（源码契约 + 目视）**
- [ ] 新组件 `app/shared/resizable-preview-panel.tsx`，props：`{ mainRef, previewW, maximized, collapsed, dragging, onBeginResize, listMinWidthClass?, list: ReactNode, preview: ReactNode }`（或直接收 `usePreviewResize` 返回对象 + list/preview）。渲染既有装配：容器(ref=mainRef) + 左列(`maximized && hidden`) + 分隔条(`cursor-col-resize onMouseDown`) + 右面板(`maximized ? flex-1 : width:previewW`)。`collapsed || !preview` 时不渲染右面板与分隔条。
  - **`listMinWidthClass`（评审 P3）**：左列最小宽 class，各页不同——默认 `"min-w-[280px]"`（files/knowledge）；**agents 页须传 `"min-w-[420px]"`**。是 Tailwind class 字符串，作用于左列 div。别写死。
- [ ] 壳是**纯表现型**：不持有 selection/open 逻辑（那仍归各页），不 import 任何具体内容组件（不 import FilePreviewPage/知识/智能体）。验证：源码契约——壳不 import 具体内容组件、含 mainRef/cursor-col-resize/maximized 装配。

**C. 三处采纳（源码契约 + 逐页真机回归）**
- [ ] `app/files/page.tsx`、`app/knowledge/page.tsx` 改用 `<ResizablePreviewPanel>`，删掉各自手写的容器/分隔条/宽度装配；knowledge 的三路预览内容整块进 `preview` 插槽（不进壳）。各页仍 `usePreviewResize()` 持有状态 + 传给壳。
- [ ] `agents/page.tsx` 用壳包住「左列（list）+ 抽屉内容（preview）」，传 `listMinWidthClass="min-w-[420px]"`；`agent-detail-drawer.tsx` 删掉内部分隔条、去掉 `dragging/onBeginResize` props，保留为纯内容组件。
- [ ] 验证：源码契约——四文件（files/knowledge/agents-page/agent-detail-drawer 按角色）import 并用 `ResizablePreviewPanel`，且**除壳文件外**不再各自写 `cursor-col-resize` 分隔条。
- [ ] **逐页真机回归**：files/knowledge 打开一个文件预览能拖宽、放大、还原；智能体抽屉点卡打开能拖宽、放大。观感与迁移前一致。

**D. 不回归**：全套测试绿；typecheck 干净；四处（含 chat 若纳入）预览行为不变。chat 若本期不迁，明确记录为 follow-up。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/shared/use-preview-resize.ts` | 修改 | 抽出并 export `clampPreviewWidth` 纯函数；onMove 改调它（行为不变）。 |
| `app/shared/resizable-preview-panel.tsx` | 新增 | 表现型壳组件（容器+分隔条+放大/宽度，list/preview 插槽）。 |
| `app/files/page.tsx` | 修改 | 用 `<ResizablePreviewPanel>` 替换手写装配（**收益最大**：外层装配全删，内容原样进 preview 插槽）。 |
| `app/knowledge/page.tsx` | 修改 | 用壳替换**外层装配约 15 行**（容器+左列+分隔条+右框架）。**注意（评审 P1）**：右侧内容是三路分支（`MetadataPanel` / 带命中导航的 `FilePreviewPage` / 搜索高亮 `<pre>`，共约 150 行，依赖 knowledge 本地状态 `metaPanelDoc/previewMode/hitLines/hitIndex/linemap/preview` 等）——这 150 行**原封不动在 knowledge 页内组合好后整块传入 `preview` prop**，不进壳。knowledge 页删除行数≈15，不是 100+。 |
| `app/agents/agent-detail-drawer.tsx` + `agents/page.tsx` | 修改 | **路径已定（评审 P2）**：在 `agents/page.tsx` 用 `<ResizablePreviewPanel>` 包住「左列 JSX（list 插槽）+ 抽屉内容（preview 插槽）」；从 `AgentDetailDrawer` **删掉其内部分隔条**（约 8 行，`w-1 cursor-col-resize onMouseDown`）——分隔条改由壳统一渲染。`AgentDetailDrawer` 保留为纯内容组件，props 去掉 `dragging/onBeginResize`（分隔条不再归它），保留 `maximized/onMaximize/onClose`（内容头部仍用）。`agents/page.tsx` 传 `listMinWidthClass="min-w-[420px]"`。 |
| `app/chat/chat-preview-sidebar.tsx` / chat 页 | **可选** | 仅当低风险时纳入；否则不动，follow-up 记录。 |
| `tests/resizable-preview-panel.test.ts` | 新增 | ①`clampPreviewWidth` 纯函数单测（先写、先红）；②源码契约（壳装配 + 壳不 import 内容组件 + 三处采纳）。接入 `tests/all.test.ts`。 |
| `tests/all.test.ts` | 修改 | 接入 `resizablePreviewPanelTestPromise`。 |

## 3. 实施步骤（TDD 顺序）

1. **先写测试（红）**：`tests/resizable-preview-panel.test.ts` —— `clampPreviewWidth` 各分支断言（此时函数还没抽，红）；源码契约断言壳存在 + 三处采纳（红）。接入 all.test.ts。
2. **抽 `clampPreviewWidth`**（绿①）：从 `use-preview-resize.ts` onMove 抽纯函数 + export，onMove 调它。跑纯函数测试转绿。
3. **建壳 `resizable-preview-panel.tsx`**：把 files 页现有装配（`ref={mainRef}` 容器 + 左列 hidden + 分隔条 + 宽度面板）搬进壳，list/preview 插槽化。参照 `app/files/page.tsx:470-` 的既有结构（它最完整）。
4. **迁三处**（逐个替换、每迁一处**立刻真机看该页预览不变**：拖宽/放大/还原）：
   - **files**（最简、最完整）→ 直接套壳，删外层装配。
   - **knowledge** → 套壳删外层约 15 行；三路预览内容（MetadataPanel/命中导航 FilePreviewPage/搜索高亮）整块进 `preview` 插槽，`preview` 值为 knowledge 页内组合好的 JSX，本地状态不动。
   - **智能体抽屉** → 在 `agents/page.tsx` 用壳包左列(list)+抽屉内容(preview)，传 `listMinWidthClass="min-w-[420px]"`；从 `agent-detail-drawer.tsx` 删内部分隔条、去 `dragging/onBeginResize` props。
5. **chat 评估**：看 chat 页装配能否低风险塞进壳（注意 docked/props 驱动差异）；能则迁 + 真机验对话内预览；不能则不动，在 audit 记 follow-up。
6. 源码契约测试转绿；全套 + typecheck 绿。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/resizable-preview-panel.test.ts
npm run typecheck
```
- 新测试（`tests/resizable-preview-panel.test.ts`，接入 all.test.ts）：
  1. **纯函数**（真 TDD）：`clampPreviewWidth` —— 变窄/变宽/下限200/上限=containerW-handleW-listMinW/listMinW 过大回落/deltaX=0。
  2. **源码契约**：壳文件含 `cursor-col-resize`+`maximized`+`mainRef` 装配、**不 import** `file-preview-page`/知识/智能体内容组件；`files/page.tsx`、`knowledge/page.tsx`、`agent-detail-drawer.tsx` 均 import 并用 `ResizablePreviewPanel`，且不再各自出现手写 `cursor-col-resize` 分隔条。**注意（评审建议 1）**：「不再手写 `cursor-col-resize`」的 grep 断言只针对三处采纳文件，**必须排除壳文件 `resizable-preview-panel.tsx` 自身**（分隔条现在归壳，壳里当然含该 class，否则永远误报）。分隔条从 `agent-detail-drawer.tsx` 内也一并移除（评审 P2）。
- **真机逐页回归（硬门槛，重构必验）**：`/files`、`/knowledge` 各开一个文件预览 → 拖宽 / 放大(⤢) / 还原 均正常、观感不变；`/agents` 点卡开抽屉 → 拖宽/放大正常。截图留证；跑不动 audit 标"待人工目视"。
- 回归：先跑基线全绿再动，每迁一处跑一次，零回归。

## 5. 风险与开放问题

- **跨 3-4 个工作面的重构，回归是主要风险**：files/knowledge/chat 都是现有可用功能，装配搬错会让预览拖不动/错位/放大异常。**逐页迁 + 逐页真机验**，不要一次性全改完才验。
- **壳的 props 契约要覆盖各页差异**：两个不同的量别混淆——(1) `usePreviewResize(listMinW)` 的 clamp 下限（files 460 / knowledge 360 / 智能体 460）由各页调 hook 决定，壳不碰；(2) 左列 CSS `min-w` class（files/knowledge `min-w-[280px]`、agents `min-w-[420px]`，评审 P3 实测三者有别）→ 走壳的 `listMinWidthClass` prop，默认 `"min-w-[280px]"`，agents 传 `"min-w-[420px]"`。壳里别写死任何一个。
- **chat 的结构性差异 + 纳入判据（评审建议 3）**：`chat-preview-sidebar.tsx` 本身仅约 27 行、纯 props 驱动（不持 hook），迁移代价低；真正的阻力是**它的分隔条/resize 归属在 chat 页父级**（实施第 5 步须先定位 chat 页里持有 `beginResize`/宽度的父组件文件，确认那处的外层装配能否无副作用套壳）。**低风险判据**：chat 父级的外层装配与 files 同构（容器+左列+分隔条+宽度面板）、且套壳后 docked 模式观感不变 → 纳入；若父级所有权模型（谁持 hook、docked 特判）导致要改 chat 数据流 → 不纳入，列 follow-up。别为套壳硬改 chat 的所有权模型。
- **纯 TDD 的边界**：DOM 拖拽/放大行为无 jsdom 测不了 → 真 TDD 只覆盖 `clampPreviewWidth`；壳与采纳用源码契约 + 真机目视兜底。别假装能 DOM 级 TDD。
- **不改行为红线**：本期是等价重构；任何"顺手改预览外观/交互"的冲动都回到非目标。检验：迁移前后每页预览截图应无差异。

---

## 附录：audit（`docs/spec/audit-resizable-preview-panel.md`）
Files changed（对照 §2）→ §1 逐条核对（clamp 单测/壳契约/三处采纳/逐页真机）→ 测试/typecheck 输出 → chat 是否纳入的结论 → 迁移前后观感一致自查 → 偏离/遗留/风险。
