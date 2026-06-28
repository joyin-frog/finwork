# Finance Agent 四模块重构 Spec

> 版本 v1.0 / 2026-06-08
> 目标：把"基于本地向量库的 RAG 知识库"改造成"基于 ripgrep 的关键词检索 + 文件附件流"；同时简化 Memory、加固 Agent 工具集、引入角色模式（日常/技术）。

---

## 0. 总览

| 模块 | 现状 | 目标 |
| --- | --- | --- |
| 知识库 | 上传 → 分块 → bge-small 向量 → SQLite-vec + FTS5 + RRF | 上传 → 仅写文件元数据 → ripgrep 直接搜文件内容 |
| Agent 工具 | `search_knowledge_base`（向量） | 新增 `search_knowledge` / `grep_docs` / `read_file`（三选一由 Claude 自决） |
| Memory | SQLite 表 + auto-extractor + MCP 工具 | 单文件 `memory.md`，每次对话拼入 system prompt 头部 |
| 角色模式 | 无 | 设置页单选「日常 / 技术」→ 影响 prompt 风格 + UI 显隐 |

实施顺序与 Task 列表一致：spec → 知识库后端 → 知识库 UI → 工具 → Memory → Role。

### 0.1 已确认决策（2026-06-08 锁定）

| # | 决策 | 内容 |
| - | --- | --- |
| D1 | 明文镜像 | 上传时对所有支持的格式（md/txt/csv/pdf/docx/xlsx）多写一份 `<hash>.txt` 到 `knowledge-text/`，rg 只搜该目录。代价：多 ~1× 文本体积存储。 |
| D2 | 跨页传附件 | "添加到对话"走 `sessionStorage.pendingChatAttachments`，chat-page 挂载时消费一次后清空。不走 URL query（装不下大文件）。 |
| D3 | RoleMode 默认值 | `roleMode` 默认 `"tech"`，老用户行为不变；用户在设置页主动切到 `"daily"` 才进入简洁模式。 |

---

## 1. 模块一：知识库

### 1.1 保留 / 删除清单

**保留**
- 上传/列表/删除 UI（`app/config/knowledge/`）
- 文件落盘：`<appDataDir>/finance-agent/knowledge/<sha256>.<ext>`（`lib/knowledge/storage.ts` 全部）
- SQLite 表 `knowledge_documents`（去掉 `chunk_count` 列的语义，保留列）
- 分类推断 `lib/knowledge/category.ts` —— 上传时仍要分类标签用于过滤
- 文件解析 `lib/knowledge/parsers/index.ts`（保留 PDF/Excel/docx → text 用于落盘成可搜索的 `.txt` 镜像）

**删除**
- `lib/knowledge/embedding/`（整个目录）
- `lib/knowledge/vector-store.ts`
- `lib/knowledge/retriever.ts`
- `lib/knowledge/chunker.ts`
- `lib/knowledge/pipeline.ts`（替换为 `ingestDocument` 新实现：写元数据 + 写明文镜像）
- `lib/knowledge/types.ts`：移除 `DocumentChunk` / `SearchResult` 类型
- SQLite 表：`knowledge_chunks` / `knowledge_chunks_fts` / `knowledge_vec` / `knowledge_query_log`（写 DROP 的 migration）
- `models/Xenova/bge-small-zh-v1.5/` 目录（手动 / 让用户删）
- `scripts/setup-models.mjs` 与 `npm run setup:models`
- `package.json` 依赖：`@xenova/transformers`、`sqlite-vec`
- `next.config.ts`：`serverExternalPackages` 中的 `sqlite-vec` 条目
- `lib/runtime/flags.ts`：`MEMORY_SEMANTIC_RECALL_ENABLED` / `RAG_HYBRID_ENABLED` / `RAG_AUTO_INJECT_ENABLED` 三个 flag
- `app/api/agent/query/route.ts` 中的 `retrieve` / `rerank` 调用与 `ragContext` 注入

### 1.2 文件落盘与"明文镜像"

为了让 ripgrep 能搜 PDF / docx / xlsx 的内容：
- 上传时除了写原始文件 `<hash>.<ext>`，同时 `parseDocument()` 抽取出文本，写一份 `<hash>.txt` 到 `<appDataDir>/finance-agent/knowledge-text/`。
- 搜索 rg 时只搜 `knowledge-text/` 目录；展示时回查 `knowledge_documents` 表把 `<hash>` 映射回原文件名与原路径。
- 对原本就是 `.txt/.md/.csv` 的文件，明文镜像就是原文本身。

### 1.3 后端搜索 API

#### `POST /api/knowledge/search`

请求：
```ts
{
  query: string;          // 用户输入；若 ' OR ' 拆分则多关键词 OR
  regex?: boolean;        // 默认 false；true 时 query 直接当正则
  topK?: number;          // 默认 20，返回多少个文件
}
```

响应：
```ts
{
  ok: true,
  data: {
    files: Array<{
      docId: number;
      title: string;       // knowledge_documents.title
      fileName: string;    // 原文件名（含扩展）
      category: KnowledgeCategory;
      hitCount: number;    // rg 在该文件命中的总行数
      matches: Array<{
        lineNo: number;        // 1-based
        line: string;          // 匹配的那一行原文
        before: string[];      // 前 5 行（不足则少）
        after: string[];       // 后 5 行
        ranges: Array<[number, number]>;  // 该行内匹配到的字节区间，用于高亮
      }>;     // 单文件最多返回前 10 条匹配（命中过多时截断，hitCount 仍是总数）
    }>;
    totalFiles: number;
    truncated: boolean;       // hitCount > 10 的文件即视为该文件截断
    elapsedMs: number;
  }
}
```

排序：`files` 按 `hitCount` 降序，二序为 `title`。

#### 实现要点（`lib/knowledge/rg-search.ts` 新文件）

```ts
import { spawn } from "node:child_process";
import { getKnowledgeTextDir } from "@/lib/knowledge/storage";

export async function searchKnowledge(opts: {
  query: string;
  regex?: boolean;
  topK?: number;
}): Promise<RgSearchResult>
```

- 调 `rg --json -n -C 5 -i [--fixed-strings|无] <query> <textDir>`。
- `--json` 输出按 `match` / `context` / `begin` / `end` event 分组，按文件聚合行号、前后文与高亮区间。
- `query` 中检测到 `' OR '`（带空格）拆分为多个 pattern：`rg -e a -e b`。
- 二进制 `rg` 在 PATH 找不到时返回 `{ ok:false, error:"rg not installed" }`，UI 提示。
- 严格限制搜索目录为 `getKnowledgeTextDir()`，防止穿越。

#### `GET /api/knowledge/documents/[id]/content`（新增）

返回该文档的明文镜像文本（`<hash>.txt`），用于：
- 搜索结果页右侧的文件预览。
- "添加到对话" 时前端拉取以构造 `ChatAttachment`。

响应：
```ts
{ ok: true, data: { title, fileName, mimeType, text: string } }
```

#### `GET /api/knowledge/documents/[id]/download`（新增）

返回 **原始文件** 二进制（不是明文镜像）。`Content-Disposition: attachment; filename=<原文件名>`。"添加到对话" 用这个，让对话流跟普通文件附件完全一致。

#### 文档列表与删除

`GET/POST /api/knowledge/documents` 与 `DELETE /api/knowledge/documents/[id]`：
- 移除所有对 `ingestDocument(chunks/embeddings)` 的依赖。
- 新 `ingestDocument`：写 `knowledge_documents` 一行 + 写 `<hash>.<ext>` + 写 `<hash>.txt`，不再返回 `chunkCount`（API 兼容返回 `chunkCount: 0`）。
- 删除时同时删 `<hash>.txt`。

### 1.4 前端搜索页

#### 路由
- 新页：`app/knowledge/page.tsx` 重写为"搜索 + 结果 + 预览"工作台（替换原来的 `<KnowledgeSettings />` 引用，那个保留给配置页）。
- 配置页 `app/config/knowledge/knowledge-settings.tsx` 保留上传/列表/删除部分，搜索预览面板（hits `/api/knowledge/search`）删除。

#### 页面结构

```
[顶栏: 输入框 + 「正则」开关 + 「搜索」按钮]
[主区: 左 320px 结果列表 | 右 自适应 文件预览]
```

**左侧结果列表**
- 每个文件一张卡片：
  - 文件名 / 分类 badge / 总命中数
  - 列出本文件的匹配片段（最多 10 条），每条：`L{lineNo} · {line 单行截断 + 关键词高亮}`
  - 卡片右上角：「添加到对话」按钮（icon + 文本）
- 点击某条匹配 → 设置当前预览 `{ docId, lineNo }`。
- 没命中：空态文案 + 「确认 rg 已安装」提示。

**右侧文件预览**
- 调 `GET /api/knowledge/documents/[id]/content`，按行渲染（`<pre>` + 每行带 `data-line` 属性）。
- 自动 `scrollIntoView({ block: "center" })` 到目标行。
- 目标行整行 `background: var(--accent-soft)`，加 `box-shadow inset 3px 0 0 var(--accent)` 左侧色条。
- 该行内的关键词进一步高亮（`<mark>` 包裹）。
- 顶部显示 `文件名 · 第 X / Y 行`。

**关键词高亮**
- 复用搜索时的 `ranges` 与原查询。客户端不做正则解析；服务端在结果里已经给了 `ranges`，预览要全文高亮则在客户端按同样的关键词在每一行重新匹配（简单 `split + regex`），与服务端用同一份模式串。

#### "添加到对话"流程

约束：与现有文件附件流程一致——必须落地为 `ChatAttachment {id, name, mimeType, size, dataUrl, text?}`，并出现在新会话输入框的待发送区。

实现方案：
1. 点击 → `fetch('/api/knowledge/documents/{id}/download')` 取原始二进制。
2. `new File([blob], fileName, { type: mimeType })` → 调用现有 `readAttachment(file)` 函数（在 `app/chat/chat-request.ts` 已有）得到 `ChatAttachment`。
3. 暂存到 `sessionStorage` 的 `pendingChatAttachments` 队列（JSON 数组：`ChatAttachment[]`，含 dataUrl）。
4. `router.push('/chat/new')`。
5. `app/chat/chat-page.tsx` 挂载后在 `useEffect` 检查 `sessionStorage.pendingChatAttachments`：有则 `setAttachments(prev => [...prev, ...pending])`，然后清空。

为什么用 sessionStorage 而不是 URL query：附件可能较大（PDF 几 MB），URL 装不下；React Server Components 之间也没法直接传 client 状态。sessionStorage 是当前 origin 同窗口的最干净方案，刷新不会重复触发因为读完即清。

#### 高亮性能

- 单次最多渲染 20 个文件卡 × 10 条片段；预览页 10MB 以内文本同步渲染足够。
- 大于 2MB 的文本提示「文件较大，仅显示前 1MB」+ 提供「下载完整文件」按钮。

### 1.5 SQLite Migration

新文件 `lib/db/migrations/<n>__drop_rag.sql`（按现有 migration 命名规则）：
```sql
DROP TABLE IF EXISTS knowledge_chunks_fts;
DROP TABLE IF EXISTS knowledge_chunks;
DROP TABLE IF EXISTS knowledge_vec;
DROP TABLE IF EXISTS knowledge_query_log;
DELETE FROM app_settings WHERE key = 'knowledge_embed_dim';
```
保留 `knowledge_documents`，`chunk_count` 列保留但新代码永远写 0。

---

## 2. 模块二：Agent 工具

### 2.1 新增三个工具

均注册到 `finance_worker` MCP server（`lib/agent/mcp-tools/`）。`Read` 已是 builtin，新增的 `read_file` 与 builtin `Read` 并存——`read_file` 是受限版（只能读知识库目录与会话工作区），描述更聚焦。

#### `mcp__finance_worker__search_knowledge`

```ts
sdk.tool(
  "search_knowledge",
  "当用户询问知识、政策、文档内容、操作规范时调用。先用 ripgrep 在知识库中精确搜索关键词，返回 top3 文件的匹配片段（含前后各 5 行上下文）。闲聊、问候、纯计算类问题不要调用此工具。无结果时返回明确的空提示。",
  {
    query: z.string().describe("自然语言或关键词；可用 'A OR B' 表达多关键词"),
    topK: z.number().int().min(1).max(5).default(3),
  },
  async ({ query, topK }) => {
    const res = await searchKnowledge({ query, topK: topK ?? 3 });
    if (!res.files.length) return "知识库中未找到相关内容。";
    return formatForLlm(res.files.slice(0, topK));   // 标题 + 命中数 + 每条 line + before/after
  }
)
```

#### `mcp__finance_worker__grep_docs`

```ts
sdk.tool(
  "grep_docs",
  "当用户给出确切关键词需要精确定位文档时调用。比 search_knowledge 更底层：直接 rg 搜索，返回文件名 + 行号 + 匹配行（不含前后文）。适合精确术语、编号、专有名词查找。",
  {
    pattern: z.string().describe("要搜的字符串或正则"),
    regex: z.boolean().default(false),
    topK: z.number().int().min(1).max(50).default(20),
  },
  async ({ pattern, regex, topK }) => {
    const res = await searchKnowledge({ query: pattern, regex, topK });
    if (!res.files.length) return "无匹配。";
    const lines: string[] = [];
    for (const f of res.files) {
      for (const m of f.matches) {
        lines.push(`${f.fileName}:${m.lineNo}: ${m.line.trim()}`);
      }
    }
    return lines.slice(0, 200).join("\n");
  }
)
```

#### `mcp__finance_worker__read_file`

```ts
sdk.tool(
  "read_file",
  "当现有片段信息不足、需要读取知识库文件完整内容时调用。输入知识库文件路径或文件名，返回该文件全文。",
  {
    fileName: z.string().describe("文件名（如 '差旅报销制度.md'）或 docId 数字字符串"),
  },
  async ({ fileName }) => {
    const doc = resolveDocByNameOrId(fileName);
    if (!doc) return `未找到 ${fileName}`;
    const text = readTextMirror(doc);   // 读 <hash>.txt
    if (text.length > 200_000) {
      return text.slice(0, 200_000) + "\n\n[...内容过长，已截断，共 " + text.length + " 字符]";
    }
    return text;
  }
)
```

### 2.2 注册到 registry

`lib/agent/tools/registry.ts`：
- 删除：`mcp__finance_worker__search_knowledge_base`、`mcp__finance_worker__save_memory`、`mcp__finance_worker__recall_memory`、`mcp__finance_worker__forget_memory`。
- 新增：
  ```ts
  { name: "mcp__finance_worker__search_knowledge", category: "finance", riskLevel: "safe" },
  { name: "mcp__finance_worker__grep_docs",        category: "finance", riskLevel: "safe" },
  { name: "mcp__finance_worker__read_file",        category: "finance", riskLevel: "safe" },
  ```
- `BASE_TOOLS` 删除 save/recall/forget_memory，加入三个新工具：
  ```ts
  export const BASE_TOOLS = [
    "Read", "Glob", "Grep", "AskUserQuestion",
    "mcp__finance_worker__search_knowledge",
    "mcp__finance_worker__grep_docs",
    "mcp__finance_worker__read_file",
  ];
  ```

### 2.3 MCP server 装配

`lib/agent/mcp-tools/index.ts` 中 `createFinanceMcpServer`：
- 删除：`createKnowledgeBaseTool`、memory 三件套。
- 新增：`createSearchKnowledgeTool`、`createGrepDocsTool`、`createReadFileTool`，在 `lib/agent/mcp-tools/knowledge.ts` 重写为这三个。

`claude-adapter.ts` 无须改动（仍把 finance_worker 整体挂到 `mcpServers`）。

### 2.4 System prompt 中的工具指引

`lib/agent/system-prompt.ts` 的 `buildStaticPrefix`：
- 把所有 `search_knowledge_base` 改为 `search_knowledge`。
- 删除 `recall_memory` / `save_memory` 提示语。
- 知识检索说明改写为：
  > 涉及公司制度、政策、合同、财务规范的问题：优先调用 `search_knowledge`；需要精确定位术语或编号时用 `grep_docs`；现有片段不足时用 `read_file` 取完整内容。无搜索结果时如实告知，不可凭记忆作答。

---

## 3. 模块三：Memory 简化

### 3.1 数据结构

- 路径：`<appDataDir>/finance-agent/memory.md`（新增 `getMemoryPath()` 到 `lib/runtime/paths.ts`，支持 `FINANCE_AGENT_MEMORY_PATH` env 覆盖）。
- 格式：纯 Markdown，无 frontmatter，用户/系统自由编辑。
- 上限：64 KB（约 1.6 万中文字）；超出时只取前 64 KB 注入并打 warn。

### 3.2 注入

`lib/agent/system-prompt.ts`：
- `SystemPromptContext` 中 `memorySnapshot` 字段 **删除**，新增 `memoryMarkdown?: string`。
- `buildStaticPrefix` **不变**（静态可缓存部分不放 memory，因为 memory 可能改）。
- 新增 Part D 注入到 dynamic suffix 顶部（最靠近 boundary，紧跟 Part A）：
  ```
  ## 用户长期记忆（请在回答前先理解以下内容）
  {memoryMarkdown}
  ```
- 当 `memoryMarkdown` 为空字符串或文件不存在时，整段不出现。

`lib/agent/claude-adapter.ts`：
```ts
const memoryMarkdown = await readMemoryMarkdown();   // 不存在返回 ""
const systemPromptParts = buildSystemPromptParts({
  enabledSkills, identity, skillOverride, memoryMarkdown,
});
```

新文件 `lib/memory/file-store.ts`：
```ts
export async function readMemoryMarkdown(): Promise<string>
export async function writeMemoryMarkdown(text: string): Promise<void>
```

### 3.3 删除清单

- `lib/memory/store.ts` / `auto-extractor.ts` / `types.ts`（整目录替换成 `file-store.ts`）。
- `lib/agent/mcp-tools/memory.ts`
- registry 中 `save_memory` / `recall_memory` / `forget_memory`
- `claude-adapter.ts` 中 `MemoryStore` 引用与 `extractMemoryCandidates(...)` 调用
- SQLite `memory_entries` 与相关 FTS / 索引（新 migration DROP）
- `MEMORY_SEMANTIC_RECALL_ENABLED` flag

### 3.4 设置入口（最小）

不在本次范围（用户说"自己维护或由系统自动生成"）。后续可在常规设置加一个简易 textarea 直接编辑 `memory.md`，本次不做。

---

## 4. 模块四：Role Setting

### 4.1 Settings 字段

`lib/settings/claude-settings.ts`：
```ts
export type RoleMode = "daily" | "tech";

export type ClaudeSettings = {
  // ...既有字段
  roleMode: RoleMode;     // 默认 "tech"（保持现有行为）
};
```

读、写、`PublicClaudeSettings`、defaultSettings 全部加上。`/api/settings/claude` 的 PUT body 接受 `roleMode`。

### 4.2 设置页 UI

`app/config/model/model-settings.tsx`：在「推理模型」下方加一段「角色模式」radio：
```
○ 日常模式  · 简洁回复，隐藏工具与思考过程
● 技术模式  · 详细回复，展示完整工具与思考链
```
保存按钮同既有逻辑（`skill-center.tsx` 持有 state，提交 PUT）。

### 4.3 System prompt 分支

`buildStaticPrefix(agentName, madeBy, roleMode)`：
- **技术模式**（默认）：保留现有"工作守则"原文。
- **日常模式**：替换为：
  > ## 回答风格
  > - 简洁直接，少术语，少代码块。
  > - 不主动展示推理过程；如需要思考，内部完成即可。
  > - 工具调用按需进行，但回复中不解释"我刚才查了什么"。

### 4.4 前端显隐

`PublicClaudeSettings.roleMode` 需要传到 chat page。两种路径择一：
- 在 `app/chat/page.tsx`（server component）`await readPublicClaudeSettings()` 把 `roleMode` 传进 `<ChatPage initialRoleMode={...} />`。
- 通过 client `fetch('/api/settings/claude')` 读取并缓存到一个 React Context。

选 server-prop 路径，简单。

`chat-page.tsx` 接受 `initialRoleMode: RoleMode`，存入 state。

**思考块**（`AssistantTurn` 内）：
- `roleMode === "daily"`：丢弃 `thinking_delta` 事件（不渲染）、不显示 `<div class="think-block">`。
- `roleMode === "tech"`：保留现状。

**工具调用块**（`<ProcessedBlock>` / `ToolStepList`）：
- `roleMode === "daily"`：不渲染 timeline 中 `type=tool_use`/`tool_result` 项的 UI（事件本身仍会通过 SSE 到前端，只是不挂到 timeline state 用于渲染）。
- `roleMode === "tech"`：保留现状。

实现位置：`chat-page.tsx` 在拼 timeline 时根据 `roleMode` 过滤；`chat-message.tsx` 的 think-block 渲染加条件守卫。

### 4.5 切换响应

切换角色模式后保存：
- 当前对话不实时改变（因为历史 timeline 是 persisted 的；下一条用户消息发送时拿到最新 `roleMode`）。
- 新会话 / 新发送的消息 立即生效。

不做 hot reload，简单可靠。

---

## 5. 数据迁移 & 风险

| 风险 | 处理 |
| --- | --- |
| 旧用户库里已有向量数据 | DROP 表 + 删 `models/` 目录；保留 `knowledge_documents` 行，明文镜像在改造前的文档需要"重写一次"——首启动 migration 检查：对每个未找到 `<hash>.txt` 的文档，跑一次 `parseDocument` 重建。 |
| `memory_entries` 旧数据丢失 | 不迁移到 `memory.md`（数据量小、价值有限）；migration 注释里写明。 |
| `models/` 离线包未删除 | 不做强制清理，文档里加一句"可手动删除 models/ 释放 ~30MB"。 |
| `npm install` 后多余依赖 | `package.json` 删 `@xenova/transformers` / `sqlite-vec`；改完 `npm install` 一次。 |
| Tauri 生产包没 `rg` | 在 `prepare-tauri.mjs` 中拷贝 `which rg` 出来的二进制到 `src-tauri/resources/bin/rg`，运行时通过 `process.resourcesPath` 找；开发环境继续走 PATH。本 spec 范围内只在 dev 上跑通，生产打包留 TODO。 |

---

## 6. 测试要点

- `lib/knowledge/rg-search.ts`：mock 子进程，验证 OR 拆分、正则模式、ranges 对齐、命中数排序。
- `/api/knowledge/search` 集成测试：上传一个 `.md`，搜命中关键词，断言响应结构。
- Agent 工具：单测 `search_knowledge` 在无命中时返回固定文案，`grep_docs` 输出行号格式 `file:line:`，`read_file` 截断逻辑。
- Memory：`readMemoryMarkdown` 在文件不存在时返回 `""`，64KB 限流。
- Role mode：单测 `buildStaticPrefix("X","Y","daily")` 包含「回答风格」字段且不含「工作守则」原文。
- 前端：`roleMode="daily"` 时 `<AssistantTurn>` 不渲染 think-block；技术模式渲染。

---

## 7. 实施 checkpoint

1. ☐ 写 spec.md（本文）
2. ☐ 知识库后端：rg-search.ts + 重写 `/api/knowledge/search` + 新增 `documents/[id]/content` + `download` + 重写 `pipeline.ts` 的 `ingestDocument` + migration DROP 表
3. ☐ 删除 embedding / vector-store / retriever / chunker，更新 package.json
4. ☐ 知识库 UI：`app/knowledge/page.tsx` 重写、sessionStorage 跨页传附件、chat-page 挂载读取
5. ☐ 三个新工具 + registry + system-prompt 文案
6. ☐ Memory：file-store.ts，删 store/auto-extractor/MCP 工具，migration DROP
7. ☐ Role mode：settings 字段 + UI radio + prompt 分支 + 前端显隐
8. ☐ 单测跑通 `npm test`

---

完。
