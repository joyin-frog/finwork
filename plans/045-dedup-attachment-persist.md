# Plan 045: 用户消息去重命中时新附件仍要落库（修复附件静默丢失）

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- lib/agent/query-stages.ts tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

用户在同一会话里重发同样文字但带新文件（典型场景：上次发错文件，改一份重传，消息文字没改），`sessionStage` 的用户消息去重会命中 `skipInsert`，把整个「插消息 + 插附件」事务跳过。但文件在更早的 `parseStage` 已经写进磁盘并喂给了 agent。结果：该附件在会话历史里永远不可见、后续回合无法 @ 引用，且成为 DB 里无记录的孤儿文件——按 DB 记录做清理的保留期任务永远收不到它。

## Current state

- `lib/agent/query-stages.ts` — agent 请求的分阶段处理。`parseStage` 内 `saveAttachmentBuffer`（约 336–345 行）把上传文件写盘；`sessionStage`（约 150–191 行）负责插消息与附件。
- 去重与跳过逻辑（`lib/agent/query-stages.ts:162-190`，原样摘录）：

```ts
    } else {
      // 去重：若会话最后一条是同内容的 user 消息，跳过 insert（重试场景防双写）
      const lastMsg = getDb()
        .prepare("SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
        .get(conversationId) as { role: string; content: string } | undefined;
      if (lastMsg && lastMsg.role === "user" && lastMsg.content === lastUserContent) {
        log.info("user message dedup skipped", { traceId, conversationId });
        skipInsert = true;
      }
    }
    if (!skipInsert) {
      const db = getDb();
      db.exec("BEGIN");
      try {
        const messageId = insertChatMessage(conversationId, "user", lastUserContent);
        for (const att of attachments) {
          if (att.storagePath && conversationId) {
            insertChatAttachment({
              id: randomUUID(), messageId,
              fileName: att.name, mimeType: att.mimeType, sizeBytes: att.size,
              storagePath: path.relative(getConversationFilesDir(conversationId), att.storagePath), role: "user"
            });
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
    }
```

- 相关表结构（`lib/db/schema.ts:61`）：`chat_attachments(id TEXT PK, message_id, file_name, mime_type, size_bytes, storage_path, role, created_at)`，`message_id` 外键指向 `chat_messages(id)`。
- 已有 DB 帮助函数（`lib/db/sqlite.ts:561` 起）：`insertChatAttachment(...)`、`getMessageAttachments(messageId)`。
- 约定：多写操作用 `BEGIN`/`COMMIT` + `ROLLBACK`（如上摘录）；`node:sqlite` 同步单线程，只需关心崩溃原子性。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Lint      | `npm run lint`           | 0 error（既有 warning 允许） |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0`（若 smoke/skill 的 python 用例因本机缺 Python 依赖失败，与本计划无关，报告即可） |

## Scope

**In scope** (the only files you should modify):
- `lib/agent/query-stages.ts`
- `tests/all.test.ts`（或按现有测试组织新增一个被 all.test.ts 引入的测试文件——先看 `tests/` 现状，跟随现有模式）

**Out of scope** (do NOT touch, even though they look related):
- 去重判定本身（`lastMsg.content === lastUserContent` 的条件不改——它防的是网络重试双写，是既定行为）。
- `parseStage` 的文件落盘逻辑与 `saveAttachmentBuffer`。
- 前端任何文件。

## Git workflow

- Branch: `advisor/045-dedup-attachment-persist`
- Commit style 参照 git log：`fix(agent): 用户消息去重命中时新附件仍落库`
- 不 push、不开 PR，除非操作者另行指示。

## Steps

### Step 1: 去重 SELECT 带出消息 id

把去重查询改为 `SELECT id, role, content FROM chat_messages ...`，类型断言相应加 `id: number`。命中去重时把该 id 存入局部变量（如 `dedupMessageId`）。

**Verify**: `npm run typecheck` → exit 0

### Step 2: skipInsert 分支补插新附件

在 `if (!skipInsert) { ... }` 之后新增分支：当 `skipInsert === true` 且 `attachments` 里存在 `att.storagePath` 的条目时：

1. 用 `getMessageAttachments(dedupMessageId)` 取该消息已有附件；
2. 对每个待插附件，若已有附件中存在 `fileName === att.name && sizeBytes === att.size` 的记录则跳过（真·重试场景防双插）；
3. 其余的用与现有代码相同的 `insertChatAttachment({...})` 形状插入（`messageId` 用 `dedupMessageId`，`storagePath` 同样走 `path.relative(getConversationFilesDir(conversationId), att.storagePath)`）；
4. 多条插入包在 `db.exec("BEGIN")` / `COMMIT` / 失败 `ROLLBACK` 中，模式照抄上方摘录。
5. 打一行日志：`log.info("dedup hit, attached new files to existing message", { traceId, conversationId, count })`。

注意 `getMessageAttachments` 需要从 `@/lib/db/sqlite` 导入（该文件已从此模块导入多个函数，追加即可）。

**Verify**: `npm run typecheck && npm run lint` → 0 error

### Step 3: 加回归测试

在现有单测套件里新增用例（跟随 `tests/all.test.ts` 中已有的 DB 相关测试的组织方式）：

- 用例 A（本 bug）：建会话 → 插入 user 消息 X → 模拟 sessionStage 场景：同文本 X + 一个新附件（fileName/size 与已有不同）走一遍 sessionStage（或直接调用其导出的阶段函数——若 sessionStage 不便直测，把 Step 2 的「补插」逻辑抽成可测的导出函数 `attachFilesToMessage(...)` 再测它）→ 断言 `getMessageAttachments(id)` 含新附件。
- 用例 B（防双插）：同一附件（同名同大小）重复走一遍 → 断言附件数不变。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`，新增 2 用例 pass

## Test plan

见 Step 3。结构参照 `tests/all.test.ts` 内既有的 sqlite 集成用例（内存/临时 appdata 目录初始化方式跟随现状）。

## Done criteria

- [ ] `npm run typecheck` exit 0
- [ ] `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` `# fail 0`，含 2 个新用例
- [ ] skipInsert 命中 + 新附件场景：`chat_attachments` 有记录（用例 A 断言）
- [ ] 同附件重试不产生重复行（用例 B 断言）
- [ ] `git status` 无 scope 外文件改动
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

Stop and report back (do not improvise) if:

- `query-stages.ts` 的去重/插入代码与上方摘录不符（已漂移）。
- 发现 `attachments` 在 sessionStage 到达时 `storagePath` 为空（说明落盘时机与本计划假设不符）。
- 测试需要触碰 `app/api/agent/query/route.ts` 或 mock SDK 链路才能写——那超出范围，报告替代方案（抽函数直测）后停。

## Maintenance notes

- 将来若把「消息双写」防护从内容比对改成客户端幂等键，此补插分支要一并迁移。
- Reviewer 重点看：真重复（同文本同附件）重试时是否零新增行；`path.relative` 的根目录与现有插入分支一致。
