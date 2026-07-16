# Plan 048: withIdempotency 回放失败结果时抛真正的 Error（消灭 "[object Object]"）

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3e6777..HEAD -- lib/agent/tools/idempotency.ts tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3e6777`, 2026-07-15

## Why this matters

`withIdempotency` 把失败结果存成 `{ message }` 纯对象；同 key 重试命中缓存时 `throw cached` 抛出的是这个纯对象。所有调用方的 `error instanceof Error ? error.message : String(error)` 会走到 `String(...)` 分支得到 `"[object Object]"`。例如 `calculate_payroll_batch` 的失败列表（`lib/agent/tools/finance/payroll.ts` 外层 catch）——用户在重试后看到的不是真实错误原因而是乱码，无法诊断。

## Current state

- `lib/agent/tools/idempotency.ts`（全文 59 行）。关键片段（原样摘录）：

```ts
      if (existing) {
        const cached = JSON.parse(existing.result_json);
        if (existing.is_error) throw cached;          // ← 27–28 行：抛纯对象
        return cached;
      }
...
    } catch (error) {
      isError = true;
      result = error instanceof Error ? { message: error.message } : error;   // ← 41 行：存 {message}
      throw error;
    }
```

- 调用方模式（勿改）：`lib/agent/tools/finance/payroll.ts` 等用 `error instanceof Error ? error.message : String(error)`。
- 既有测试：`grep -rn "idempotency\|withIdempotency" tests/` 找到现有用例位置与写法，仿照。

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| 单测      | `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` | `# fail 0` |

## Scope

**In scope**:
- `lib/agent/tools/idempotency.ts`
- 对应测试文件（按 grep 找到的既有 idempotency 测试所在文件追加）

**Out of scope**:
- `tool_executions` 表结构与已存数据（旧数据仍是 `{message}` JSON，修复必须兼容读取它）。
- 各工具 handler 的 catch 写法。

## Git workflow

- Branch: `advisor/048-idempotency-error-replay`
- Commit：`fix(agent): 幂等回放失败时抛 Error 而非纯对象`
- 不 push、不开 PR。

## Steps

### Step 1: 回放分支重建 Error

把 27–29 行改为：

```ts
      if (existing) {
        const cached = JSON.parse(existing.result_json);
        if (existing.is_error) {
          const message = cached && typeof cached === "object" && typeof cached.message === "string"
            ? cached.message
            : String(cached);
          throw new Error(message);
        }
        return cached;
      }
```

（兼容旧行存的任意形状；不改写库侧 41 行——`{message}` 存储形状保持不变，旧数据可读。）

**Verify**: `npm run typecheck` → exit 0

### Step 2: 回归测试

在既有 idempotency 测试处加一例：包一个必 throw `new Error("boom")` 的 handler，带 `idempotency_key` 调两次；断言第二次（回放）抛出的值 `instanceof Error === true` 且 `message === "boom"`。

**Verify**: `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` → `# fail 0`，新用例 pass

## Test plan

见 Step 2；模式仿照该测试文件中现有的「同 key 二次调用命中缓存」用例。

## Done criteria

- [ ] 回放失败路径 `throw` 的是 `Error` 实例（新测试断言）
- [ ] 旧格式 `result_json`（`{"message":"..."}`）回放不崩（Step 1 的兼容分支覆盖）
- [ ] typecheck / 单测全绿；`git status` 无 scope 外改动；`plans/README.md` 已更新

## STOP conditions

- 现有代码与摘录不符（漂移）。
- 发现有调用方**依赖**回放抛纯对象的行为（grep `is_error` / 相关 catch 确认）——报告后停。

## Maintenance notes

- 若将来想保留原始错误的结构化字段（code/cause），应扩展存储形状并同步这里的重建逻辑；本计划刻意只修「Error 实例」这一层。
- Reviewer 看点：写侧未动、读侧对非对象/缺 message 的旧数据不抛二次异常。
