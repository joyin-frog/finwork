# Audit — 抽共享预览壳 ResizablePreviewPanel

> 对应 spec：`docs/spec/spec-resizable-preview-panel.md`（v1.1 已批准）
> 说明：implementer 完成主体实现后在 typecheck 阶段 stream 卡死；主循环（orchestrator）接手完成 **真机逐页验证**、修一处真机发现的回归（1 行）、并补写本 audit。代码判定交全新上下文 reviewer。

## Files changed

| 文件 | 动作 |
|---|---|
| `app/shared/use-preview-resize.ts` | 抽出并 export 纯函数 `clampPreviewWidth({startW,deltaX,containerW,listMinW,handleW})`；onMove 改调它（handleW 从外层参数显式传入，未写死）。hook 公有返回值不变。 |
| `app/shared/resizable-preview-panel.tsx` | 新增。表现型壳：容器(ref=mainRef)+左列(maximized→hidden，listMinWidthClass 默认 min-w-[280px])+分隔条(cursor-col-resize，!collapsed&&preview 时渲染)+右面板(preview-card-frame，`style={{width:previewW}}`)。不 import 任何内容组件。 |
| `app/files/page.tsx` | 用 `<ResizablePreviewPanel>` 替换手写装配；预览内容整块进 preview 插槽。 |
| `app/knowledge/page.tsx` | 同上；三路预览内容（MetadataPanel/命中导航 FilePreviewPage/搜索高亮）在页内组合后整块进 preview 插槽，本地状态不动。 |
| `app/agents/page.tsx` | 用壳包左列(list)+抽屉内容(preview)，传 `listMinWidthClass="min-w-[420px]"`。 |
| `app/agents/agent-detail-drawer.tsx` | 删内部分隔条；去掉 `previewW/dragging/onBeginResize` props，退回纯内容组件（保留 maximized/onMaximize/onClose）。 |
| `tests/resizable-preview-panel.test.ts` | 新增。clampPreviewWidth 7 分支纯函数单测 + 壳/三处采纳源码契约。接入 all.test.ts。 |
| `tests/all.test.ts` | 接入 `resizablePreviewPanelTestPromise`。 |

## §1 成功标准逐条核对

- **A 纯函数 clampPreviewWidth**：✅ 抽出 + export，onMove 调用；单测 A1–A7 全绿（变窄/变宽/下限200/上限=containerW-handleW-listMinW/listMinW过大回落/deltaX=0/handleW 传参）。
- **B 壳**：✅ 源码契约 B1–B5 绿（含 cursor-col-resize/maximized/mainRef、不 import 内容组件、支持 listMinWidthClass）。
- **C 三处采纳**：✅ 源码契约 C1–C4 绿（files/knowledge/agents-page 采纳壳，agent-detail-drawer 已删分隔条及相关 props）。
- **C 逐页真机回归**（硬门槛）：
  - `/agents`：卡片渲染正常；点卡开抽屉（preview 插槽）→ 抽屉内容（最近任务/数据权限/会做的活）齐；分隔条拖拽实测改变宽度（mousedown→move→up 生效）；⤢ 放大 → 左列 hidden + 右面板填满容器（`fillsContainer:true`，frame≈container-handleW）；× 关闭正常。截图留证（含放大态填满全宽）。
  - `/knowledge`：列表 min-w-[280px]；点文档 → 预览框渲染（FilePreviewPage「打开方式/正在加载文件内容」），分隔条在位，width=280px。
  - `/files`：list 插槽（topbar+chips）渲染正常；本机 DB 0 文件，未触发文件预览内容（预览内容渲染在 knowledge 已验证同源 FilePreviewPage）。
  - 三页 **console 零 error**。
- **D 不回归**：✅ 全套 11 suites 绿；typecheck 干净。

## 真机发现并修复的回归（1 处）

**放大态不填满** — 壳初版写 `style={maximized ? undefined : {width: previewW}}`，放大时丢掉宽度；而 `.preview-card-frame`/`.is-maximized` 在 globals.css **无任何 CSS 规则**（grep 证实），且壳未给 `flex-1` → 放大态右面板塌到内容宽、右侧留白。

- **根因**：原 files/knowledge 是 `style={{width: previewW}}` **无条件**应用（`maximize()` 已把 previewW 设为 `containerW - handleW` 以填满）；原 agent 抽屉走的是 `flex-1`。壳错误地取了「抽屉的 style 条件」却没带「抽屉的 flex-1」，两套填满机制都没落地。
- **修复**：壳改为 `style={{ width: previewW }}` 无条件应用（对齐原 files/knowledge，`git show HEAD:app/files/page.tsx:652` 佐证）。所有消费者共用同一 hook，`maximize()` 统一把 previewW 设为填满值。
- **复验**：`/agents` 放大 `fillsContainer:true`；测试 + typecheck 仍绿。

## 实施审查裁决处理（fix first 第 1 轮 → 用户反馈再校正）

reviewer 判 **fix first**：壳无条件套 `preview-card-frame`（`app/styles/preview.css:442`：margin 4px+圆角 12px+边框+阴影，浮起卡片），而**改造前**的 `AgentDetailDrawer` 是贴边平板 `bg-card border-l border-border`——reviewer 以"等价重构逐像素不变"为由要求恢复贴边。当时据此加了 `previewFrameClassName` prop 让 agents 退回贴边。

**但用户随后明确反馈**：智能体预览应与对话/知识库**外观一致**（浮起卡片），这正是 B 阶段"复刻预览页样式"的原意——旧的贴边平板不是想要的目标态。故**撤销该 prop**：壳右面板统一写死 `preview-card-frame`，三处消费者共用同一外框；`agent-detail-drawer.tsx` 不自带任何外框（`bg-card`/`border-l` 由壳提供，抽屉内部只留内容）。

**真机复验计算样式**（objective）：三处预览框现**完全一致** —— `margin:4px / border-radius:12px / box-shadow:有 / preview-card-frame`（`/agents` 与 `/knowledge` 实测同款）。全套 11 suites 绿；typecheck 干净。回归守卫 B6/C5 改为"壳统一 preview-card-frame + 抽屉不自带外框"（守一致性，而非守贴边）。

## chat 是否纳入

**未纳入**，列为 follow-up。理由：`chat-preview-sidebar.tsx` 是 props 驱动（27 行），但其 resize/hook 归属在 chat 页父级，所有权模型与另三处不同（spec §5 判据）；本期优先稳妥迁三处，不为套壳改 chat 数据流。

## 观感一致自查 / 遗留

- files/knowledge：装配等价搬迁，`style={{width}}` 无条件应用、`preview-card-frame` 保留，与原一致；观感无差异（真机计算样式已核）。
- agents 抽屉：按用户反馈统一为浮起卡片 `preview-card-frame`（与 files/knowledge/对话一致），真机计算样式三处同款已核。这是相对改造前的**有意观感变更**（旧贴边平板 → 统一卡片），非等价回归——目标就是一致。分隔条 hover 色也随之统一为 `primary/30`。
- 放大填满机制已统一到 `width: previewW`；`flex-1` 分支不再使用。
- 遗留 follow-up：chat 迁移；`.preview-card-frame`/`.is-maximized` 为无规则空 class（历史遗留，本期未清理，避免扩大 diff）。
