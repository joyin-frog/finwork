# audit-confirm-gate-card

> Implementer: claude-sonnet-4-6 / 2026-07-05
> Spec: docs/spec/spec-confirm-gate-card.md v1.0

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `lib/agent/claude-adapter.ts` | 修改 | `AgentQuestion` 加可选 `kind?: "confirm"` |
| `lib/agent/hooks/types.ts` | 修改 | `HookContext.resolveUserQuestion` 入参加可选 `kind?: "confirm"` |
| `lib/agent/hooks/chain.ts` | 修改 | confirm 分支调 `resolveUserQuestion` 时带 `kind:"confirm"` |
| `app/chat/chat-types.ts` | 修改 | `AskUserQuestionPayload` 加可选 `kind?: "confirm" \| "question"` |
| `app/components/ask-user-panel.tsx` | 修改 | 加 `CSSProperties` import；在 ESC effect 后加 `kind==="confirm"` 早返回分支（确认卡，两按钮，无文本框，tone token 告警色） |
| `tests/confirm-gate.test.ts` | 新增 | 纯函数段（G1–G6）+ 源码契约段（U1–U4），导出 `confirmGateTestPromise` |
| `tests/all.test.ts` | 修改 | 末尾追加 `confirmGateTestPromise` 接入 |

超出 Files touched 的文件：**无**。

---

## 成功标准逐条核对

### A. 逻辑（纯函数单测）

- [x] **`kind` 透传**：G1 断言 `received[0].kind === "confirm"`，`received[0].header === "操作确认"`。通过。
- [x] **答案判定不回归**：G2（`"确认"` → allow）、G3（`"取消"` → deny）、G4（空串 → deny）。全部通过。
- [x] **角色无关性证明**：G5 对 `calculate_payroll_batch` 与 `export_kingdee_draft` 各跑一遍，均断言 `kind:"confirm"`，代码中无 `roleId` 分支。通过。

### B. 渲染（源码契约断言）

- [x] **确认卡分支存在且形态正确**：U1（`kind === "confirm"` 分支），U2（两按钮标识），U3（confirm 分支内无 `<textarea>` 无 `InputGroupInput`），U4（`--tone-notice` + `fa-toned`/`fa-tone-pill`）。全部通过。
- [ ] **真机目视**：待人工目视（dev server 需 API key + 触发高风险工具，见下文）。
- [x] **普通提问不回归**：`kind` 缺省时走 `main return`，原有渲染路径完全不变；全套测试 0 回归。

---

## 测试结果

### 新测试单独运行

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/confirm-gate.test.ts
G1: confirm 路径带 kind:"confirm" ✓
G2: 「确认」→ allow ✓
G3: 「取消」→ deny ✓
G4: 空串 → deny ✓
G5: 双角色(薪税+记账)均带 kind:"confirm" ✓
G6: 低风险工具不调 resolveUserQuestion ✓
U1: kind === "confirm" 分支存在 ✓
U2: 两按钮(确认执行/取消)存在 ✓
U3: confirm 分支内无文本输入框 ✓
U4: 颜色走 tone token ✓

confirm-gate: 全部断言通过 ✓
```

### 全套测试

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# tests 9
# suites 0
# pass 9
# fail 0   ← 零回归
# duration_ms ~7600ms
```

注：`reportlab` 异步警告在基线已存在，与本功能无关。

### Typecheck

```
npm run typecheck
(无输出，exit 0)
```

---

## 偏离与原因

1. **`ask-user-panel.tsx` 的 `CSSProperties` import**：组件原先无此 import；confirm 分支用 `style={{ "--tone": ... } as CSSProperties}` 需要它，加一行 import，属 spec 隐含要求，不算超范围。
2. **`ignore()` 函数在 confirm 分支**：confirm 分支使用 `void submit("取消")` 而非 `ignore()`（`ignore()` 提交空串，会被 chain.ts 判 deny，语义相同但语义更清晰，两者均为 deny）。按 spec §5"ESC 语义"已知项，确认卡 ESC 也会等同取消，无需特殊处理。
3. **真机目视**：dev server 需要配置 API key 且需要触发真实 high 工具确认，在 CI/worktree 环境下无法自动完成。audit 中标记为"待人工目视"，不阻塞交付（spec §4 明确"非单测，作为最终交付证据"）。

---

## 遗留 / 风险

- **真机目视未完成**：确认卡的视觉样式（后果告警色、两按钮布局）需人工在 dev server 上触发一次 high 工具确认后目视。实现遵循了 `app/agents/page.tsx` 里 `fa-toned` + `--tone-notice` 的既有模式，风险低。
- **ESC 在 confirm 分支仍触发 `ignore()`（提交空串 → deny）**：符合 spec §5"ESC 在确认卡上结果等同取消"，已知且可接受，无需特殊处理。
- **`answered` 态不区分 confirm**：按 spec §2 注释明确"answered 态优化属非目标，MVP 只做待答浮层"，时间线里已答 confirm 仍走现有紧凑摘要，已记录为后续 polish。
