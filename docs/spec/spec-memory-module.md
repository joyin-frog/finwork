# Spec: 长期记忆模块（Phase 4）

> 状态：待实现
> 日期：2026-06-06
> 范围：Tool-based 长期记忆，按需检索，SQLite 存储

---

## 1. 背景与目标

当前 Agent 在新会话中没有用户上下文，每次都要重新告知偏好、画像、历史事实。Phase 3 的 RAG 已覆盖"公司事实"（制度、合同、规范），但用户个人状态没有持久化。

**职责分工**：

| 模块 | 职责 | 检索方式 | 体量 |
|------|------|---------|------|
| RAG 知识库 | 公司事实（制度、合同、规范） | 向量语义检索 | 大语料库 |
| 长期记忆 | 用户偏好 + 历史事实 | SQL 关键词 + 全量注入 | 小（< 数百条） |

**核心原则**：
- Tool-based：Claude 显式调用 `save_memory`/`recall_memory`/`forget_memory`
- 用户不可见：无管理 UI，全部由 Agent 维护
- 单用户起步，预留 `user_id` 字段
- 按需检索 fact，preference 全量注入（避免 system prompt 膨胀）

---

## 2. 数据模型

### 2.1 SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL DEFAULT 'default-user',
  type         TEXT    NOT NULL CHECK (type IN ('preference','fact')),
  key          TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  summary      TEXT,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, type, key)
);
CREATE INDEX IF NOT EXISTS idx_memory_user_type ON memory_entries(user_id, type);
CREATE INDEX IF NOT EXISTS idx_memory_user_updated ON memory_entries(user_id, updated_at DESC);
```

### 2.2 字段语义

| 字段 | 用途 |
|------|------|
| `user_id` | 多用户预留，当前固定 `'default-user'` |
| `type` | `preference` = 偏好/画像（全量注入）；`fact` = 历史事实（按需检索） |
| `key` | 语义键，去重锚点。例：`偏好-输出风格`、`画像-公司`、`历史-2026-05报销` |
| `content` | 完整 Markdown 内容 |
| `summary` | Claude 提取时给的一句话摘要。`fact` 必填（用于索引列表）；`preference` 可空 |
| `hit_count` | `recall_memory` 命中累加，用于排序 |
| `last_used_at` | 最近一次被命中的时间 |

### 2.3 去重策略

复合唯一约束 `UNIQUE(user_id, type, key)` + UPSERT：
- 同 key 重复保存 → 覆盖 `content`/`summary`、刷新 `updated_at`、**保留** `hit_count`/`last_used_at`
- 不同 key 但语义相近 → 由 Claude 自己判断，工具不做语义去重

---

## 3. 工具接口

### 3.1 save_memory

```ts
save_memory(args: {
  type: 'preference' | 'fact';
  key: string;              // 1-100 字符
  content: string;          // 1-2000 字符
  summary?: string;         // type='fact' 时必填，<=200 字符
}): string                  // "已保存：<type>/<key>"
```

行为：
1. `type='fact'` 且未传 `summary` → 报错返回提示
2. `INSERT INTO memory_entries ... ON CONFLICT(user_id,type,key) DO UPDATE SET content=excluded.content, summary=excluded.summary, updated_at=CURRENT_TIMESTAMP`
3. 返回简短确认字符串

### 3.2 recall_memory

```ts
recall_memory(args: {
  query?: string;           // 关键词，空 = 列出最近 N 条 fact
  limit?: number;           // 默认 5，最大 20
}): string                  // 命中的 fact 列表（key + content）
```

行为：
1. **只查 fact 类**（preference 已全量注入 system prompt，不需要 recall）
2. `query` 非空 → `WHERE user_id=? AND type='fact' AND (key LIKE ? OR content LIKE ? OR summary LIKE ?)`
3. `query` 为空 → `WHERE user_id=? AND type='fact'`，按 `updated_at DESC`
4. 命中后 `hit_count = hit_count + 1`, `last_used_at = CURRENT_TIMESTAMP`
5. 排序：`ORDER BY hit_count DESC, updated_at DESC LIMIT ?`
6. 返回格式：
   ```
   找到 N 条相关记忆：
   【<key>】（命中 H 次，最近 <date>）
   <content>
   ---
   ```
7. 命中 0 条 → 返回"未找到相关历史事实"

### 3.3 forget_memory

```ts
forget_memory(args: {
  type: 'preference' | 'fact';
  key: string;
}): string                  // "已删除" / "未找到"
```

行为：`DELETE FROM memory_entries WHERE user_id=? AND type=? AND key=?`，返回受影响行数提示。

---

## 4. System Prompt 注入

在 `buildFinanceSystemPrompt` 内追加 **记忆段落**，从数据库实时拉取：

```
## 用户长期记忆

### 偏好与画像（已加载，可直接使用）
- 偏好-输出风格：简洁、不要 emoji
- 画像-角色：财务专员
- 画像-公司：XX 科技
...
（来源：SELECT key, content FROM memory_entries WHERE user_id=? AND type='preference' ORDER BY updated_at DESC）

### 历史事实索引（如需详细内容请调用 recall_memory(query=...) 工具）
- 历史-2026-05报销：差旅 1200 元，已审批
- 基线-工资基数：月薪 20000
...
（来源：SELECT key, summary FROM memory_entries WHERE user_id=? AND type='fact' ORDER BY updated_at DESC LIMIT 20）
```

两个段落均为空时 → 整段不注入（避免空标题）。

### 4.1 注入时机

- `runClaudeAgent` 入口处读取一次（不在每个 turn 重读）
- 单用户固定 `user_id='default-user'`

### 4.2 引导语

system prompt 末尾追加一句：
> 用户的偏好和画像已加载在"用户长期记忆"段落，需要查询历史事实时调用 recall_memory；发现用户表达了稳定偏好或重要事实时主动调用 save_memory 保存。

---

## 5. 代码结构

```
lib/memory/
  types.ts                  ← MemoryType, MemoryEntry
  store.ts                  ← MemoryStore（CRUD + 排序/筛选）
lib/agent/mcp-tools/
  memory.ts                 ← save_memory / recall_memory / forget_memory 三个工具
lib/db/sqlite.ts            ← 追加 memory_entries 表 + DAO 函数
lib/agent/tools/registry.ts ← 注册三个 MCP 工具名
lib/agent/claude-adapter.ts ← buildFinanceSystemPrompt 注入记忆段落
docs/spec-memory-module.md  ← 本文件
tests/memory.test.ts        ← 单测
tests/all.test.ts           ← 引入 memory.test.ts
```

### 5.1 lib/memory/types.ts

```ts
export type MemoryType = 'preference' | 'fact';

export interface MemoryEntry {
  id: number;
  userId: string;
  type: MemoryType;
  key: string;
  content: string;
  summary: string | null;
  hitCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_USER_ID = 'default-user';
```

### 5.2 lib/memory/store.ts

```ts
export class MemoryStore {
  constructor(private readonly db = initializeFinanceDatabase()) {}

  save(input: { userId?: string; type: MemoryType; key: string; content: string; summary?: string }): void;
  recall(input: { userId?: string; query?: string; limit?: number }): MemoryEntry[];
  forget(input: { userId?: string; type: MemoryType; key: string }): boolean;
  listPreferences(userId?: string): MemoryEntry[];
  listFactIndex(userId?: string, limit?: number): MemoryEntry[];
}
```

### 5.3 工具命名

注册到 `TOOL_REGISTRY`：

```ts
{ name: "mcp__finance_worker__save_memory",   category: "finance", riskLevel: "safe" },
{ name: "mcp__finance_worker__recall_memory", category: "finance", riskLevel: "safe" },
{ name: "mcp__finance_worker__forget_memory", category: "finance", riskLevel: "medium" },
```

加入 `BASE_TOOLS`（所有 skill 默认可用）：

```ts
export const BASE_TOOLS = [
  "Read", "Glob", "Grep", "AskUserQuestion",
  "mcp__finance_worker__save_memory",
  "mcp__finance_worker__recall_memory",
  "mcp__finance_worker__forget_memory",
];
```

---

## 6. 执行步骤

按顺序执行，每步执行完即可验证：

### Step 1：DB Schema + DAO

文件：`lib/db/sqlite.ts`

- 在 `initializeFinanceDatabase` 的 `db.exec(...)` 中追加 `memory_entries` 表 + 两个索引
- 新增 DAO 函数（使用 BEGIN/COMMIT/ROLLBACK 模式，**不使用** `db.transaction()`）：
  - `upsertMemoryEntry({ userId, type, key, content, summary }, db?)`
  - `searchMemoryFacts({ userId, query, limit }, db?): MemoryEntryRow[]`
  - `incrementMemoryHit(id, db?)`
  - `deleteMemoryEntry({ userId, type, key }, db?): number`
  - `listMemoryByType(userId, type, limit?, db?): MemoryEntryRow[]`

**验证**：smoke test 新建 `memory_entries` 表能成功，UNIQUE 约束生效（同 key 重复 INSERT OR REPLACE 不报错）

### Step 2：MemoryStore 封装

文件：`lib/memory/types.ts`、`lib/memory/store.ts`

- 把 DAO 函数封装成类方法
- 处理 `userId` 缺省值
- Row → MemoryEntry 映射

**验证**：单测 `tests/memory.test.ts` 覆盖：
- save 两次同 key → 第二次覆盖 content，hit_count 保留为 0
- save fact 不传 summary → 工具层会拦截（store 层允许 null，但工具层校验）
- recall 关键词命中 → hit_count++、last_used_at 更新
- recall 命中后再次 recall → 排序按 hit_count DESC
- forget 删除存在的 entry → 返回 true；删除不存在 → 返回 false
- listPreferences / listFactIndex 排序正确

### Step 3：MCP 工具

文件：`lib/agent/mcp-tools/memory.ts`

- 仿 `knowledge.ts` 模式，三个工具：`save_memory`、`recall_memory`、`forget_memory`
- 工具描述用中文，明确告诉 Claude 何时调用
- `save_memory` 内校验：`type='fact'` 且无 `summary` → 返回错误字符串

文件：`lib/agent/mcp-tools/index.ts`
- 在 `tools: [...]` 中追加 `createMemoryTools(sdk, zodTyped)` 返回的三个工具

**验证**：MCP server 创建后包含三个新工具

### Step 4：工具注册表 + 默认权限

文件：`lib/agent/tools/registry.ts`

- 在 `TOOL_REGISTRY` 追加三条
- `BASE_TOOLS` 追加 save/recall/forget 三个工具

**验证**：`resolveAllowedTools([])` 返回的列表包含三个 memory 工具

### Step 5：System Prompt 注入

文件：`lib/agent/claude-adapter.ts`

- 修改 `buildFinanceSystemPrompt`：接收可选的 `memorySnapshot` 参数
- 在 `runClaudeAgent` 中调用 `new MemoryStore().listPreferences()` 和 `listFactIndex(undefined, 20)`，构造 snapshot 传入
- `buildFinanceSystemPrompt` 内：
  - preferences + factIndex 都为空 → 不注入记忆段落
  - 否则按 §4 格式输出

**验证**：手动构造 DB 数据，调用 `buildFinanceSystemPrompt` 检查输出包含正确段落

### Step 6：测试

文件：`tests/memory.test.ts`

覆盖：
1. **DB schema 自动创建**：`initializeFinanceDatabase(:memory:)` 后 `memory_entries` 表存在
2. **upsert 去重**：连续 save 同 (type, key) 两次 → 表中仅 1 行，content 是最新
3. **hit_count 保留**：第一次 save → recall 命中 → 再次 save 同 key → hit_count 仍为 1
4. **recall 关键词命中**：save 三条 fact，recall query 命中其中一条
5. **recall 空 query 列最近**：返回按 updated_at DESC
6. **recall 排序**：先 hit_count DESC 再 updated_at DESC
7. **recall 限定 type=fact**：preference 类型的 entry 不会被 recall 返回
8. **forget**：删除存在的返回 true，删不存在返回 false
9. **listPreferences/listFactIndex**：分别只返回对应 type
10. **System prompt 注入**：MemoryStore 有数据 → `buildFinanceSystemPrompt` 输出含"## 用户长期记忆"；无数据 → 不含此段
11. **MCP 工具 schema**：save_memory 缺 summary 且 type=fact → 返回错误字符串
12. **MCP 工具调用**：直接 mock sdk.tool，触发 handler 走完 save → recall → forget 流程

文件：`tests/all.test.ts`
- 末尾 `import "./memory.test.ts";`

**验证**：`npm test` 全绿

### Step 7：人工 smoke（可选）

启动 dev server，对话中说"我喜欢简洁回复"→ 观察 Agent 是否调用 save_memory；新开会话验证 preference 已加载。

---

## 7. 验收目标

✅ 全部满足才算完成：

1. **schema 落地**：`memory_entries` 表 + 索引存在；`UNIQUE(user_id, type, key)` 生效
2. **三个 MCP 工具注册**：`mcp__finance_worker__save_memory|recall_memory|forget_memory` 在 `TOOL_REGISTRY` 和 `BASE_TOOLS` 中
3. **去重正确**：同 key 重复保存覆盖 content，不重复插入，hit_count 保留
4. **recall 行为正确**：
   - 只返回 fact 类
   - 关键词在 key/content/summary 任一命中即返回
   - 命中后 hit_count++
   - 排序优先 hit_count，其次 updated_at
5. **system prompt 注入**：
   - preference 全量注入（key + content）
   - fact 注入索引列表（key + summary，最近 20 条）
   - 两者都空时不注入记忆段落
6. **TypeScript 编译零错误**：`npx tsc --noEmit`
7. **测试全绿**：`npm test`（包含新的 memory.test.ts 和原有所有 smoke 测试）
8. **不破坏现有功能**：原 smoke test 仍通过

---

## 8. 非目标（明确不做）

- ❌ 管理 UI（用户不可见）
- ❌ 向量检索（用 SQL LIKE 足够）
- ❌ 自动衰减/清理（先观察使用量，后续按需加 cron）
- ❌ 多用户切换（仅预留 user_id 字段，默认 'default-user'）
- ❌ 记忆冲突合并（同 key 直接覆盖，不做语义合并）
- ❌ importance 字段（已删除，过度设计）
- ❌ profile 类型（合并入 preference）

---

## 9. 与现有架构的集成点

| 现有模块 | 改动 |
|---------|------|
| `lib/db/sqlite.ts` | +memory_entries 表 +5 个 DAO |
| `lib/agent/mcp-tools/index.ts` | +createMemoryTools 注册 |
| `lib/agent/tools/registry.ts` | +3 工具元数据 +3 BASE_TOOLS |
| `lib/agent/claude-adapter.ts` | runClaudeAgent 内拉取 memorySnapshot；buildFinanceSystemPrompt 注入 |
| `tests/all.test.ts` | +import memory.test.ts |
