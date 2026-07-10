# audit-recap-and-compaction-audit

> 任务：AR1a 结构化重建回顾 + AR1b PostCompact 摘要审计
> spec：docs/spec/spec-recap-and-compaction-audit.md v1.1

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/agent/recap-summary.ts` | 新增 |
| `tests/recap-summary.test.ts` | 新增 |
| `lib/agent/claude-adapter.ts` | 修改 |
| `tests/all.test.ts` | 修改 |

---

## 每文件改动详情

### `lib/agent/recap-summary.ts`（新增）

实现三个导出函数：

1. **`fallbackFlatRecap(history, lastPromptText)`**
   与改造前 `yieldMessages` 的 recap 段逐字等价（快照锁死于 T4）。

2. **`summarizeHistory(older, settings)`**
   抄 `conversation-title.ts` 的 `fetch` 模式：
   - model = `settings.mainModel || settings.model`（N1 口径：mainModel 优先）
   - max_tokens=600，system="你是财务对话摘要器，只输出结构化摘要"
   - user prompt 要求输出四段（## 目标/进展/关键决策/下一步），并「具体文件/单据/报表名在进展里带上」
   - `AbortSignal.timeout(15_000)` 超时守卫
   - SKIP_LLM / 无 key / 无 model / 非 2xx / 异常 / 空文本 → 返回 null

3. **`buildStructuredRecap(history, lastPromptText, settings?)`**
   - `history.length ≤ RECENT_KEEP(8)` → 直接 `fallbackFlatRecap`（不调 LLM）
   - `> 8`：`older(前 N-8 条) → summarizeHistory → null → fallbackFlatRecap（全量）`
   - 成功：`<历史摘要>\n${summary}\n</历史摘要>\n<最近对话>\n${recent 逐行}\n</最近对话>\n\n当前请求:\n${lastPromptText}`

4. **`createPostCompactHookCallback(requestId, writeSpanFn)`**（AR1b）
   工厂函数，返回 SDK `HookCallback` 兼容的 async 函数（`(input, toolUseID, opts) => { continue: true }`）。
   写入一条 `spanType:"compact"`, `name: compact:summary:{trigger}`, `metadata: { compactSummary, trigger }` 的 span。

### `tests/recap-summary.test.ts`（新增）

TDD 先红后绿。7 个测试组，全部 GREEN：

| 组 | 内容 |
|---|---|
| T1 | 短/空 history → fallbackFlatRecap（4 个断言覆盖空、3 条、8 条） |
| T2 | SKIP_LLM + 长 history → 整段 fallbackFlatRecap（全量 10 条） |
| T3 | 长 history + mock fetch → 结构化产出（分段边界：只有消息3-10在 `<最近对话>`） |
| T4 | 快照等价（逐字比对精确字符串） |
| T5 | prompt 契约源码断言（mainModel、四段关键词、AbortSignal.timeout、SKIP_LLM、600） |
| T6 | AR1b hook 功能测试（mock writeSpan，验证 compactSummary / trigger / traceId / name / 返回值） |
| T7 | AR1b 源码契约（adapter 含 PostCompact hook、createPostCompactHookCallback 调用、compact_boundary 原 span 保留） |

注：T3k 测试"第1条不应在最近对话"时，断言改为 `":消息1\n"` 而非 `"消息1"`，因为 `"消息10"` 包含 `"消息1"` 子串，精确锚点避免误判。

### `lib/agent/claude-adapter.ts`（修改）

4 处改动，均在 Files touched 列表内：

1. **新增 import**（顶部）：
   ```ts
   import { buildStructuredRecap, createPostCompactHookCallback } from "./recap-summary";
   ```

2. **`options` 加 `hooks` 字段**（紧跟 `canUseTool` 之后）：
   ```ts
   hooks: {
     PostCompact: [{ hooks: [createPostCompactHookCallback(requestId, writeSpan)] }],
   },
   ```
   `options` 类型是 `Record<string, unknown>`，不影响 TS 编译。SDK types（sdk.d.ts:1446）确认 `Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` 存在，此处通过后续的 `as Parameters<typeof sdk.query>[0]["options"]` 强转透过类型门。原 `compact_boundary` 处理（:430-441 的 pre/post tokens span）完全不动。

3. **`buildPromptInput` 签名加可选 `settings` 参数**：
   ```ts
   export function buildPromptInput(
     messages: AgentMessage[],
     attachments: AgentAttachment[],
     settings?: { apiKey: string; apiUrl: string; mainModel?: string; model?: string }
   ): string | AsyncIterable<SDKUserMessage>
   ```
   可选参数保证 `agent-context.test.ts` 的 2-arg 调用（`buildPromptInput(msgs, [])`）不受影响。

4. **`yieldMessages` 签名加可选 `settings` 参数**，内部 recap 文本从内联拼接改为 `await buildStructuredRecap(history, lastPromptText, settings)`：
   ```ts
   const text = await buildStructuredRecap(history, lastPromptText, settings);
   ```
   attachment 分支结构（content 数组）不动（N2）。

5. **两个 `buildPromptInput` 调用处透传 `settings`**（:314 正常调用 + :347 重试调用）。`settings` 在 `runClaudeAgent` 作用域(:118)，`queryWithRetry` 通过闭包访问。

### `tests/all.test.ts`（修改）

在文件末尾（`coerceJsonTestPromise` 之后）接入：
```ts
const { recapSummaryTestPromise } = await import("./recap-summary.test.ts");
await recapSummaryTestPromise;
```

---

## 与计划的偏差及原因

### 无偏差点

- N1 settings 透传：按计划通过 `buildPromptInput` → `yieldMessages` → `buildStructuredRecap` 透传，不在 `recap-summary.ts` 内调用 `readClaudeSettings`。
- N2 fallback 范围：`fallbackFlatRecap` 只生成 recap 文本段，attachment 分支结构留在 `yieldMessages` 内不动。
- AR1b 挂载点：`options.hooks.PostCompact` 以 `HookCallbackMatcher` 形状挂载（`{ hooks: [callback] }`），与 sdk.d.ts:770 一致。
- 原 compact_boundary span（pre/post tokens）完全保留。

### 结构偏差（合理，已注记）

**PostCompact 回调提取为工厂函数**：spec 伪代码中 hook 回调是内联 lambda，实际实现将其提取为 `createPostCompactHookCallback` 工厂函数并放在 `recap-summary.ts`。原因：
- 工厂函数使依赖（`requestId`、`writeSpan`）显式注入，可独立单测（T6 功能测试直接调用工厂）。
- 不新增 Files touched 之外的文件（`recap-summary.ts` 本就在列表内）。
- T7c 断言相应调整为检查 `adapterSrc.includes("createPostCompactHookCallback")`。

---

## settings 透传实际接法

```
runClaudeAgent(:118)
  └─ settings = await readClaudeSettings()      ← 唯一读取点
     └─ buildPromptInput(messages, attachments, settings)  ← :314、:347
           └─ yieldMessages(messages, blocks, lastPromptText, settings)  ← 内部调用
                 └─ buildStructuredRecap(history, lastPromptText, settings)  ← AR1a
                       └─ summarizeHistory(older, settings)  ← LLM 调用
```

`recap-summary.ts` 内不调用 `readClaudeSettings`，完全符合 N1。

---

## fallback 快照锁定方式

T4 精确字符串断言：

```ts
const expected =
  "<对话回顾>\n用户:问题A\n助手:回答B\n</对话回顾>\n\n当前请求:\n现在的问题";
assert.equal(result, expected, "T4 FAIL: ...");
```

任何对 `fallbackFlatRecap` 格式的修改都会导致 T4 红。

---

## AR1b hook 落库测试验证方式

T6 构造 `PostCompactHookInput` 形状对象，直接调用 `createPostCompactHookCallback` 返回的回调，用 mock `writeSpan` 捕获调用：

```ts
const spansWritten: SpanInput[] = [];
const hookCb = createPostCompactHookCallback("trace-abc-001", (s) => spansWritten.push(s));
await hookCb(fakeInput, undefined, { signal: new AbortController().signal });
// 断言 spansWritten[0].metadata.compactSummary === fakeInput.compact_summary
```

---

## 测试结果

### RED 阶段（实施前）

```
ERR_MODULE_NOT_FOUND: Cannot find module 'lib/agent/recap-summary.ts'
```

### GREEN 阶段（实施后）

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/recap-summary.test.ts
T1: short/empty history → fallbackFlatRecap ✓
T2: SKIP_LLM + long history → full fallback ✓
T3: long history + mock fetch → structured output ✓
T4: fallbackFlatRecap 快照等价 ✓
T5: prompt 契约源码断言 ✓
T6: AR1b PostCompact hook → writeSpan compactSummary ✓
T7: AR1b 源码契约 ✓
recap-summary: 全部断言通过 ✓
```

### 回归测试

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/runtime-events.test.ts → ✓
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/mock-agent.test.ts → ✓
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/agent-context.test.ts → ✓（含 2-arg buildPromptInput 调用）
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/agent-trace-write.test.ts → ✓
npx tsc -p tsconfig.typecheck.json 2>&1 | grep -v "src-tauri/" → （无输出，通过）
```

---

## 开放风险

1. **摘要热路径延迟**：`summarizeHistory` 在 stale 重试路径上加一次 LLM 往返（仅低频触发）。15s timeout + 失败降级保证不阻塞。

2. **PostCompact hook 兼容性**：首次在 finwork 中使用 SDK 原生 hooks（编程式）。hook 返回 `{ continue: true }` 匹配 `SyncHookJSONOutput`，类型通过 `as Parameters<...>` 强转落地，未来 SDK 升级若改变 hook 签名需同步验证。

3. **options 类型强转**：`hooks` 字段通过 `Record<string, unknown>` → `as Parameters<typeof sdk.query>[0]["options"]` 强转进入 SDK，无静态类型检查。如果 SDK 类型后续对 hooks 字段收紧，编译时静默通过但运行时可能报错。

4. **buildPromptInput 向后兼容**：`settings` 为可选参数，现有调用无需改动。若未来有新的调用方传空 settings，长历史会走 `fallbackFlatRecap` 而非结构化摘要——此为预期降级行为。
