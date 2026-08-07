# audit-artifact-checklist.md — WP14a 可勾选清单工件垂直切片

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/db/migrations.ts` | 修改：追加 v10 artifacts 迁移，LATEST_VERSION 升至 10 |
| `lib/db/artifact-store.ts` | 新建：DAL（createArtifact / getArtifact / patchArtifactState） |
| `lib/agent/mcp-tools/emit-checklist.ts` | 新建：createEmitChecklistTool 工厂 |
| `lib/agent/mcp-tools/index.ts` | 修改：注册 emit_checklist 工具 |
| `lib/agent/tools/registry.ts` | 修改：添加 emit_checklist 条目（safe） |
| `lib/agent/tools/renderers.ts` | 修改：添加 emit_checklist 摘要函数 |
| `app/api/artifacts/[id]/route.ts` | 新建：GET/PATCH 路由，附 handleGet/handlePatch 可注入函数 |
| `app/components/checklist-card.tsx` | 新建：ChecklistCard "use client" 组件 + parseChecklistStructured |
| `app/components/tool-cards.tsx` | 修改：kind 优先 dispatch + TOOLS_WITH_RESULT_CARD 追加 emit_checklist |
| `tests/artifact-checklist.test.ts` | 新建：7 项测试（A1-A7） |
| `tests/tool-registry.test.ts` | 修改：镜像补全 diff_payroll_period + emit_checklist |
| `tests/fixtures/golden-schema.json` | 修改：添加 artifacts 表、索引及列定义 |
| `tests/all.test.ts` | 修改：末尾追加 artifactChecklistTestPromise |
| `agent-skills/skills/filing-precheck/SKILL.md` | 修改：添加"输出段——清单物化（WP14a）"节 |
| `agent-skills/skills/receivables-ledger/SKILL.md` | 修改：添加"输出段——逾期清单物化（WP14a）"节 |

---

## 逐文件变更说明

### lib/db/migrations.ts
追加 version=10 迁移（`artifacts` 表 + `idx_artifacts_conversation_id` 索引）。ON DELETE CASCADE 保证对话删除时工件级联删除。LATEST_VERSION 由 9 升至 10。无其他改动。

### lib/db/artifact-store.ts（新建）
实现三个导出函数：
- `createArtifact`：生成 UUID，将 items 序列化为 JSON，插入 artifacts 行，返回 id
- `getArtifact`：按 id 查询，返回含反序列化 payload 的 Artifact 对象或 null
- `patchArtifactState`：按 itemId 验证（必须存在于 payload.items）、验证 state 枚举（open/done/ignored），UPDATE state JSON，返回 true；无效入参抛 Error

### lib/agent/mcp-tools/emit-checklist.ts（新建）
MCP 工具工厂。schema 接受 title（string）和 items（array，max 50）。超限（>50）直接 throw。调用 createArtifact 后在 structuredContent 返回 `{kind:'artifact_checklist', artifactId, title, items}`。生产环境 lazy getDb()；测试通过 dbOverride 注入。

### lib/agent/mcp-tools/index.ts
在 `createFinanceMcpServer` 工具数组末尾追加 `createEmitChecklistTool(sdk, undefined, conversationId)`。

### lib/agent/tools/registry.ts
添加一条：`{ name: "emit_checklist", category: "finance", riskLevel: "safe" }`

### lib/agent/tools/renderers.ts
在 `finalize_deliverable` 前插入 `emit_checklist` 渲染函数，格式：`物化清单「{title}」({n} 项)`。

### app/api/artifacts/[id]/route.ts（新建）
导出 `handleGet(db, id)` 和 `handlePatch(db, id, body)`（可注入，供测试直接调用），以及 Next.js `GET`/`PATCH` 入口（内部调用 getDb()）。PATCH 校验 itemId 存在性与 state 枚举；400 返回中文错误消息。

### app/components/checklist-card.tsx（新建）
"use client"。
- `parseChecklistStructured`：类型守卫，验证 kind/artifactId/title/items 结构
- `ChecklistCard`：挂载时 GET 路由拉取持久态；404 降级为只读 + "工件已删除，无法操作"灰文；toggle 三态循环（open→done→ignored→open）含乐观更新、submitting 禁用、失败回滚 + toast.error；底部固定免责声明

### app/components/tool-cards.tsx
1. 在工具名 switch 之前添加 kind 优先 dispatch：`structured?.kind === 'artifact_checklist'` → `ChecklistCard`
2. `TOOLS_WITH_RESULT_CARD` 追加 `"emit_checklist"`
3. 导入 `ChecklistCard, parseChecklistStructured`

### tests/artifact-checklist.test.ts（新建）
7 项检查（全部通过）：
- A1：v10 DDL 列形状
- A2：ON DELETE CASCADE 行为（插入对话+工件，删除对话，确认工件消失）
- A3：DAL 正常路径 + 异常路径（非法 itemId / 非法 state）
- A4：emit_checklist 创建工件 + structuredContent 结构 + >50 项拒绝
- A5：handleGet 200/404、handlePatch 200/400（中文错误）
- A6：parseChecklistStructured 合法/非法输入
- A7：emit_checklist 登记在 TOOL_REGISTRY + hasToolSummary

### tests/tool-registry.test.ts
TOOLS_WITH_RESULT_CARD 镜像补全：
- `diff_payroll_period`：之前 tool-cards.tsx 中已存在但镜像漏列（漂移），spec 要求顺带对齐
- `emit_checklist`：WP14a 新增

### tests/fixtures/golden-schema.json
添加 `artifacts` 表（tables 数组按字母序插入 app_settings 之后）、`idx_artifacts_conversation_id` 索引及其 indexDetails 条目、完整 8 列列定义（cid 0-7）。

### tests/all.test.ts
仅在末尾追加（WP10a 的 queryStagesTestPromise 之后）：
```
const { artifactChecklistTestPromise } = await import("./artifact-checklist.test.ts");
await artifactChecklistTestPromise;
```

### agent-skills/skills/filing-precheck/SKILL.md
在"执行约束"节前插入"输出段——清单物化（WP14a）"节：指令文本引导 Agent 在 ⚠️/❓ 项存在时调用 emit_checklist，title 格式 `申报前置检查「{month}」`，severity 映射 warn/error。

### agent-skills/skills/receivables-ledger/SKILL.md
在"执行约束"节前插入"输出段——逾期清单物化（WP14a）"节：在第三步生成催款清单草稿后调用 emit_checklist，title 格式 `逾期催款清单 [YYYY-MM-DD]`，severity 统一 warn，仅列逾期项。

---

## 与计划的偏差

### 偏差 1：route.ts 导出 handleGet/handlePatch
**计划描述**：测试应通过 mock NextRequest 调用 Next.js GET/PATCH 入口。
**实际做法**：导出 `handleGet(db, id)` 和 `handlePatch(db, id, body)` 可注入函数，测试直接调用，不经 NextRequest。
**原因**：GET/PATCH 入口内部调用 `getDb()`，返回文件级单例，与测试的内存 db 不同。没有 mock 基础设施的情况下无法注入。可注入函数是等价测试覆盖且更干净的设计；Next.js 入口薄薄封装，本身无需额外测试。

### 偏差 2：eslint-disable 内联化
**计划**未提及 eslint 细节。实现中两处 `// eslint-disable-next-line` 被折叠为同行内联 `// eslint-disable-line`，原因是 lint 报告 "unused disable directive"（规则已被 lint 配置降级，next-line 指令因对应行不触发规则而被视为无效）。结果等价，lint 零 error。

### 偏差 3：all.test.ts 追加位置
**计划**：追加在文件末尾。
**实际**：WP10a 并行代理已在末尾追加 queryStagesTestPromise，本任务追加在其后，仍符合"仅追加末尾"约定。

---

## 测试结果

### 单项运行（tests/artifact-checklist.test.ts）
```
artifact-checklist: all 7 checks passed ✓
```

### 全套（npm test）
全套受 `.venv` 缺失影响（workers python 路径不存在于本 worktree），smoke.test.ts 抛 ENOENT；这是 worktree 环境预存问题，与本次改动无关。smoke 测试在主项目目录（/Users/gyro/codex/finance-agent-public）可正常通过。artifact-checklist.test.ts 在全套之前已独立验证 7/7 通过。

### typecheck
```
TYPECHECK_EXIT=0
```

### lint
```
CHECKS_EXIT=0（无 error，仅 warning）
```

---

## 开放风险

1. **toast 依赖**：`ChecklistCard` 调用 `toast.error()`，假设项目已全局挂载 react-hot-toast 或 sonner provider。若某些页面未包含 provider，toast 调用静默失败。现有代码库其他卡片组件同样使用 toast，风险与现状一致。

2. **并发 PATCH 竞态**：多标签同时 toggle 同一 itemId 时后者覆盖前者，无乐观锁。当前使用场景（单用户单对话）可接受；多用户协作场景需加版本字段（超出本 WP 范围）。

3. **artifacts 表无软删除**：对话删除时 CASCADE 硬删工件，历史消息中的 ChecklistCard 将 404 降级为只读。这是 spec 的设计意图（"404 降级"），但若日后需要对话归档（软删）则需调整 CASCADE 策略。

4. **emit_checklist conversationId 传递**：`createFinanceMcpServer` 调用时传入 `conversationId`，该值来自调用方路由上下文。若路由未正确提供 conversationId，工件的 `conversation_id` 为 null，不影响功能但无法级联删除。已在 schema 中允许 NULL，设计上可接受。

---

## 实施审查裁定记录（orchestrator，2026-07-07）

裁决 fix first 的唯一阻塞 B1（tool-cards.tsx 三项"越界"）**撤销**：orchestrator 以 `git diff HEAD -- app/components/tool-cards.tsx` 实证本任务对该文件的真实改动仅 +12/−2（import/白名单条目/artifact_checklist 判别分支，全部在 spec 范围内）；reviewer 所指的三卡 Surface 收敛（WP8b，f8d5025 已提交）与 calc_receipt 分支（WP4a，38e3e99 已提交）均在 HEAD 基线内——本轮改造第五次跨任务归属误判。
非阻塞处置：N3 冗余动态 import 已由 orchestrator 改静态（typecheck+全量复验绿）；N1 乐观更新偏差被 reviewer 评为"功能上更优"接受；N2 golden 括号外观差异（守卫不断言该字段）、N5 Surface 缺省 props（与同文件 WP8b 风格一致）、N6 conversationId 类型转换（既有惯例）记录在案。另：implementer 漏带 venv 跑全量的验证缺口由 orchestrator 补跑（EXIT=0）。

**最终裁决：ship。**
