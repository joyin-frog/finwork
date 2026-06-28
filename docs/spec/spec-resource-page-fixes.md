# Spec:资料页修复(双侧栏/重命名/可拖动/对齐知识库布局)+ 加入知识库桥

## 背景与根因(已分析)
- `app/shared/app-shell.tsx`(被 root `app/layout.tsx` 包住所有页)**统一渲染侧栏 `<AppNav active={...}>`**。知识库页 `app/knowledge/page.tsx` **不自渲 AppNav**(`return <div className="flex flex-col h-full overflow-hidden">`,靠 AppShell)——这是正确范式。
- **P1 双侧栏**:`app/files/page.tsx` **自己又渲了 `<AppNav active="files" />`(line 217)** 叠在 AppShell 之上 → 两个侧栏;且 AppShell 的 active 派生(line 92-102)**没处理 `/files`**(落到默认 `cockpit`),导致两侧栏高亮还不一致。
- **P2**:合并入口想叫「**文件库**」(不是「资料」),图标用知识库原来的 `LibraryIcon`。
- **P3 不能拖动**:知识库页 list/preview 间有自定义可拖动分隔条(`beginResize`/`dragging`/`w-1 cursor-col-resize`,`app/knowledge/page.tsx:249/595`),文件库页没有。
- **P4 布局不一致**:文件库搜索/筛选在**顶栏**;知识库搜索/分类在**主内容区列表列内**。要对齐知识库。
- 还有原定的「**加入知识库**」桥未做(把上传/生成文件提升为可检索知识)。

## 拆分:两个 subagent 并行,文件不重叠

### Subagent A — 导航/外壳(只动 app-shell.tsx + app-nav.tsx)
1. **app-shell.tsx**:`active` 类型加 `"files"`;派生加 `else if (pathname.startsWith("/files")) active = "files";`(放在 `/knowledge` 分支旁)。这样 AppShell 的 AppNav 在 `/files` 与 `/knowledge` 都能正确高亮合并入口。
2. **app-nav.tsx**(P2):合并入口 `<span>` 文案「资料」→「文件库」;图标 `FolderLibraryIcon` → `LibraryIcon`(确保 import 有 `LibraryIcon`、去掉不再用的图标 import 避免 lint);高亮条件保持 `active === "files" || active === "knowledge"`。
- **不要碰 `app/files/page.tsx`。**

### Subagent B — 文件库页重构 + 加入知识库(只动 app/files/page.tsx + app/api/files-library/route.ts + 新测试)
1. **P1 去双侧栏**:删掉本页自己的 `<AppNav active="files" />` + 外层 `flex h-screen` 包壳;**改成镜像知识库页**:`return <div className="flex flex-col h-full overflow-hidden">`(AppShell 已提供侧栏)。
2. **P4 对齐知识库布局**(参考 `app/knowledge/page.tsx` 的 return 结构):
   - 顶栏 `<header className="… h-11 border-b …">`:`DragHandle` + `SidebarToggle` + `<ResourceTabs active="files" />` +(`ml-auto`)右侧操作(如"打开文件")。**搜索框从顶栏移走。**
   - 主内容区 `<div className="flex flex-1 overflow-hidden">`:左 = 列表列(`flex flex-col flex-1 min-w-[280px]`,内含 **搜索框 + 筛选 chips[全部/上传/生成/知识库/已保留] + 排序** 头,再下面是文件列表),中 = **可拖动分隔条**,右 = `<FilePreviewPage>` 预览。
3. **P3 可拖动**:复用知识库页的 `beginResize`/`dragging` 自定义拖动模式(同款 `w-1 shrink-0 cursor-col-resize` 手柄 + 鼠标拖动改预览列宽),保持和知识库一致;别引第三方。
4. **加入知识库桥**:
   - `app/api/files-library/route.ts` POST 加 action `promote`:入参文件 id(及其 storagePath/name/mime/size,或后端按 id 反查)→ 解析**绝对路径** → 调 `ingestDocument({ filePath, title, fileName, mimeType, sizeBytes })`(`lib/knowledge/pipeline.ts`)→ 落审计(`insertAuditLog`,红线 8);**已是知识(kind=知识)的不提供该操作**;重复(相同 `content_hash`)优雅提示不重复入库(看 ingestDocument 是否已按 hash 去重,没有则在此判)。
   - 列表行/预览区加「**加入知识库**」按钮:**仅对 上传/生成 文件**显示;点击调上面 action,成功后刷新列表/提示。
5. **保持**:既有 `listAllFiles`/筛选/预览/reveal/export/删除/保留 功能不变,只改布局 + 加桥。

## 红线/约束
- 只读浏览;promote 是写 → 落审计(红线 8);全本地不外发(红线 7)。
- 沿用 Folio `--*` token + **镜像知识库页风格**,别引入新设计语言/冷灰。
- 最小改动:A 不碰 files 页;B 不碰 app-shell/app-nav。

## 验收(AC)
- **A-AC1** `/files` 与 `/knowledge` 都只有**一个**侧栏(AppShell 的);合并入口标签「文件库」、图标=知识库原图标、在两页都正确高亮。
- **B-AC1**(P1)`/files` 不再自渲 AppNav,无双侧栏。
- **B-AC2**(P4)`/files` 布局镜像知识库:搜索 + 筛选 chips 在主内容区列表列内,顶栏只剩 tab + 窗口控件 + 操作。
- **B-AC3**(P3)list/preview 之间可左右拖动调宽,手感/手柄与知识库一致。
- **B-AC4**(桥)上传/生成文件有「加入知识库」按钮,点击成功 promote(知识库随后出现该文档);已是知识的不显示;重复优雅处理;落审计。
- **B-AC5** 回归:筛选/预览/reveal/export/删除/保留 不变;knowledge 页不受影响。
- 各自 `npm run typecheck` / `npm test` / `npm run lint` 全绿(末尾 pptx/secret-store 既有告警忽略,`# fail` 0)。

## 测试
- A:UI 无强单测,靠 typecheck + 既有 knowledge-ui/design-compliance 不破(集成时我会截图核)。
- B:`tests/files-promote.test.ts`(隔离 DB):promote 一个上传/生成文件 → `knowledge_documents` 出现该文档;重复 `content_hash` 不重复入库/优雅;非法/已是知识的 id 报错;落审计。wire 进 `tests/all.test.ts`。布局/拖动靠 typecheck +(集成时)截图核。

## 文件
- A:`app/shared/app-shell.tsx`、`app/shared/app-nav.tsx`
- B:`app/files/page.tsx`、`app/api/files-library/route.ts`、`tests/files-promote.test.ts`

## 不做
- 改 AppShell 其它逻辑、改知识库页、Excel 编辑、Windows 存储。
