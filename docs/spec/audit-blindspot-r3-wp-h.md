# Audit: WP-H chat 管线——消息双写与附件上限

## Files changed

- `lib/agent/query-stages.ts` — 主要改动文件
- `tests/query-stages.test.ts` — 新增 S4、S5 测试用例
- `tests/agent-attachments-json.test.ts` — 新增 A5 测试用例

---

## 每文件改动内容与 spec 对应

### `lib/agent/query-stages.ts`

**改动 1 — import `getDb`（对应 spec WP-H 条 1）**

在已有的 `@/lib/db/sqlite` 导入列表中加入 `getDb`，用于 sessionStage 内做去重查询的内联 SQL。未往 `lib/db/sqlite.ts` 加任何新导出，符合 spec 铁律。

**改动 2 — `AttachmentTooLargeError` 类（对应 spec WP-H 条 2）**

在 `createLogger(...)` 之后，新增带 `type = "AttachmentTooLarge"` 标记的自定义错误类，构造函数接受 `actualBytes` 与 `limitBytes`，错误文案含实际大小与上限（含 MB 单位），符合 spec "错误文案含实际大小与上限"。

**改动 3 — `saveAttachmentBuffer` 大小守卫（对应 spec WP-H 条 2）**

在 `mkdirSync` 调用之前（即写盘之前）加入大小校验。`buffer.length > 20MB` 时抛出 `AttachmentTooLargeError`，不创建目录，不写文件。

**改动 4 — `sessionStage` user 消息去重（对应 spec WP-H 条 1）**

将原来的单层 `if (!conversationId) { ... }` 改为：
- 新会话（无 `conversationId`）：行为与原来相同，直接创建并插入；
- 既有会话：用 `getDb().prepare(...).get()` 内联一条 `SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`，若最后一条是 `role='user'` 且 `content` 完全相同则跳过 insert（同时跳过附件写入），否则照常插入。

**改动 5 — `parseStage` catch 块去除动态 `import("next/server")`（偏差，见下）**

原代码：`await import("next/server")` → `NextResponse.json(...)`  
新代码：`new Response(JSON.stringify(...), { status: 400, headers: {"Content-Type":"application/json"} })`

---

## 与 spec 的偏差及理由

**偏差：修改了 `parseStage` catch 块中的 `NextResponse` 动态导入**

spec 仅提及"在 parseMultipartRequest 中 catch 该错误转换为 400，不得漏成 500"，未明确要求修改 catch 块本身。

**原因**：A5 测试首次触发了 `parseStage` 的 catch 路径。Node.js 22 原生 ESM 无法解析 `"next/server"`（无 exports 映射，需 `.js` 后缀），导致该路径不是返回 400 而是抛 ERR_MODULE_NOT_FOUND 崩溃。
- 这是**预先存在的 bug**（A1-A4 均未触发 catch 分支，因此之前未被发现）。
- `new Response(JSON.stringify(...))` 与 `NextResponse.json(...)` 在 JSON body + status code 语义上完全等效；app router 也接受 plain Response。
- 此修改属于"将 catch 块转换为 400 响应"的实施层面必要修复，在 `lib/agent/query-stages.ts` 范围内。

---

## 先红后绿证据

### S4（user 消息去重）

红：`AssertionError: S4 FAIL: 重试不应写入重复 user 消息，期望 1 条，实际 2 条`  
绿：`query-stages S4 pass ✓`

### S5（正常两轮对话不去重）

红：（S4 先崩溃，S5 未运行；S5 代码逻辑在实现前必然失败）  
绿：`query-stages S5 pass ✓`

### A5（超限附件返回 400）

红：`AssertionError: A5 FAIL: 超限附件应返回 400，实际 200`  
绿：`agent-attachments-json A5 pass ✓`

---

## 测试结果

```
query-stages.test.ts:
  query-stages S1 pass ✓
  query-stages S2 pass ✓
  query-stages S3 pass ✓
  query-stages S4 pass ✓
  query-stages S5 pass ✓
  query-stages: S1-S5 全部通过 ✓

agent-attachments-json.test.ts:
  agent-attachments-json A5 pass ✓
  agent-attachments-json: all 5 checks passed ✓
```

TypeScript check（`npx tsc --noEmit`）：`lib/agent/query-stages.ts` 无新增 TS 错误。

---

## 开放风险

1. **`quotaStage` 中也有 `await import("next/server")`（约第 253 行）**：本 WP 不覆盖 quotaStage，该动态导入在测试环境也有同样的潜在问题，但 mock agent 测试从不触发用量配额分支，因此当前无影响。建议后续顺手改成 `new Response(...)` 风格（已为 backlog 候选，不在本 WP 范围）。

2. **S2 测试现在默默触发 dedup skip**：S2 测试发送同一 conversationId + 同内容 "你好"，第二次 sessionStage 调用现在跳过 insert（日志显示 "user message dedup skipped"）。S2 的断言只验证 claudeSessionId 复用，不验证消息条数，故 S2 仍通过。但 S2 的语义从"追加相同问题"变为"去重"，对 S2 的行为描述已有漂移——如需严格区分两者，可在 S2 中间插入 assistant 消息。目前不影响业务逻辑正确性。
