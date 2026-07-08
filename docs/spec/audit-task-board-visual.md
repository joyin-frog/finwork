# audit-task-board-visual

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/db/migrations.ts` | 修改 — 追加 v16 `dispatch-files` 迁移（带表存在性守卫） |
| `tests/fixtures/golden-schema.json` | 修改 — subagent_dispatches 增 files 列条目（cid=17） |
| `lib/db/dispatch-store.ts` | 修改 — RecordDispatchStartInput 增 files、parseFiles 工具函数、INSERT/DispatchRow/三处 SELECT 均更新 |
| `lib/agent/subagent-runner.ts` | 修改 — recordDispatchStart 调用透传 files: task.files |
| `lib/domain/task-board.ts` | 修改 — TaskBoardCard 增 fileNames、cards 映射补派生逻辑 |
| `app/agents/task-board.tsx` | 修改 — 响应式网格、块状卡片重构、两个批跑深链 |
| `tests/subagent-dispatches.test.ts` | 修改 — 追加 T12-T15（v16 列存在、写读回环、无 files→[]、坏 JSON→[]） |
| `tests/task-board.test.ts` | 修改 — makeRow 补 files: []、追加 TB14 fileNames 派生、SC5 批跑 prompt 关键词 |

---

## 各文件更改内容

### lib/db/migrations.ts
追加 `{ version: 16, name: "dispatch-files" }`：用表存在性守卫（与 v15 同模式）+ `addColumnIfMissing(db, "subagent_dispatches", "files", "TEXT")`。

### tests/fixtures/golden-schema.json
subagent_dispatches 列数组末尾追加 `{ cid: 17, name: "files", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }`。

### lib/db/dispatch-store.ts
- 新增 `files?: string[]` 字段于 `RecordDispatchStartInput`
- 新增 `parseFiles(raw: string | null): string[]` 工具函数（JSON.parse，非数组或异常回退 []）
- INSERT 语句加 `files` 列，值 = `input.files && input.files.length > 0 ? JSON.stringify(input.files) : null`
- `DispatchRow` 增 `files: string[]`
- `getDispatchById`：SELECT 加 `files`，内联 cast 加 `files: string | null`，映射加 `files: parseFiles(row.files)`
- `listDispatchesByRole`：SELECT 加 `files`，cast 加 `files: string | null`，映射加 `parseFiles`
- `listDispatchesForPeriod`：同上

### lib/agent/subagent-runner.ts
`recordDispatchStart` 调用加 `files: task.files`（119-127 行区域）。

### lib/domain/task-board.ts
- `TaskBoardCard` 增 `fileNames: string[]`
- cards 映射加 `fileNames: row.files.map((p) => p.split(/[/\\]/).pop() ?? p)`
  - 注：正则 `/[/\\]/` 与 spec 的 `/[\\/]/` 语义等价（都匹配正斜杠和反斜杠）

### app/agents/task-board.tsx
- 新增 `relativeTime()` 工具函数（相对时间展示）
- `DispatchCard` 重构为块状卡（Surface shape="card"，flex-col gap-2）：
  - 顶行：StatePill + 相对时间（右侧）+ locked 锁图标
  - 主体：objectLabel（font-semibold）+ summary（2 行截断，CSS `-webkit-line-clamp`）
  - blocked 卡：Surface 加 `relative overflow-hidden`；`<span className="fa-tone-edge">` 左色条；blockedReason 红字（`color: var(--tone-alarm)`）
  - fileNames：非空时渲染，最多 3 个 + "+N"；空时不渲染
  - `/chat/recent?id=` 深链保留（SC2 契约）
- `BoardNode` cards 区改响应式网格：`className="grid gap-3"` + `style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}`
- `BoardNode` 接受 `period` prop；bank-recon 节点（`node.templateId === "bank-recon"` 识别）在标题行右侧加「批量对账 →」次级深链
- `TaskBoardView` 头部增主按钮「批量复核申报前 →」（`.fa-toned` + `--tone-neutral`，右对齐）；prompt 含"申报前复核批量"关键词（SC5 契约）

### tests/subagent-dispatches.test.ts
追加 T12-T15：
- T12：v16 列存在 + 旧行 files = NULL
- T13：files 写读回环
- T14：无 files（undefined/空数组）→ 读出 []
- T15：手工塞坏 JSON → 读出 [] 不抛
最终 log 更新为 `all T1–T15 ✓`

### tests/task-board.test.ts
- `makeRow` 增 `files?: string[]` 覆盖字段，默认值 `[]`
- 追加 TB14：fileNames 派生（含绝对路径/Windows 路径两种分隔符）
- 追加 SC5：task-board.tsx 含"申报前复核批量"与"批量对一遍"两个关键词
- 最终 log 更新为 `all TB1–TB14 + SC1–SC5 ✓`

---

## 与计划的偏差

**无实质偏差。** 以下为细节级说明：

1. **正则写法**：spec 写 `p.split(/[\\/]/).pop()`，实际写 `p.split(/[/\\]/).pop()`——两者语义等价，均匹配 `/` 和 `\`。
2. **网格最小宽**：spec 允许 240-280 区间由 implementer 按观感微调，最终取 `240px`（spec 说明的下界）。
3. **主按钮样式**：仓库无独立主按钮组件，使用 `.fa-toned` + `--tone-neutral` + `font-medium px-3 py-1 rounded-md`，符合 spec §3 步骤 5 中"用 token 组合做加重变体即可"的指导。
4. **Surface overflow**：blocked 卡 Surface 加了 `overflow-hidden` 以防止 `.fa-tone-edge`（绝对定位左色条）视觉溢出，spec 只要求 `relative`，加 `overflow-hidden` 是合理的防御性补充，不改变功能语义。
5. **pre-existing tsc 错误**：`npx tsc --noEmit` 有大量 `tests/` 目录下预存错误（TS5097/.ts 扩展名问题、TS2775 等），这些错误本改动前已存在、非本刀引入。`app/` 和 `lib/` 源码零错误（`grep "^app/\|^lib/"` 输出为空）。

---

## 测试结果

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
→ 全部 11 suites pass，0 fail

FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/subagent-dispatches.test.ts
→ T1–T15 全部 ✓，exit 0

FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/task-board.test.ts
→ TB1–TB14 + SC1–SC5 全部 ✓，exit 0

npx tsc --noEmit
→ app/ 和 lib/ 源码零错误；tests/ 预存错误非本刀引入
```

---

## 开放风险

1. **files 含用户文件名（可能敏感）**：只落本地 SQLite、只在本机 UI 展示，不外发。与附件本身同一信任域，可接受；日志/遥测不携带（本改动不触遥测）。
2. **网格 minmax(240px, 1fr)**：真机单列窄屏（< 240px 可用宽度）下网格不换行而是压缩，由浏览器 minmax 语义决定。可接受，属正常响应式行为。
3. **批跑按钮预填文案**：是给主对话 LLM 的指令语，措辞需能稳定命中对应批跑工具（description 已写分流）；若真机发现命中不稳，属 prompt 调优后续，不阻塞本刀。
4. **真机 preview 截图验证**（亮/暗截图、网格换行、深链 href）由 orchestrator 在实施审查通过后执行，implementer 未起 dev server。

---

## 真机验证与审查后修复（orchestrator 注，2026-07-08）

实施审查裁决 ship 后，orchestrator 按 spec §1 执行真机 preview 验证（亮/暗两主题、临时插入 6 条 [UI验证] 派发行照全五态后精确删除），确认：网格布局、状态徽章、blocked 左色条、🔒 锁定卡、文件名列表、两个批跑深链（href 解码正确）、暗色 token 自动适配全部符合预期。

真机照出三个交付面缺陷，orchestrator 直接修复（超出 spec Files touched 的范围外文件已列明）：

1. **blockedReason 红字暴露机器工具名**（如 `export_kingdee_draft`，AI 术语对财务说话反模式）——task-board.tsx 红字改为固定人话"高风险动作已拦截，等你在对话里拍板"。
2. **task-board.tsx 内联了重复的 relativeTime**——共享工具 lib/utils/relative-time.ts 已存在（且历史上就因"四处内联阈值不一致"修过一次）；删本地实现改 import 共享版。
3. **共享 relativeTime 的 UTC 时区 bug（既有，全产品相对时间偏 8 小时）**：SQLite `datetime('now')` 输出无时区标记的 UTC 串被 `new Date()` 按本地解析。修复：`lib/utils/relative-time.ts` 新增 `parseDbTimestamp`（命中 `YYYY-MM-DD HH:MM:SS` 格式补 Z 按 UTC 解析，其它输入原样）；新增 `tests/relative-time.test.ts`（RT1-RT3）并注册进 all.test.ts。此为范围外既有 bug 顺手修复——它直接扭曲本刀交付的卡片时间显示，且改动一处使团队卡/抽屉/cockpit 同步受益。

修复后复验：npm test 全绿（exit 0），relative-time / task-board 单跑 exit 0，tsc 源码零错误，真机红字与时间显示均正确。
