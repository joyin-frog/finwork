# Spec：Feature Flag 接线

**版本**: v1.0
**日期**: 2026-06-07
**前提**: `lib/runtime/flags.ts` 已定义 7 个 flags + `initFlags()`/`isEnabled()`；启动注入由 `instrumentation.ts` 的 `register()` 完成
**原则**: 所有 flag 默认 `true`，接线后行为不变；仅增加运行时关闭能力

---

## WP1：启动时从 DB 加载 flags

### 改法

`lib/db/sqlite.ts` 新增 `readFeatureFlags()`：

```ts
export function readFeatureFlags(): Record<string, boolean> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'flag:%'").all() as Array<{key: string, value: string}>;
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    const flagName = row.key.replace("flag:", "");
    flags[flagName] = row.value === "true";
  }
  return flags;
}
```

`lib/runtime/flags.ts` 新增 `initFlags()` — 合并 DB overrides + 默认值：

```ts
export function initFlags(dbOverrides?: Record<string, boolean>): void {
  _flags = { ...DEFAULTS, ...dbOverrides };
}
```

`app/layout.tsx` 服务端启动时调用一次：
```ts
const flagOverrides = readFeatureFlags();
initFlags(flagOverrides);
```

---

## WP2：接线 8 个 always-on flags

每个 flag 在决策点加 `isEnabled()` 守卫，默认 true 不走 else 分支。

| # | Flag | 文件:行 | 改法 |
|---|---|---|---|
| 1 | `PROMPT_CACHE_ENABLED` | `lib/agent/claude-adapter.ts:203` | 包裹 `buildSystemPromptParts()` 调用，false 时传单段 prompt |
| 2 | `ROUTER_ENABLED` | `app/api/agent/query/route.ts:102` | `if (isEnabled("ROUTER_ENABLED") && lastUserContent)` |
| 3 | `RAG_HYBRID_ENABLED` | _(feature not implemented — wiring blocked on the feature; the cited file/line does not exist)_ | — |
| 4 | `RAG_RERANK_ENABLED` | _(feature not implemented — wiring blocked on the feature; the cited file/line does not exist)_ | — |
| 5 | `RAG_AUTO_INJECT_ENABLED` | _(feature not implemented — wiring blocked on the feature; the cited file/line does not exist)_ | — |
| 6 | `MEMORY_AUTO_EXTRACT_ENABLED` | _(feature not implemented — wiring blocked on the feature; the cited file/line does not exist)_ | — |
| 7 | `MEMORY_SEMANTIC_RECALL_ENABLED` | _(feature not implemented — wiring blocked on the feature; the cited file/line does not exist)_ | — |
| 8 | `SESSION_LIVENESS_CHECK_ENABLED` | `app/api/agent/query/route.ts:84` | `if (isEnabled("SESSION_LIVENESS_CHECK_ENABLED") && stale)` |

### 不改

- Flag 8 (`TOOL_IDEMPOTENCY_ENABLED`): `withIdempotency` 包装器已有但从未被调用。接线需要改所有 MCP tool handler 注册点——属于独立 spec，不在此次范围。
- Flag 9 (`SDK_RETRY_ENABLED`): `withRetry` 包装器已有，agent adapter 有内联 retry 但未用此包装器。同上，独立 spec。

---

## WP3：测试

### `tests/feature-flags.test.ts`

```ts
// 1. DEFAULTS 全为 true
// 2. initFlags({ ROUTER_ENABLED: false }) 后 isEnabled("ROUTER_ENABLED") → false
// 3. 未初始化时 isEnabled("UNKNOWN") → false
// 4. readFeatureFlags 读空 DB → {}
// 5. readFeatureFlags 读 flag:ROUTER_ENABLED=false → { ROUTER_ENABLED: false }
// 6. initFlags 合并：DB 覆盖 + 未覆盖项走默认
// 7. ROUTER_ENABLED=false 时 runRouter 跳过，直接走 agent
```

### 不改

不测 flag 8/9（未接线），不测 e2e（flag 组合爆炸）。

---

## 执行

| 步骤 | 内容 | 估时 |
|---|---|---|
| 1 | `readFeatureFlags()` + `initFlags()` | 15 min |
| 2 | WP2 接线 8 个 flag | 30 min |
| 3 | WP3 测试 | 30 min |
| 4 | `npx tsc --noEmit` + `npx vitest run` 验证 | 10 min |

总计 ~1.5h
