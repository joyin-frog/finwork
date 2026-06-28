# 可观测面板 Spec

> 版本 v1.0 / 2026-06-08
> 依赖：`spec-knowledge-rg-and-role-mode.md`（role_mode 字段、三个新工具名）
> 架构纠偏：本项目 SQLite 走 Node.js `node:sqlite`（非 rusqlite），前后端通信走 fetch→API Route（非 Tauri invoke）

---

## 0. 与提案的差异

| 提案 | 实际 | 原因 |
|-----|------|------|
| rusqlite | 项目零 Rust SQLite，全部 `node:sqlite` DatabaseSync | 架构事实 |
| Tauri commands (`get_traces` 等) | Next.js API routes `/api/observability/*` | 零个 Tauri command，全部 fetch→API |
| 新建 `traces` 表 | 扩展已有 `agent_traces`（13列，含 token 列但未写） | 已有表避免重复 |
| `p99_duration_ms` | 用 avg + max | 单用户量级 p99 无统计意义 |
| 与昨日对比 ↑↓ | 只显示绝对值 | 日请求低，对比噪声大 |
| `filter_tool` API 参数 | 前端客户端过滤 | 工具数少（~10个），服务端过滤过度 |
| Tauri 文件保存对话框 | 浏览器 `download` + `URL.createObjectURL` | 零额外依赖 |

---

## 1. 数据库

### 1.1 扩展 `agent_traces`（`addColumnIfMissing`）

```sql
ALTER TABLE agent_traces ADD COLUMN user_message TEXT;       -- 用户输入截断500字
ALTER TABLE agent_traces ADD COLUMN final_answer TEXT;       -- 回复摘要截断300字
ALTER TABLE agent_traces ADD COLUMN status TEXT DEFAULT 'ok'; -- 'ok' | 'error' | 'slow'
ALTER TABLE agent_traces ADD COLUMN role_mode TEXT;          -- 'daily' | 'tech'
ALTER TABLE agent_traces ADD COLUMN total_cost_usd REAL;     -- SDK total_cost_usd
ALTER TABLE agent_traces ADD COLUMN input_tokens INTEGER;    -- 冗余 SUM(modelUsage.*.inputTokens)
ALTER TABLE agent_traces ADD COLUMN output_tokens INTEGER;
ALTER TABLE agent_traces ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE agent_traces ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE agent_traces ADD COLUMN llm_call_count INTEGER DEFAULT 1;
ALTER TABLE agent_traces ADD COLUMN num_turns INTEGER;       -- SDK num_turns
ALTER TABLE agent_traces ADD COLUMN model_usage_json TEXT;   -- 完整的 modelUsage JSON（调试用）
```

说明：
- `prompt_tokens` / `completion_tokens` / `cache_read_tokens` / `cache_creation_tokens` 已存在但从未写入——改为写入，同时增加 `input_tokens` / `output_tokens` 作为聚合值
- `status` 判定逻辑：有 `error_message` → `'error'`；`total_ms > 5000` → `'slow'`；其他 → `'ok'`
- `llm_call_count` 在一次 `query()` 调用中固定为 1（SDK 内部 tool-use loop 对外透明）
- `total_cost_usd` 从 SDK result message 直接取

### 1.2 新建 `agent_spans`

```sql
CREATE TABLE IF NOT EXISTS agent_spans (
  id TEXT PRIMARY KEY,                -- UUID
  trace_id TEXT NOT NULL,             -- → agent_traces.trace_id
  span_type TEXT NOT NULL,            -- 'memory' | 'llm_call' | 'tool_call' | 'stream' | 'router'
  name TEXT,                          -- 如 'grep_docs'、'Claude #1'、'memory.md'
  started_at INTEGER NOT NULL,        -- Date.now() 毫秒时间戳
  duration_ms INTEGER,
  input_summary TEXT,                 -- 截断200字
  output_summary TEXT,                -- 截断200字
  tokens INTEGER,                     -- 仅 llm_call/memory 有
  error TEXT,                         -- 出错信息
  metadata_json TEXT                  -- 扩展字段（model名、tool参数等）
);
CREATE INDEX IF NOT EXISTS idx_agent_spans_trace ON agent_spans(trace_id);
```

与 `chat_agent_events` 的区别：
- `chat_agent_events` 绑定 `message_id`，存完整 payload，服务 Chat UI timeline 回放
- `agent_spans` 绑定 `trace_id`，存摘要，服务可观测面板性能分析
- 两者不互相替代，trace 写入时**两表各写各的**

### 1.3 已有 `chat_agent_events` 的 tool 事件

不做迁移。`agent_spans` 从本次上线开始记录，历史 tool 数据通过 `chat_agent_events` 直接 SQL 查询（`/api/metrics/tools` 已这样做）。

---

## 2. SDK usage 数据提取

### 2.1 `lib/agent/claude-adapter.ts`

**现有代码（218-220 行）**：
```ts
if (message.type === "result" && message.subtype === "success") {
  result = (message as SDKResultSuccess).result;
}
```

**改为**——从同一个 message 提取 `modelUsage` 和 `total_cost_usd`：

```ts
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

// 在 runClaudeAgent 函数作用域顶部新增变量：
let modelUsage: Record<string, ModelUsage> | undefined;
let totalCostUsd: number | undefined;
let numTurns: number | undefined;

// 在 result 分支：
if (message.type === "result" && message.subtype === "success") {
  const success = message as SDKResultSuccess;
  result = success.result;
  modelUsage = success.modelUsage;
  totalCostUsd = success.total_cost_usd;
  numTurns = success.num_turns;
}
```

**返回值扩展**——`runClaudeAgent` 返回类型从：
```ts
{ mode, claudeSessionId, content, thinking }
```
扩展为：
```ts
{ mode, claudeSessionId, content, thinking, modelUsage, totalCostUsd, numTurns }
```

### 2.2 `app/api/agent/query/route.ts` 的 `writeAgentTrace()`

签名变更：
```ts
function writeAgentTrace(params: {
  traceId: string;
  conversationId?: number;
  startedAt: number;
  modelUsed: string;
  routerPath: string | null;
  errorMessage: string | null;
  userMessage: string;           // 新增
  finalAnswer: string;           // 新增
  roleMode: string;              // 新增
  modelUsage?: Record<string, ModelUsage>;  // 新增
  totalCostUsd?: number;         // 新增
  numTurns?: number;             // 新增
  toolCallCount: number;
})
```

写入时：
- `input_tokens` = `SUM(modelUsage[model].inputTokens)` 遍历所有 model
- `output_tokens` = `SUM(modelUsage[model].outputTokens)` 遍历所有 model
- `cache_read_tokens` = `SUM(cacheReadInputTokens)`, `cache_write_tokens` = `SUM(cacheCreationInputTokens)`
- `model_usage_json` = `JSON.stringify(modelUsage)`
- `prompt_tokens` / `completion_tokens` = 同 `input_tokens` / `output_tokens`（兼容旧 metrics API）
- `status` = `errorMessage ? 'error' : (totalMs > 5000 ? 'slow' : 'ok')`

### 2.3 调用点

`query/route.ts` 中两个 `writeAgentTrace()` 调用点：
- streaming 路径（第 239 行）：目前只传 `toolCallCount: collectedEvents.length`——改为从 `result.modelUsage` 取值
- error 路径（第 245 行）：不加 modelUsage（出错时无数据）
- non-streaming 路径（第 285 行）：同 streaming

额外：`result` 来自 `executeAgentPath()` → `runClaudeAgent()`。在 streaming 路径中 `result` 在 `start()` 闭包内可用；需把 `modelUsage` 等字段解构出来传入 `writeAgentTrace()`。

---

## 3. Span 采集逻辑插入

所有采集用 try/catch 包裹，失败静默忽略。Span 写入函数：

```ts
// lib/observability/spans.ts (新文件)
function writeSpan(span: {
  traceId: string;
  spanType: "memory" | "llm_call" | "tool_call" | "stream" | "router";
  name: string;
  startedAt: number;
  durationMs: number;
  inputSummary?: string;
  outputSummary?: string;
  tokens?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}): void
```

### 3.1 插入节点

| # | 位置 | span_type | 采集内容 |
|---|------|-----------|---------|
| ① | `query/route.ts` 收到请求后 | `router` | `runRouter()` 调用前后计时，name=`"router"`, tokens=0 |
| ② | `claude-adapter.ts` `readMemoryMarkdown()` 后 | `memory` | 计时读文件 + token 估算（`memoryMarkdown.length / 3`），name=文件名 |
| ③ | `claude-adapter.ts` `sdk.query()` 前后 | `llm_call` | 整个 `for await` 循环耗时，name=`"Claude query"`, tokens=从 result 聚合的 inputTokens |
| ④ | `claude-adapter.ts` 每次 `tool_result` 后 | `tool_call` | 已有 `durationMs` 在 `pendingToolCalls` 中计算好了；name=工具名，input/output summary 截断200字 |
| ⑤ | `query/route.ts` SSE done 后 | `stream` | streaming 总耗时（从第一个 enqueue 到 done），在 `createStreamingResponse` 的 `start()` 内测量 |

### 3.2 采集不影响主流程

```ts
// 所有采集点统一模式
try { writeSpan({...}); } catch { /* best-effort */ }
```

采集失败不应阻止 SSE 发送、不应阻止 trace 写入、不应抛到用户。

---

## 4. API Routes

全部在 `/api/observability/` 下。

### 4.1 `GET /api/observability/traces`

Query params:
```
limit: number (default 20)
offset: number (default 0)
```

Response:
```ts
{
  ok: true,
  data: {
    traces: Array<{
      trace_id: string;
      conversation_id: number | null;
      started_at: string;
      total_ms: number;
      status: "ok" | "error" | "slow";
      user_message: string;          // 截断60字给列表
      final_answer: string | null;
      model_used: string;
      router_path: string | null;
      tool_call_count: number;
      input_tokens: number;
      output_tokens: number;
      total_cost_usd: number | null;
      llm_call_count: number;
      num_turns: number | null;
      role_mode: string | null;
      error_message: string | null;
    }>;
    total: number;                   // 7天内总数（分页用）
    hasMore: boolean;
  }
}
```

SQL：
```sql
SELECT trace_id, conversation_id, started_at, total_ms, status,
       user_message, final_answer, model_used, router_path,
       tool_call_count, input_tokens, output_tokens, total_cost_usd,
       llm_call_count, num_turns, role_mode, error_message
FROM agent_traces
WHERE started_at >= datetime('now', '-7 days')
ORDER BY started_at DESC
LIMIT ? OFFSET ?
```

### 4.2 `GET /api/observability/spans?trace_id=xxx`

Response:
```ts
{
  ok: true,
  data: {
    spans: Array<{
      id: string;
      span_type: "memory" | "llm_call" | "tool_call" | "stream" | "router";
      name: string;
      started_at: number;
      duration_ms: number;
      input_summary: string | null;
      output_summary: string | null;
      tokens: number | null;
      error: string | null;
      metadata_json: string | null;
    }>;
  }
}
```

按 `started_at` 升序。

### 4.3 `GET /api/observability/metrics?days=7`

Response:
```ts
{
  ok: true,
  data: {
    total_traces: number;
    avg_duration_ms: number;
    max_duration_ms: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    error_count: number;
    slow_count: number;
    tool_counts: Record<string, number>;  // { "grep_docs": 15, "search_knowledge": 8, ... }
    hourly_latency: Array<{              // 近24小时，整点聚合
      hour: string;                      // "2026-06-08T14:00:00"
      avg_ms: number;
      count: number;
    }>;
  }
}
```

`tool_counts` 聚合自 `agent_spans WHERE span_type='tool_call'`，fallback 查 `chat_agent_events WHERE event_type='tool_result'`。

### 4.4 `GET /api/observability/export`

无参数。固定导出近 7 天全部 trace 的 JSON，含 `model_usage_json` 全字段。

Response: `application/json`，直接浏览器下载。前端用 `<a download>` 触发。

---

## 5. 前端页面

### 5.1 路由与导航

- 路由：`/observability`
- 文件：`app/observability/page.tsx`（客户端组件，需要轮询、筛选、展开等交互）
- 菜单：`app/shared/app-nav.tsx` 在知识库和设置之间插入：

```tsx
<Link className={active === "observability" ? "nav-link active" : "nav-link"}
      href="/observability" data-tooltip="观测">
  <Activity size={18} aria-hidden="true" />
  {collapsed ? null : <span>观测</span>}
</Link>
```

- `app/shared/app-shell.tsx` 的 active 检测增加 `/observability` → `active = "observability"`

### 5.2 组件树

```
app/observability/page.tsx              — 页面容器，持有所有 state
├── ObservabilityToolbar                — 顶栏（页面标题 + 刷新按钮 + 导出按钮）
├── MetricCards                         — 4 卡行
│   └── MetricCard (×4)                 — 单个指标（总对话/平均耗时/Token/错误率）
├── ChartRow                            — 双列图表
│   ├── LatencyLineChart                — 左：按小时折线图
│   └── ToolDonutChart                  — 右：工具调用甜甜圈图 + 图例
├── TraceTable                          — 对话列表表格
│   ├── TraceRow (×N)                   — 单行（问题摘要/状态badge/耗时条/工具标签/Token/时间）
│   └── TraceDetailPanel (展开)         — 详情面板
│       ├── DetailSummary               — 上半：用户问题/回复摘要/角色/Memory token
│       ├── DetailMetrics               — 上半右：耗时/API调用次数/工具详情/总Token
│       └── SpanTimeline                — 下半：步骤耗时时间轴
│           └── SpanBar (×N)            — 单条色块（蓝=LLM/绿=Tool/橙=Memory/粉=Stream）
└── Pagination                          — 分页（每页20条）
```

### 5.3 数据流

```
page.tsx mount
  → fetch /api/observability/metrics?days=7     (一次)
  → fetch /api/observability/traces?limit=20    (初始加载)
  → setInterval 30s 轮询 traces                 (可选，默认手动刷新)

用户点某行 → fetch /api/observability/spans?trace_id=xxx → 展开详情面板
用户点导出 → GET /api/observability/export → blob download
用户点刷新 → 强制 fetch traces + metrics
```

### 5.4 各组件要点

**MetricCards**：纯数字展示，不显示趋势箭头。Token 费用估算用 `totalCostUsd` 字段（SDK 已算好），无此字段时用 `input_tokens * $3/M + output_tokens * $15/M` 估算。

**LatencyLineChart**：用 CSS/SVG 简易折线图（不引入图表库）。X 轴 24 个整点，Y 轴自适应。数据不足 24 个点时留空。

**ToolDonutChart**：CSS conic-gradient 实现。最多显示 Top 5 工具，其余归入「其他」。下方图例显示工具名 + 次数 + 百分比。

**TraceTable**：
- 状态 badge：ok=绿 ✓ / error=红 ✗ / slow=黄 ⚡
- 耗时栏：数字 + 迷你 CSS 进度条（宽度 = total_ms / max_ms_in_page * 100%）
- 工具标签：小圆角 chip 显示前 3 个工具名（从 span 数据来，或 tool_call_count 兜底）
- 慢请求行背景 `rgba(255,200,0,0.06)`

**SpanTimeline**：
- 横向时间轴，每个 span 一行
- 色块宽度与 duration_ms 成正比（相对 trace 内最长 span）
- 色块左侧标 span 名称，右侧标耗时（ms）
- 颜色：`llm_call=#3b82f6`, `tool_call=#22c55e`, `memory=#f97316`, `stream=#ec4899`, `router=#8b5cf6`
- 图例放在时间轴下方

**TraceDetailPanel**：
- 从 `traces` list 的选中行数据渲染上半部分
- 下半部分加载 spans 数据后渲染时间轴
- 关闭按钮 / 点击其他行切换

### 5.5 刷新策略

- 页面挂载：立即 fetch
- 手动刷新按钮：强制 fetch traces + metrics
- 30s 轮询：仅轮询 `/api/observability/traces`（轻量），metrics 不轮询
- 切换到其他 tab 时 `document.visibilitychange` 暂停轮询

---

## 6. 文件变更清单

### 新增文件

| 文件 | 用途 |
|-----|------|
| `lib/observability/spans.ts` | `writeSpan()` + SQLite 写入 |
| `lib/observability/traces.ts` | 扩展 `writeAgentTrace()`，迁移与查询函数 |
| `app/api/observability/traces/route.ts` | GET traces |
| `app/api/observability/spans/route.ts` | GET spans |
| `app/api/observability/metrics/route.ts` | GET metrics |
| `app/api/observability/export/route.ts` | POST export |
| `app/observability/page.tsx` | 页面容器 |
| `app/observability/observability-toolbar.tsx` | 顶栏 |
| `app/observability/metric-cards.tsx` | 指标卡行 |
| `app/observability/latency-chart.tsx` | 折线图 |
| `app/observability/tool-donut.tsx` | 甜甜圈图 |
| `app/observability/trace-table.tsx` | 表格 + 行 |
| `app/observability/trace-detail.tsx` | 详情面板 + SpanTimeline |

### 修改文件

| 文件 | 变更 |
|-----|------|
| `lib/db/sqlite.ts` | `addColumnIfMissing` 扩展 agent_traces；`initializeFinanceDatabase` 建 agent_spans |
| `lib/agent/claude-adapter.ts` | import ModelUsage；提取 modelUsage/totalCostUsd/numTurns；插入 span 采集（memory/llm_call/tool_call）；返回值扩展 |
| `app/api/agent/query/route.ts` | writeAgentTrace 签名改为 params 对象，写新字段；插入 router/stream span 采集 |
| `app/shared/app-nav.tsx` | 插入「观测」菜单项 + Activity icon import |
| `app/shared/app-shell.tsx` | pathname 判断增加 `/observability` |

### 不修改

| 文件 | 原因 |
|-----|------|
| `app/api/metrics/traces/route.ts` | 保留不动（Q2 决策） |
| `app/api/metrics/tools/route.ts` | 保留不动 |
| `lib/agent/mcp-tools/*` | 不相关 |
| `lib/memory/*` | 不相关 |

---

## 7. 验收标准

1. 发一条对话 → `agent_traces` 表出现新记录，`status`/`user_message`/`input_tokens`/`output_tokens`/`total_cost_usd`/`model_usage_json` 均非空
2. `agent_spans` 表出现对应 span 记录（至少 memory + llm_call + stream 各一条，有 tool 调用则更多）
3. `GET /api/observability/traces` 返回分页数据
4. `GET /api/observability/spans?trace_id=xxx` 返回该 trace 的全部 span
5. `GET /api/observability/metrics?days=7` 返回聚合指标 + hourly_latency
6. `GET /api/observability/export` 返回近 7 天 JSON
7. `/observability` 页面渲染指标卡、图表、表格、详情面板
8. 菜单中「观测」出现在知识库和设置之间
9. 采集失败（如 DB 写入抛异常）不影响对话正常返回
10. 旧 `agent_traces` 行（无新字段）在 API 返回中对应字段为 null，UI 优雅处理

---

完。
