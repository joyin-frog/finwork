# Spec:统一文件库(索引 + 浏览/导出 + 生命周期解耦)

## 背景与目标
三类文件——用户上传 / agent 生成 / 知识库——都在系统应用数据目录下,但**散、藏、删对话误删报表**:
- 上传 + 生成在 `files/<会话ID>/`,DB `chat_attachments` 表已记录(`file_name` / `mime_type` / `size_bytes` / `storage_path` / `role` / `created_at`,FK `message_id` → `chat_messages` ON DELETE CASCADE),按会话隔离。
- 知识库原件在知识存储目录 + `knowledge-text/<hash>.txt` 镜像,DB `knowledge_documents` 已记录(`storage_path` / `content_hash` / `size_bytes` / `category` / `archived` …)。
- **痛点**:① 文件藏在隐藏的应用数据目录、按会话数字 ID 散落 → 用户**找不到、导不出**;② **删对话 = FK 级联删 `chat_attachments` + `rm files/<会话ID>/` → 生成的报表跟着没了**。

目标:**给用户一个「文件库」——看得到、搜得到、预览、在系统里打开、导出、删除;并让标了「保留」的文件不随对话删除而丢。** 不重做底层存储、不做去重(镜像有意为之、磁盘便宜)、本轮不动 Windows 存储位置。

## 设计

### A. 统一文件索引(复用现有两表,不新建大表)
- 一个**统一查询** UNION:
  - `chat_attachments` → `kind` 按 `role` 分「上传」/「生成」(**先确认 `role` 取值**,如 user / assistant / 生成);带所属会话(join `chat_messages`/`chat_conversations` 取会话标题)、`storage_path`、`size_bytes`、`file_name`、`mime_type`、`created_at`。
  - `knowledge_documents`(`archived=0`)→ `kind`「知识库」;带 `category`、`storage_path`、`size_bytes`、`file_name`、`mime_type`、`created_at`。
- 后端查询函数 `listAllFiles({ kind?, q?, sort? })` + API `GET /api/files`,返回统一形状:`{ id, kind: "upload"|"generated"|"knowledge", name, mime, sizeBytes, source(会话标题/知识类目), storagePath, createdAt, kept }`。
- **务必先确认 agent 生成文件确实写了 `chat_attachments` 行(role=生成)**;若生成文件只落盘没入库,补一处落库(生成落盘时记一行),否则文件库漏生成文件(AC6)。

### B. 文件库页(`app/files/page.tsx` + 侧栏/导航入口)
- 列表列:名称 · 类型徽标(上传/生成/知识)· 来源(会话标题 / 知识类目)· 大小 · 时间。
- **搜索框 + 按 类型/来源/时间 筛选 & 排序**。
- 行操作:
  - **预览**:复用 `app/shared/file-preview-page.tsx`(含刚增强的 Excel)。
  - **在系统文件管理器中显示**:Tauri opener/shell 揭示文件(mac=Finder / Win=资源管理器)。
  - **导出**:Tauri 保存对话框,把文件另存到用户选的位置(或拷到系统下载目录)。
  - **删除**:走确认,**删盘 + 删 DB 记录 + 落审计**(红线 5/8)。
- Folio `--doc-*` token、跟现有页风格一致;空态 / 加载态。

### C. 生命周期解耦(删对话别误删「保留」文件)
- `chat_attachments` 加列 `kept INTEGER NOT NULL DEFAULT 0`(经 `addColumnIfMissing`,迁移系统已有,见 `schema.ts`)。
- 文件库/预览里可把某个生成/上传文件标「**保留**」。
- 改对话删除流程(`app/api/chat/recent` 删会话处):删会话**前**,对 `kept=1` 的附件——**先把文件从 `files/<会话ID>/` 移到非会话库目录(如 `files/library/`)、更新 `storage_path`,再让该行不随级联删除**(把归属重置:`message_id` 置空 + 标 `is_library`,或迁一张 `library_files` 表——选**最干净、FK 安全**的那种)。**绝不在移动成功前删源;移动失败则报错、不删会话文件。**
- 未标保留的附件:照旧随会话删除。

## 红线 / 约束
- **红线 5**:删除是不可逆写 → 过确认门(`riskLevel` 思路 / UI 二次确认);保留/迁库属内部写。
- **红线 7**:全本地;导出走系统保存对话框/下载目录,**不上传任何文件**。
- **红线 8**:删除 / 保留 / 导出 落 `audit_logs`(`insertAuditLog`)。
- **最小改动**:不动底层存储布局、不去重、不动 Windows 路径、不动 docx/pdf/图片预览逻辑、不动既有聊天上传/知识入库主流程(只加 kept + 文件库视图)。

## 验收(AC)
- **AC1** 文件库列出三类文件(上传/生成/知识),来源/大小/时间正确。
- **AC2** 搜索 + 按 类型/来源/时间 筛选/排序可用。
- **AC3** 行操作:预览打开正确文件;「在系统中显示」调起 Finder/Explorer(测试可 mock Tauri);导出把文件存到用户选位置;删除同时删盘 + 删记录 + 落审计。
- **AC4** 生命周期:把某生成文件标「保留」→ 删除其所属对话 → 该文件**仍在文件库、磁盘文件还在(已迁库目录)**;未保留的随对话删除消失。**移动失败不删源、显式报错。**
- **AC5** 回归:聊天上传/生成、知识库、对话删除(非保留)行为不变。
- **AC6** 生成文件入库完整(若原先漏库,已补落库)。

## 测试
- 后端 DB/逻辑测试(隔离 DB via `FINANCE_AGENT_DB_PATH` 临时):`listAllFiles` 三类聚合 + 筛选;`kept` 迁库(标保留→删会话→文件迁库目录、记录留存、源已无、移动失败不删源);删除=删盘+删记录+审计;Tauri opener/导出在测试里 mock。导出 `unifiedFileLibraryTestPromise`,wire 进 `tests/all.test.ts`。
- `npm run typecheck` / `npm test`(`# fail` 0,末尾 pptx/secret-store 既有告警忽略)/ `npm run lint` 全绿。
- 可选:文件库页 e2e 截图(沿用 `e2e/` 现有 harness 思路)。

## 文件(预计)
- `lib/db/schema.ts`(`kept` 列)、`lib/db/sqlite.ts`(`listAllFiles` 聚合、kept 标记、迁库 helper、删除删盘+审计)
- `app/api/files/route.ts`(列表)+ 导出/reveal/删除/保留 的 API 或 Tauri 命令封装
- `app/files/page.tsx`(文件库页)+ 导航入口
- `app/api/chat/recent`(删会话时保留文件迁库)
- 生成文件落库补丁(若需)
- 测试(+ 可选 e2e 截图 spec)

## 不做(本期边界)
- 去重 / 内容寻址;**Windows Roaming↔Local 迁移**(单独 follow-up,涉及数据迁移 + mac 不可验);Excel 编辑;改存储根位置;改知识库镜像机制。
