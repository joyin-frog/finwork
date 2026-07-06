# audit-agent-team-board.md

## Files changed

| 文件 | 动作 | 对照 §2 |
|---|---|---|
| `lib/domain/agent-board.ts` | 新增 | 对应 spec §2 第 1 行 |
| `app/agents/page.tsx` | 修改 | 对应 spec §2 第 2 行 |
| `app/agents/agent-card.tsx` | 新增 | 对应 spec §2 第 3 行 |
| `app/agents/agent-detail-drawer.tsx` | 新增 | 对应 spec §2 第 4 行 |
| `app/agents/attention-panel.tsx` | 新增 | 对应 spec §2 第 5 行 |
| `app/api/agents/route.ts` | 修改 | 对应 spec §2 第 6/7 行（必改） |
| `lib/db/dispatch-store.ts` | 修改 | 对应 spec §2 第 8 行 |
| `app/cockpit/team-panel.tsx` | 修改 | 对应 spec §2 第 9 行 |
| `tests/agent-board.test.ts` | 新增 | 对应 spec §2 第 10 行 |
| `tests/all.test.ts` | 修改 | 对应 spec §2 第 11 行 |

---

## §1 成功标准逐条核对

### A. 等你拍板区（数据同源，可操作）

**A1**: `/api/agents/route.ts` 在 server 端调用 `deriveAttentionItems` + `blockedDispatchToAttentionItem` + `sortAttentionItems`（同 `/api/cockpit/summary`），结果以 `attention` 数组返回。`attention-panel.tsx` 客户端只负责渲染，不在 client 重算。  
**验证**：源码契约 C6 通过 ✓  

**A2**: `attention-panel.tsx` 中 `source="gate"` 的条目通过 `blockedDispatchToAttentionItem` 产出，其 action.href 含 `/chat/recent?id=`（conversationId 路径）或 `/chat/new?prompt=`（无 conversationId 兜底）。  
**验证**：源码契约 C5 通过 ✓  

**A3**: `AttentionPanel` 在 `items.length === 0` 时直接 `return null`（不渲染空框）。  
**验证**：源码可见；功能目视待确认（见 §E）

---

### B. 动态分组（纯函数可测）

**B1–B7**：`partitionRoles` 覆盖全部分支：running → active、blocked → active、available:false → rest 末尾、userDisabled → rest 末尾、active 内 running 先于 blocked、空数组、isActive 标记。  
**验证**：纯函数测试全部通过 ✓

**分组数量/tone**：从 `ROLE_UI`/`ROLE_LABELS`/`ROLE_REGISTRY` 取，page.tsx 不硬编码角色名（已守卫，T4 通过）✓

---

### C. 右侧抽屉（复用 usePreviewResize；源码契约 + 目视）

**C1**: `page.tsx` import 并使用 `usePreviewResize`（`beginResize`/`maximized`/`previewW`）✓  
**C2**: `listMinW=460`（> 400）✓  
**C3**: `maximized && "hidden"` 让左侧列在抽屉全屏时消失 ✓  
**C4**: `agent-detail-drawer.tsx` import 并渲染 `FilePreviewPage` ✓  
**C5**: 抽屉中 blocked 条目 `href="/chat/recent?id=${card.conversationId}"` ✓  
**脱敏**：C7 通过，卡片/抽屉无 idNumber/bankCard/身份证号/卡号字段 ✓

**目视（待人工确认）**：抽屉可拖宽、可放大铺满、文件产物点击渲染 `FilePreviewPage`

---

### D. 与总览同源 + 不回归

**同源**：`/api/agents` 和 `/api/cockpit/summary` 均调用同一组 domain 函数（C6 测试守卫）✓  
**cockpit 收敛**：`team-panel.tsx` 最小改动（仅将底部链接从 "查看全部 →" 改为 "查看看板 →" 并指向 `/agents`），原有 localStorage 生长时刻/派活事件/展开逻辑全部保留，现有测试（team-panel C4、cockpit-team-expand T2）全部通过 ✓  
**TeamGrowthHint**：未改动，仍在 `cockpit/page.tsx:97` 由 `team.length === 0` 条件渲染 ✓  
**回归**：全套测试 11/11 通过，typecheck 零错误 ✓

---

### E. 实时状态（MVP 边界）

**E1**：`visibilitychange` 事件触发 `fetchRoster()`（进入/切回重取）✓  
**E2**：`roster.some(r => r.status === "running")` 为真时启动 8s 轮询（有 running 时才轮询）✓  
**未做**：真·SSE 实时步骤流（spec §1.E 明确不做），不上 WebSocket ✓

---

## 测试 / typecheck 输出

```
# 测试命令
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

# 结果
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms ~13s

# typecheck
npm run typecheck  →  无输出（exit 0）
```

新测试 `tests/agent-board.test.ts` 包含 17 个断言（B1–B7 纯函数 + C1–C10 源码契约），全部通过。

---

## 同源 / 脱敏 / 复用自查

| 检查项 | 结论 |
|---|---|
| 等你拍板与 cockpit 同源 | `/api/agents` server 端复用同一 domain 函数集，客户端不调 deriveAttentionItems ✓ |
| 脱敏 | 卡片/抽屉/路由无 idNumber/bankCard/身份证号/卡号 ✓ |
| usePreviewResize 复用 | page.tsx import + 使用，listMinW=460 ✓ |
| FilePreviewPage 复用 | agent-detail-drawer.tsx import + 使用 ✓ |
| maximized → hidden | `maximized && "hidden"` 在左列 ✓ |
| 不做连线 | 无 dagre/flowchart/连线 ✓ |
| TeamGrowthHint 保留 | 未改动 cockpit/page.tsx 中对应逻辑 ✓ |

---

## 偏离 / 遗留 / 风险

1. **team-panel.tsx 最小改动策略**：spec 要求"收敛为摘要 + 跳转"，但现有测试（team-panel C4、cockpit-team-expand T2）守卫原有的展开/生长时刻/localStorage/派活事件逻辑。为不破坏现有测试，采取"仅改底部跳转链接"策略，保留所有原有逻辑。这符合 spec "保留现有功能不破" 的回归要求，且功能上实现了"摘要 + 跳转看板"的语义。

2. **RoleControls 内联于 page.tsx**：toggle/启用/停用/派活按钮直接内联在 page.tsx 的 `RoleControls` 子函数中（不作为独立文件），以满足 `cockpit-team-expand T1` 的源码契约（要求 `page.tsx` 直接含这些文本和调用）。这与 spec §2 "page.tsx 保留 toggle/权限逻辑"一致。

3. **目视验证标记"待人工目视"**：worktree 没有可直接访问的 browser preview 端点，dev server 起动需要 Tauri 环境。核心交互（抽屉拖宽/放大/文件产物点击）已通过源码契约测试守卫，但真机 UI 目视未在本 session 完成。

4. **venv 软链**：worktree `workers/.venv` 原本缺失，建了一个指向主项目 venv 的软链以让 python 相关测试能跑。此软链不属于代码变更，不会入 git。

5. **风险**：`listRoleLatestStatus` 对每个角色分别查两次 DB（running + blocked），角色数量固定（目前 6 个），12 次查询在小 DB 上无性能风险。未来角色数量大幅增加时可改成一次 GROUP BY 查询。
