# Spec:资料区(全部文件 ↔ 知识库)对齐 + 卡片操作重排 + 预览修复

## 背景
用户要两页**「无限接近相同」(设计 + 功能)**,唯一区别 = 知识库能被检索、全部文件不能。真数据测出预览/卡片问题 + 卡片操作重排(用户已选「混合:常用图标 + ⋮」)。

## 现状(已查证)
- **预览两个标题**:`app/files/page.tsx`(~500-511)在 `FilePreviewPage` 外**又包了一层 header**(显示 `{selected.name}` + 加入知识库按钮),和 `FilePreviewPage` 自带标题(`preview-head-title`,`file-preview-page.tsx:331`)重复。**知识库页直接渲 `FilePreviewPage`、无外层 header**(`knowledge/page.tsx:609`)= 一个标题。→ files 要对齐知识库。
- **预览宽度**:两页 `beginResize` 把 `previewW` clamp 到固定 `[200,1200]`、**不按容器宽**→ 拖太宽时 list(min 280)+ previewW 超出容器,父级 `overflow-hidden` 裁掉预览右侧(`打开方式` 按钮)。
- **卡片不一致**:`FileCard`(files:可点=预览、hover 一排图标)vs `DocCard`(`knowledge/doc-card.tsx`:不可点、有「查看/对话」文字按钮 + 归档/删除)。

## 设计

### A. 预览修复(`file-preview-page.tsx` + 两页)
1. **去重标题**:删掉 `app/files/page.tsx` 预览面板外层 header(~500-511),直接渲 `FilePreviewPage`(对齐知识库)。原「加入知识库」按钮移进卡片 ⋮ 菜单(见 B)。
2. **宽度修复**:`previewW` 上限改为按容器宽 clamp(`mainRef.current.clientWidth - 列表最小宽(~300) - 手柄`),预览面板永不超出容器、`打开方式`/`打开文件` 按钮始终可见。**files + knowledge 两页都改**(建议抽 `app/shared/use-preview-resize.ts` 共享 hook,一次修两页)。
3. 防御:`preview-head-title` 加 `flex-1 min-w-0 truncate`,标题长也不挤掉按钮。

### B. 统一卡片(用户选的「混合」布局)
**抽共享组件 `app/shared/resource-card.tsx`**——归一化 props(图标 / 名称 / meta 节点 / 主操作[] / 菜单操作[] / onClick / selected),两页各自把数据(`UnifiedFileEntry` / `DocRow`)映射进去,**保证设计 + 交互一致**。卡片规格:
- **点卡片 = 预览**(两页;知识库**去掉「查看」按钮**)。
- **hover 露 2 个常用图标**(卡片底部):`对话` + `下载`。
- **右上角 `⋮` 下拉菜单**(复用 `components/ui/dropdown-menu`)放其余操作:
  - 全部文件:加入知识库(仅 upload/generated)、在系统中显示、保留/取消保留、删除。
  - 知识库:在系统中显示、归档/恢复(检索相关)、删除。**知识库无「加入知识库」**(已在库)。
- **唯一差异**:知识库 meta 显示检索信息(检索 N 次/未被检索/长期未使用/已归档);全部文件 meta 显示保留书签。
- **`对话`**:知识库 = 现有 `onAddToChat`;全部文件 = 跳转来源对话(`/chat/recent?id=conversationId`,upload/generated 有);图标/语义一致。
- **`下载`**:两页都加(知识库原来没有)——经 Tauri 保存对话框另存(红线 7,不外发);全部文件复用现有 export,知识库新增等价 export(走 `storage_path` 绝对路径)。

### C. 两页对齐 + 自查
顶栏 / 搜索 / 分类 chips / 卡片网格(已 auto-fill)/ 预览面板 / 空 + 加载态——两页结构/样式对齐到「无限接近相同」。**自查其它不一致**(间距/标题/hover/颜色/交互)一并抹平,报告里列出发现并修的差异点。

## 红线 / 约束
- 下载/导出仅存本机、不外发(红线 7);删除过确认 + 落审计(红线 5/8,沿用现有)。
- 沿用 Folio token;不改底层存储/检索逻辑;知识库归档/检索语义不变。
- 聚焦 `app/files/page.tsx`、`app/knowledge/page.tsx`、`app/knowledge/doc-card.tsx`、`app/shared/file-preview-page.tsx`、新增 `app/shared/resource-card.tsx`(+ 可选 resize hook);下载若需后端只动对应 route。别动别的页面。

## 验收(AC)
- **AC1** 预览区只有**一个**标题(files 去外层 header,对齐知识库)。
- **AC2** 预览拖到最宽也不超出容器、`打开方式`/`打开文件` 按钮始终可见不被裁(两页)。
- **AC3** 卡片:点卡片=预览(两页);知识库无「查看」;hover 露 `对话`+`下载`;右上角 `⋮` 菜单放其余操作。
- **AC4** 全部文件卡片有「对话」(跳转来源对话);知识库卡片有「下载」。
- **AC5** 两页**设计 + 交互无限接近相同**,唯一差异是检索相关。报告列出抹平的差异点。
- **AC6** 回归:预览/搜索/筛选/在系统显示/导出/下载/删除/保留/加入知识库/归档/对话 全可用;`npm run typecheck`/`npm test`(`# fail` 0,pptx/secret-store 既有告警忽略)/`npm run lint`(0 error)全绿。

## 测试
- 主要 UI——靠 typecheck + 既有测试不破(unified-file-library / files-promote / knowledge-ui 等)。下载若有后端逻辑,补/改对应测试(隔离 DB)。
- 视觉验证由我在集成后做(用户真机有真数据);**别在 e2e mock 里 seed DB 截图**(那套跨进程喂不进、不可靠,见项目 memory)。

## 文件
- 新:`app/shared/resource-card.tsx`(+ 可选 `app/shared/use-preview-resize.ts`)
- 改:`app/files/page.tsx`、`app/knowledge/page.tsx`、`app/knowledge/doc-card.tsx`、`app/shared/file-preview-page.tsx`

## 不做
- 改底层存储/检索/Excel 编辑/Windows 存储;改预览的具体渲染(Excel/pdf/图片)逻辑。
