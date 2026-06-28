# 知识库独立页面 Spec

**版本**: v1.0
**日期**: 2026-06-07
**作者**: 架构设计
**状态**: 待执行

---

## 0. 动机与目标

### 0.1 现状问题

当前知识库管理藏在「设置 → 知识库」Tab 内( `/config?tab=knowledge` )。三个独立 section card(上传/文档列表/搜索预览)堆叠在 264px 侧栏 + 右侧内容区的浮窗里。问题:

- **不可发现**:设置是低频功能,知识库是高频(上传→检索→验证→聊天引用),路径层级太深
- **无预览联动**:当前"搜索预览"只显示文字片段,没有右侧文件全文预览;上传文档后想看内容要回到聊天页点附件
- **与聊天割裂**:用户在聊天里问报销,想查一下已上传的政策原文——必须切到一个深藏在设置里的 tab,找到文档,然后回聊天,路径太绕
- **无空间感**:上传和搜索和文件列表堆在同一个窄 panel 里,没有"知识库是一个空间"的感觉

### 0.2 目标

1. 知识库从设置中独立出来,成为侧边栏一级入口(位于「设置」上方)
2. 独立页面采用**双栏布局**(左侧文件浏览 + 右侧可调宽度全文预览)
3. 右侧预览复用聊天里已有的 `FilePreviewPage` 组件(同一组件,相同交互)
4. 左侧设计成"知识库工作台":搜索 + 上传(拖拽) + 分类筛选 + 文档列表(可单击预览)
5. 全量支持明暗主题(项目 `data-theme` 体系)
6. API 路由和文件服务路径从 config 中抽出,成为独立端点

---

## 1. 布局与交互设计

### 1.1 页面整体结构

```
┌─ app-shell ──────────────────────────────────────────────────────────┐
│ ┌─ app-nav ─┐ ┌─ codex-content (知识库页) ─────────────────────────┐ │
│ │           │ │ ┌─ codex-topbar ──────────────────────────────────┐ │ │
│ │  新对话   │ │ │  <h1>知识库</h1>      [布局切换] [关闭/返回]    │ │ │
│ │  驾驶舱   │ │ └────────────────────────────────────────────────┘ │ │
│ │           │ │ ┌─ codex-main (flex row, CSS var --sidebar-w) ────┐ │ │
│ │  对话     │ │ │ ┌─ knowledge-browser (左, flex=1 或固定宽) ──┐ │ │ │
│ │  知识库 ◄ │ │ │ │ [搜索栏]                                   │ │ │ │
│ │  设置     │ │ │ │ [上传区域(可折叠)]                         │ │ │ │
│ │           │ │ │ │ [分类筛选 chips]                           │ │ │ │
│ │           │ │ │ │ [文档列表(可滚动)]                         │ │ │ │
│ │           │ │ │ │   ├─ 📄 报销管理制度    expense_policy     │ │ │ │
│ │           │ │ │ │   ├─ 📊 差旅标准2026    expense_policy     │ │ │ │
│ │           │ │ │ │   └─ ...                                   │ │ │ │
│ │           │ │ │ └────────────────────────────────────────────┘ │ │ │
│ │           │ │ │ <divider draggable>                            │ │ │
│ │           │ │ │ ┌─ knowledge-preview (右, var(--sidebar-w)) ──┐ │ │ │
│ │           │ │ │ │ <FilePreviewPage selection={...} />          │ │ │ │
│ │           │ │ │ │   (与聊天右侧栏完全相同)                     │ │ │ │
│ │           │ │ │ └─────────────────────────────────────────────┘ │ │ │
│ │           │ │ └─────────────────────────────────────────────────┘ │ │
│ │           │ └────────────────────────────────────────────────────┘ │
└─────────────┴────────────────────────────────────────────────────────┘
```

### 1.2 左侧浏览器(knowledge-browser)结构

#### 1.2.1 搜索栏(固定顶部)

```
┌──────────────────────────────────────────┐
│ 🔍 搜索文档标题、内容…    [语义检索▾]  │
└──────────────────────────────────────────┘
```

- 默认**本地过滤**:在已加载的文档列表里按 `title + file_name` 模糊匹配
- 点击「语义检索」或输入后按 Enter:调用 `/api/knowledge/search` 做 embedding 检索,结果以"搜索命中"模式展示(显示相似度分 + 所属文档)
- 搜索输入框右侧有清除按钮(×),清除后恢复完整文档列表
- 搜索结果展示为特殊列表项:显示 chunk 内容片段 + score + 点击跳转到所属文档的预览

#### 1.2.2 上传区域(可折叠)

**默认展开(有文档时折叠):**

```
┌──────────────────────────────────────────┐
│       📤 拖拽文件到此处上传              │
│       支持 .txt .md .docx .xlsx          │
│       .csv .pdf .png .jpg .webp          │
│                                          │
│         [选择文件]  分类: [自动▾]       │
└──────────────────────────────────────────┘
```

- 拖拽高亮(已有 `.knowledge-drop-zone.over` 样式,复用)
- 点击「选择文件」→ 文件选择器(`accept` 涵盖所有支持格式)
- 分类下拉:`自动检测 / 报销制度 / 合同 / 财务规范 / 税务 / 通用`
- 选择文件后自动显示文件名 + 检测到的分类;底部出现「上传并索引」按钮 + 进度条
- 上传完成后文件出现在列表顶部,高亮 2 秒,然后恢复正常;dropzone 折叠(有文档时)
- **无文档时的 empty state**:dropzone 始终展开 + 居中引导文字"上传第一份文档开始构建知识库"

#### 1.2.3 分类筛选 Chips

```
[全部 12] [报销制度 3] [合同 2] [财务规范 4] [税务 1] [通用 2]
```

- 水平滚动的 chip 列表(overflow-x: auto)
- 每个 chip = 分类名 + 文档数
- 激活态用 `--accent` 背景 + 白色文字
- 非激活态用 `--surface` / outline 样式
- 点击 chip → `setFilterCategory(cat)` → 过滤文档列表 + 更新上传区默认分类

#### 1.2.4 文档列表(可滚动)

```
┌──────────────────────────────────────────┐
│ ○ 报销管理制度                          │
│   报销制度 · 12 个分块 · 48 KB          │
│   3 天前                          [🗑]  │
├──────────────────────────────────────────┤
│ ● 差旅标准2026                          │  ← 选中状态(preview 正在显示)
│   报销制度 · 8 个分块 · 32 KB           │
│   1 周前                          [🗑]  │
├──────────────────────────────────────────┤
│ ○ Q1财务报告                            │
│   财务规范 · 15 个分块 · 120 KB         │
│   2 周前                          [🗑]  │
└──────────────────────────────────────────┘
```

单行三项信息:
- **行 1**:文档标题(粗体) + 删除按钮(悬停显示,hover 时右侧出现垃圾桶图标)
- **行 2**:分类名(小号 muted) · N 个分块 · 格式化文件大小
- **行 3**:相对时间(如"3 天前"、"1 周前")

交互:
- **单击行** → 选中该文档,右侧预览加载文件内容
- **选中文档**左侧有 accent 色左边框 + 浅 accent 背景
- **双击行**或选中后按 Enter → 同 click
- **删除按钮** → 弹出 confirm dialog(复用已有的 `.confirm-dialog` portal 模式)
- 列表项 hover 显示浅背景 + 删除按钮

#### 1.2.5 「搜索命中」模式

当用户执行语义检索时,列表切换到搜索结果视图:

```
┌─ 搜索结果: "差旅标准" (3 条) ────────────┐
│ ○ 差旅标准2026                           │
│   报销制度 · 相似度 0.89                 │
│   「…国内差旅住宿标准按城市等级分为…」   │
├──────────────────────────────────────────┤
│ ○ 报销管理制度                           │
│   报销制度 · 相似度 0.72                 │
│   「…差旅费报销需提供交通票据和住宿…」   │
└──────────────────────────────────────────┘
```

- 每行显示 chunk 内容预览(前 120 字符) + 相似度分
- 点击 → 预览该文档(预览从文档开头开始,不高亮 chunk——后续迭代)
- 清除搜索 → 退出搜索模式,恢复分类筛选的文档列表

### 1.3 右侧预览(knowledge-preview)

**直接复用 `FilePreviewPage`:**

```tsx
<FilePreviewPage
  selection={selectedDocPreviewSelection}
  title={selectedDoc?.title}
  description="知识库文档预览"
/>
```

- 当没有选中文档时:显示 `FilePreviewPage` 的空状态("选择文件预览")
- 当选中后:加载文件内容,渲染(和聊天右边栏完全相同)
- 支持的格式:md / txt / png / jpg / gif / webp / xlsx / xls / csv / docx / pdf / pptx / ppt

**关键变更**:`FilePreviewPage` 需要新增一个 `PreviewFileSelection` 联合成员来支持知识库文件。

### 1.4 可调宽度分割线

复用 chat 页面已有的 `.divider` 拖拽方案:

```tsx
<div
  className="divider"
  onMouseDown={beginResize}
  role="separator"
  aria-orientation="vertical"
  tabIndex={0}
/>
```

- 拖拽范围:200px – 60vw
- CSS 变量 `--sidebar-w` 控制宽度
- 双击 divider → 重置为默认宽度 420px
- 与 chat 页行为完全一致(可从 `chat-page.tsx` 提取为共享 hook `useResizableSidebar`)

### 1.5 Topbar

```
┌──────────────────────────────────────────────────┐
│ 📚 知识库                    [上传] [返回驾驶舱] │
└──────────────────────────────────────────────────┘
```

- 返回按钮:`<Link href="/cockpit">` 或 `router.back()`
- Title 区域可选加文档总数 subtitle:"共 12 份文档,58 个分块"

---

## 2. 导航栏改造

### 2.1 当前位置

```tsx
// app/shared/app-nav.tsx, .nav-bottom div
<div className="nav-bottom">
  <Link href="/config" ...>设置</Link>
</div>
```

### 2.2 变更后

```tsx
<div className="nav-bottom">
  <Link
    className={active === "knowledge" ? "bottom-link active" : "bottom-link"}
    href="/knowledge"
    data-tooltip="知识库"
  >
    <span className="nav-link-content">
      <Library size={18} aria-hidden="true" />
      {collapsed ? null : <span>知识库</span>}
    </span>
  </Link>
  <Link
    className={active === "config" ? "bottom-link active" : "bottom-link"}
    href="/config"
    data-tooltip="设置"
  >
    <span className="nav-link-content">
      <Settings size={18} aria-hidden="true" />
      {collapsed ? null : <span>设置</span>}
    </span>
  </Link>
</div>
```

### 2.3 AppShell active 判断更新

`app/shared/app-shell.tsx` 中加一条:

```tsx
if (pathname.startsWith("/knowledge")) return { active: "knowledge", chatActive: null };
```

---

## 3. 数据流

### 3.1 状态管理

知识库页面是一个 `"use client"` 组件,状态全部用 `useState` + `useEffect` + `useCallback`(无全局 store):

```typescript
// 知识库页面状态
const [docs, setDocs] = useState<KnowledgeDocumentRow[]>([]);
const [filterCategory, setFilterCategory] = useState<string>("all");
const [searchQuery, setSearchQuery] = useState("");
const [searchMode, setSearchMode] = useState<"local" | "semantic">("local");
const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
const [selectedDocId, setSelectedDocId] = useState<number | null>(null);

// 上传状态
const [uploadExpanded, setUploadExpanded] = useState(true);
const [dragOver, setDragOver] = useState(false);
const [file, setFile] = useState<File | null>(null);
const [uploadCategory, setUploadCategory] = useState<string>("auto");
const [uploading, setUploading] = useState(false);
const [progress, setProgress] = useState("");

// 删除
const [deleteTarget, setDeleteTarget] = useState<KnowledgeDocumentRow | null>(null);

// 侧边栏宽度
const [sidebarWidth, setSidebarWidth] = useState(420);
```

### 3.2 数据加载

```typescript
// 初次加载
useEffect(() => {
  fetchDocs(filterCategory);
}, [filterCategory]);

// 上传后刷新
async function onUploadComplete() {
  await fetchDocs("all");       // 回到全部分类
  setFilterCategory("all");
  setUploadExpanded(false);
}

// 定期轮询(可选,如果其他端也在上传)
useEffect(() => {
  const interval = setInterval(() => fetchDocs(filterCategory), 30_000);
  return () => clearInterval(interval);
}, [filterCategory]);
```

### 3.3 预览选择构建

```typescript
// 选中一个文档 → 转为 PreviewFileSelection
function buildPreviewSelection(doc: KnowledgeDocumentRow): PreviewFileSelection {
  return {
    kind: "knowledge",
    documentId: doc.id,
    name: doc.file_name,
    mimeType: doc.mime_type,
    sizeBytes: doc.size_bytes,
  };
}
```

### 3.4 预览组件传入

```tsx
const selectedDoc = docs.find(d => d.id === selectedDocId);

<ChatPreviewSidebar
  collapsed={selectedDocId === null}
  previewSelection={selectedDoc ? buildPreviewSelection(selectedDoc) : null}
/>
```

---

## 4. 共享组件变更

### 4.1 `FilePreviewPage` — 新增 `KnowledgePreviewFile`

**`PreviewFileSelection` 联合类型扩展:**

```typescript
export type KnowledgePreviewFile = {
  kind: "knowledge";
  documentId: number;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type PreviewFileSelection =
  | ConversationPreviewFile
  | LocalPreviewFile
  | DraftPreviewFile
  | KnowledgePreviewFile;  // ← 新增
```

**`loadPreview` 分支(lib/agent 不碰,纯前端文件):**

```typescript
// 在 loadPreview 中,所有 switch 分支之前插入
if (selection.kind === "knowledge") {
  return loadKnowledgePreview(selection, extension, mimeType, meta);
}
```

```typescript
async function loadKnowledgePreview(
  selection: KnowledgePreviewFile,
  extension: string,
  mimeType: string,
  meta: PreviewMeta
): Promise<LoadedPreview> {
  const url = getKnowledgeFileUrl(selection.documentId);

  if (extension === "md") {
    const res = await fetch(url);
    return { kind: "markdown", text: await res.text(), meta };
  }
  if (extension === "txt") {
    const res = await fetch(url);
    return { kind: "text", text: await res.text(), meta };
  }
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) {
    return { kind: "image", src: url, meta };
  }
  if (["csv", "xlsx", "xls"].includes(extension)) {
    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const workbook = XLSX.read(bytes, { type: "buffer" });
    return {
      kind: "excel",
      workbook: { sheets: workbook.SheetNames.map(n => buildExcelSheet(n, workbook.Sheets[n])) },
      meta: { ...meta, sizeBytes: meta.sizeBytes ?? bytes.byteLength }
    };
  }
  if (extension === "docx") {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
    return { kind: "docx", html: sanitizePreviewHtml(value), meta };
  }
  if (extension === "pdf") {
    return { kind: "pdf", src: url, meta };
  }
  if (extension === "pptx" || extension === "ppt") {
    return { kind: "download", href: url, meta };
  }
  return { kind: "unsupported", meta, reason: `暂不支持预览 ${extension || "该"} 格式。` };
}
```

**`sourceLabel` 更新:**

```typescript
const sourceLabel =
  selection.kind === "local" ? "本地文件" :
  selection.kind === "draft" ? "草稿文件" :
  selection.kind === "knowledge" ? "知识库" :
  "对话文件";
```

**`loadText` / `loadBytes` 知识库分支:**

```typescript
// 在 loadText 中
if (selection.kind === "knowledge") {
  const res = await fetch(getKnowledgeFileUrl(selection.documentId));
  if (!res.ok) throw new Error("读取文本文件失败");
  return res.text();
}

// 在 loadBytes 中
if (selection.kind === "knowledge") {
  const res = await fetch(getKnowledgeFileUrl(selection.documentId));
  if (!res.ok) throw new Error("读取二进制文件失败");
  return new Uint8Array(await res.arrayBuffer());
}
```

### 4.2 新增辅助函数

```typescript
function getKnowledgeFileUrl(documentId: number): string {
  return `/api/knowledge/documents/${documentId}/file`;
}
```

### 4.3 `ChatPreviewSidebar` 可复用或原位嵌入

知识库页面可以选择:
- 直接 `<FilePreviewPage selection={...} />` 嵌在右侧
- 或用 `<ChatPreviewSidebar collapsed={false} selection={...} />` 复用它

推荐直接嵌入,因为知识库页没有 collapse/展开的交互,右侧始终显示——collapsed 时显示空状态。

---

## 5. 新增 API 端点

### 5.1 `GET /api/knowledge/documents/[id]/file`

**文件位置**:`app/api/knowledge/documents/[id]/file/route.ts`(新建)

**用途**:根据文档 ID 返回原始文件(bytes),供 `FilePreviewPage` 预览/下载。

**处理逻辑**:

```typescript
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const docId = Number(id);
  const doc = getKnowledgeDocumentById(docId);  // 按 ID 查一行

  if (!doc) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }

  const filePath = doc.storage_path;
  if (!filePath || !existsSync(filePath)) {
    return NextResponse.json({ error: "文件丢失" }, { status: 404 });
  }

  const buffer = readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": doc.mime_type || "application/octet-stream",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
```

**关键设计决策**:
- `Content-Disposition` 用 `inline`(不是 `attachment`),这样浏览器直接预览而非下载
- Cache 1 小时(`max-age=3600`),因为知识库文档很少热更新
- 不需要 Range 请求支持(react-pdf 在 iframe fallback 下可以不要;后续加)

### 5.2 需要补充的 DB 函数

`lib/db/sqlite.ts` 新增:

```typescript
export function getKnowledgeDocumentById(id: number): KnowledgeDocumentRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id) as
    KnowledgeDocumentRow | undefined;
}
```

### 5.3 已有的 API 直接复用

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/knowledge/documents` | GET | 文档列表 |
| `/api/knowledge/documents` | POST | 上传文档 |
| `/api/knowledge/documents/[id]` | DELETE | 删除文档 |
| `/api/knowledge/search` | POST | 语义检索 |
| `/api/knowledge/documents/[id]/file` | GET | 获取原始文件(新增) |

---

## 6. CSS 设计

### 6.1 新增 CSS 文件

**`app/styles/knowledge-page.css`** — 知识库页面专属样式。

**设计原则**:
- 复用项目 token 体系(`--cx-bg`, `--cx-surface`, `--cx-border`, `--accent`, `--text`, `--muted`)
- 继承 `.codex-content`, `.codex-topbar`, `.codex-main` 结构
- 不在已有 CSS 文件中追加(避免耦合)

```css
/* === Knowledge Page Layout === */

.knowledge-page {
  display: grid;
  grid-template-rows: 54px 1fr;
  height: 100dvh;
  overflow: hidden;
  background: var(--cx-bg);
}

.knowledge-page > .codex-topbar {
  border-bottom: 1px solid var(--cx-border);
  padding: 0 24px;
}

.knowledge-main {
  display: flex;
  flex-direction: row;
  overflow: hidden;
  height: 100%;
}

/* === Left Browser === */

.knowledge-browser {
  flex: 1 1 0;
  min-width: 280px;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--cx-border);
  background: var(--cx-surface);
}

/* Search Bar */
.knowledge-search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--cx-border);
  position: relative;
}

.knowledge-search-bar input {
  flex: 1;
  height: 36px;
  padding: 0 12px 0 36px;
  border: 1px solid var(--cx-border);
  border-radius: 8px;
  background: var(--cx-bg);
  color: var(--cx-text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}

.knowledge-search-bar input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-ring, rgba(49, 131, 216, 0.15));
}

.knowledge-search-bar input::placeholder {
  color: var(--cx-text-muted);
}

.knowledge-search-icon {
  position: absolute;
  left: 28px;
  color: var(--cx-text-muted);
  pointer-events: none;
}

.knowledge-search-clear {
  position: absolute;
  right: 24px;
  padding: 4px;
  border: none;
  background: none;
  color: var(--cx-text-muted);
  cursor: pointer;
  border-radius: 4px;
}

.knowledge-search-clear:hover {
  color: var(--cx-text);
  background: var(--cx-hover);
}

/* Upload Zone */
.knowledge-upload-zone {
  margin: 12px 16px;
  padding: 20px;
  border: 2px dashed var(--cx-border);
  border-radius: var(--radius, 10px);
  text-align: center;
  transition: border-color 0.2s, background 0.2s;
  cursor: pointer;
}

.knowledge-upload-zone:hover,
.knowledge-upload-zone.over {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}

.knowledge-upload-zone p {
  margin: 0;
  color: var(--cx-text-muted);
  font-size: 13px;
}

.knowledge-upload-zone .upload-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}

.knowledge-upload-zone .upload-file-name {
  margin-top: 8px;
  font-size: 13px;
  color: var(--cx-text);
  font-weight: 500;
}

/* Category Filter Chips */
.knowledge-category-chips {
  display: flex;
  gap: 6px;
  padding: 8px 16px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid var(--cx-border);
}

.knowledge-category-chips::-webkit-scrollbar {
  display: none;
}

.knowledge-category-chip {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--cx-border);
  background: transparent;
  color: var(--cx-text-soft);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}

.knowledge-category-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.knowledge-category-chip.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

/* Document List */
.knowledge-doc-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.knowledge-doc-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 16px;
  cursor: pointer;
  transition: background 0.1s;
  border-left: 3px solid transparent;
  position: relative;
}

.knowledge-doc-item:hover {
  background: var(--cx-hover);
}

.knowledge-doc-item.selected {
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border-left-color: var(--accent);
}

.knowledge-doc-item .doc-icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--cx-bg);
  color: var(--cx-text-muted);
  font-size: 16px;
}

.knowledge-doc-item .doc-info {
  flex: 1;
  min-width: 0;
}

.knowledge-doc-item .doc-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--cx-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.knowledge-doc-item .doc-meta {
  font-size: 12px;
  color: var(--cx-text-muted);
  margin-top: 2px;
}

.knowledge-doc-item .doc-meta-row {
  font-size: 12px;
  color: var(--cx-text-subtle);
  margin-top: 1px;
}

.knowledge-doc-item .delete-btn {
  flex-shrink: 0;
  padding: 4px;
  border: none;
  background: none;
  color: var(--cx-text-muted);
  cursor: pointer;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.1s, color 0.1s;
}

.knowledge-doc-item:hover .delete-btn {
  opacity: 1;
}

.knowledge-doc-item .delete-btn:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}

/* Search Result Mode */
.knowledge-search-result-item .chunk-preview {
  font-size: 12px;
  color: var(--cx-text-soft);
  margin-top: 4px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.knowledge-search-result-item .score-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-weight: 500;
}

/* Empty State */
.knowledge-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  color: var(--cx-text-muted);
}

.knowledge-empty-state svg {
  color: var(--cx-text-subtle);
}

.knowledge-empty-state h3 {
  font-size: 16px;
  color: var(--cx-text);
  margin: 0;
}

/* Loading state for the document list */
.knowledge-doc-list .loading-row {
  padding: 16px;
  text-align: center;
  color: var(--cx-text-muted);
  font-size: 13px;
}

/* Upload progress bar */
.knowledge-upload-progress {
  height: 4px;
  margin-top: 8px;
  border-radius: 2px;
  background: var(--cx-border);
  overflow: hidden;
}

.knowledge-upload-progress span {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: inherit;
  transition: width 0.3s;
}
```

### 6.2 注册 CSS

在 `app/styles/index.css` 中追加一行:

```css
@import "./knowledge-page.css";
```

注意放在 `knowledge.css` 之后(该文件继续服务于设置里的旧知识库 tab,保留不改)。

### 6.3 明暗主题适配

所有颜色使用 `--cx-*` / `--accent` / `--danger` / `--text` 等 token,**无需单独写 `[data-theme="dark"]` 覆盖**。token 体系自动处理。

唯一需要独立处理的:
- `.knowledge-category-chip.active` 的文字颜色在暗色模式下保持 `#fff`,token 已保证
- `.knowledge-upload-zone.over` 的 `color-mix` 在暗色下也正确(browser color-mix 支持)

---

## 7. 文件结构

### 7.1 新建文件

| 文件 | 说明 |
|---|---|
| `app/knowledge/page.tsx` | 知识库页面(覆盖现有 redirect) |
| `app/knowledge/knowledge-browser.tsx` | 左侧浏览器组件(搜索+上传+分类+列表) |
| `app/knowledge/knowledge-preview-panel.tsx` | 右侧预览面板(薄封装 `FilePreviewPage`) |
| `app/knowledge/knowledge-upload-zone.tsx` | 上传区域组件 |
| `app/knowledge/knowledge-doc-list.tsx` | 文档列表组件 |
| `app/knowledge/knowledge-types.ts` | 页面级类型(如有需要) |
| `app/api/knowledge/documents/[id]/file/route.ts` | 文件服务 API |
| `app/styles/knowledge-page.css` | 知识库页面样式 |

### 7.2 修改文件

| 文件 | 改动 |
|---|---|
| `app/knowledge/page.tsx` | 从 redirect 改为真实页面组件 |
| `app/shared/app-nav.tsx` | 在 `.nav-bottom` 的「设置」上方添加「知识库」入口 |
| `app/shared/app-shell.tsx` | `active` 判断加 `knowledge` 分支 |
| `app/shared/file-preview-page.tsx` | `PreviewFileSelection` 加 `KnowledgePreviewFile`;`loadPreview`/`loadText`/`loadBytes` 加知识库分支;`sourceLabel` 加 "知识库" |
| `lib/db/sqlite.ts` | 新增 `getKnowledgeDocumentById` 函数 |
| `app/styles/index.css` | 追加 `@import "./knowledge-page.css"` |
| `app/config/knowledge/knowledge-settings.tsx` | 无需改动(设置里的老知识库 tab 保留) |

### 7.3 不动的文件

| 文件 | 原因 |
|---|---|
| `app/config/page.tsx` / `skill-center.tsx` | 设置浮窗不动,知识库 tab 保留(可能是快速入口) |
| `app/api/knowledge/documents/route.ts` | 已有 CRUD,复用 |
| `app/api/knowledge/search/route.ts` | 已有检索,复用 |
| `app/config/knowledge/knowledge-settings.tsx` | 不动 |
| `app/styles/knowledge.css` | 设置里的旧样式保留 |
| `app/styles/settings-float.css` | 不动 |
| `app/chat/chat-preview-sidebar.tsx` | 不动(chat 页继续使用) |

---

## 8. 实施步骤

按依赖关系排序,每步独立可测:

### Step 1 — DB 补函数 + API 端点(无 UI 依赖)

1. `lib/db/sqlite.ts` 加 `getKnowledgeDocumentById()`
2. 新建 `app/api/knowledge/documents/[id]/file/route.ts`
3. 验证:`curl http://localhost:3000/api/knowledge/documents/1/file` 返回文件内容

**验收**:已有文档能通过 ID 下载原始文件。

### Step 2 — `FilePreviewPage` 扩展(前端基础设施)

1. 类型扩展:`KnowledgePreviewFile` 加到 `PreviewFileSelection`
2. `loadPreview` / `loadText` / `loadBytes` / `loadKnowledgePreview` / `getKnowledgeFileUrl` 全部加好
3. `sourceLabel` 更新
4. `npm run build` 绿

**验收**:类型通过,无引入运行时错误。

### Step 3 — 知识库页面组件(纯 UI)

1. 新建 `app/knowledge/knowledge-browser.tsx`(搜索 + 上传 + chips + 列表)
2. 新建 `app/knowledge/knowledge-upload-zone.tsx`
3. 新建 `app/knowledge/knowledge-doc-list.tsx`
4. 新建 `app/knowledge/knowledge-preview-panel.tsx`
5. 重写 `app/knowledge/page.tsx`(不再是 redirect)
6. 新建 `app/styles/knowledge-page.css`
7. 在 `app/styles/index.css` 注册

**验收**:`/knowledge` 路由渲染知识库页面,上传/搜索/删除/预览全部交互可用。

### Step 4 — 导航栏入口 + 路由连接

1. `app/shared/app-nav.tsx` 加知识库入口
2. `app/shared/app-shell.tsx` 路由匹配
3. 验证:侧边栏点击「知识库」→ 跳转 `/knowledge` → active 高亮

### Step 5 — 全链路集成测试

1. 上传一个新文件 → 列表出现 → 点击 → 右侧预览加载
2. 拖拽上传 → 自动分类检测 → 手动覆盖 → 上传
3. 分类筛选 → 列表过滤 → 计数正确
4. 语义搜索 → 结果命中 → 点击预览
5. 删除 → confirm dialog → 列表移除 → 预览清空
6. 暗色模式切换 → 所有颜色正确
7. 调整分割线宽度 → 保存
8. `npm run build` 绿

---

## 9. 验收清单

### 9.1 功能

- [ ] 侧边栏「知识库」在「设置」上方,点击跳转 `/knowledge`,icon 高亮
- [ ] 页面左侧浏览区:搜索栏 + 上传区 + 分类 chips + 文档列表
- [ ] 上传支持拖拽 + 点击选择;自动分类;进度显示;完成后列表刷新
- [ ] 分类筛选 chips 正确计数,点击过滤列表
- [ ] 文档列表显示 title / 分类 / 分块数 / 大小 / 时间,单击选中,悬停出现删除按钮
- [ ] 语义搜索返回结果,展示相似度分 + 文档名 + chunk 预览
- [ ] 选中文件后,右侧 `FilePreviewPage` 渲染文件内容(和聊天预览完全一致)
- [ ] 删除按钮 → confirm dialog → 删除后列表更新 + 预览清空
- [ ] 无文档时显示 empty state(引导上传)
- [ ] 分割线可拖拽调整宽度(200–60vw)

### 9.2 兼容

- [ ] 暗色模式切换后所有区域颜色正确,无不透明硬编码背景
- [ ] 窄屏时左侧浏览器仍可滚动内容
- [ ] 聊天页右侧预览不受影响(共享 `FilePreviewPage`)

### 9.3 代码

- [ ] `npm run build` 绿
- [ ] 无 TypeScript 错误
- [ ] 设置里的旧知识库 tab 不受影响
- [ ] 新 CSS 文件使用 token 变量,无硬编码色值

---

## 10. 扩展方向(不在本期)

- 批量上传(多选)
- 知识库文档内容高亮搜索结果(滚动到命中 chunk)
- 和聊天页联动("引用这条知识到聊天")
- 文档编辑/重新索引
- 右键菜单(重命名、下载、移动分类)
- 知识库导出/导入
- 文档版本历史
