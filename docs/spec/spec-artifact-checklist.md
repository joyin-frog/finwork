# 交互工件系统·第一刀（WP14a：可勾选清单工件的垂直切片）Spec

> 版本 v1.2 / 2026-07-07（v1.0 fix first → v1.1 修订 → 限定复审**批准**）
> 状态：**已实施并通过审查（ship）**。实施审查唯一阻塞系跨任务 diff 归属误判（git diff 实证撤销）；乐观更新偏差被评为功能更优接受；N3 冗余 import 已修。
> 依赖：WP1（事实层/迁移纪律）、WP8a（Surface）、WP9a（chat 组件树）、WP4a（structured kind 判别先例）——全部已ship。迁移版本 v10（当前 LATEST=9）。
> 架构事实（2026-07-07 scout 核实）：工具结果双轨渲染——流式 `AgentRunEvent.tool_result.structured` 进 timeline（tool-call-step.tsx:467,477）；历史重放读 `chat_agent_events.payload` 原文反序列化（chat-types.ts:122-126），**事件表 INSERT-only 无 UPDATE 先例，工件状态强行改 payload 会破坏事件溯源——新表是必要路径**。卡片全部纯展示零 useState，唯一交互先例 AskUserCard（submitted/submitting 状态 + POST /api/agent/answer 内存 Promise 通道，不写 DB）。filing-precheck 与 receivables-ledger 的清单是**模型写的 markdown 正文**（非 structured、不走卡片）——工件化必须给 agent 物化工具；`finalize_deliverable` 是文件清理钩子（finalize-deliverable.ts，写 .finalized.json 标记）不适配，需新工具。卡片分发 tool-cards.tsx:32 按裸名 switch + kind 判别优先（WP4a）；新增卡片参照 tests/finance-cards.test.ts 模板。哨兵：golden-schema（新表须同步）、tool-registry 的 TOOLS_WITH_RESULT_CARD 白名单（新卡片须扩）、retention.test.ts（事件级联删除——artifacts 是否随会话删除需定义）。schema.ts 已冻结，DDL 走 migrations v10。

## 0. 目标与非目标

**目标**：交付物从"一段输出"变"有生命周期的对象"的第一个垂直切片：① `artifacts` 表（v10）；② `emit_checklist` 工具（agent 把清单物化为工件，返回 structured 渲染成卡片）；③ `ChecklistCard`（可勾选：每项 待办/已处理/忽略 三态，历史会话重开状态保真）；④ `GET/PATCH /api/artifacts/[id]`；⑤ filing-precheck 与 receivables-ledger 的输出指示接入（⚠️/❓ 项与催款项经工具物化；markdown 正文保留——工件是操作层，不替代阅读层）。

**非目标**：凭证草稿行内改科目（WP14b，编辑型工件复杂度高一档）；工件状态回写事实层（勾选"已处理"不改 fact_* ——那是核销类业务动作，须走各自业务链路，本刀只记录处理进度）；工件列表页/跨会话工件检索（等使用反馈）；乐观更新（无先例，v1 用 AskUserCard 的 submitting 等待模式）；除 checklist 外的工件 kind。

## 1. 成功标准（先红后绿）

- [ ] **v10 `artifacts`**：`id TEXT PK(uuid) · kind TEXT NOT NULL('checklist') · conversation_id INTEGER NULL · title TEXT NOT NULL · payload TEXT NOT NULL(JSON items:[{id,label,detail?,severity?('warn'/'info')}]) · state TEXT NOT NULL DEFAULT '{}'(JSON {itemId:'open'/'done'/'ignored'}) · created_at · updated_at`；索引 conversation_id；**`FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE`（reviewer B2 裁定：清单工件是会话内进度记录，会话删则工件删孤儿不留；conversation_id NULL 行不受级联影响属可接受残留面）**；级联删除断言进 tests/artifact-checklist.test.ts（删 conversation → artifact 行清除）。golden-schema 同步。
- [ ] **`emit_checklist` 工具**（safe/finance）：入参 `title` + `items:[{label, detail?, severity?}]`（1-50 项上限防滥用）；handler 生成 uuid、items 分配稳定 id、落库、返回 structuredContent `{kind:'artifact_checklist', artifactId, title, items}`。接线三件套（TOOL_REGISTRY + renderers T6 中文摘要 + **不挂任何角色白名单**——v1 主对话专用，子代理产出的清单由主对话汇总时物化）。
- [ ] **ChecklistCard**：按 `structured.kind==='artifact_checklist'` 分发（判别优先，WP4a 模式）；渲染 title+items（severity 用 tone 系统）；每项三态按钮；**mount 时 GET 拉最新 state**（历史重开保真）；**GET 404 降级（reviewer N1）**：渲染只读静态视图 + "工件已删除，无法操作"灰字，不报错不崩；点击走 PATCH 等待响应更新（submitting 态样板 AskUserCard），失败恢复并提示；**卡片底部固定灰字提示（reviewer N4）："勾选仅记录处理进度，不改变实际申报/业务状态"**。Surface/token 规范。**tool-registry.test.ts 的 TOOLS_WITH_RESULT_CARD 镜像与 tool-cards.tsx 常量双处必改**（reviewer N5/N6——非条件项；注意镜像已有 diff_payroll_period 漂移，本刀顺带对齐并 audit 说明）。
- [ ] **API route** `app/api/artifacts/[id]/route.ts`：GET 返回 payload+state；PATCH `{itemId, state}` 校验（itemId 存在于 payload、state 枚举）后更新并回读；非法入参 400 中文提示。
- [ ] **SKILL 接入**：两个 SKILL 的输出段追加指示——清单产出后调用 emit_checklist 物化（filing-precheck：⚠️ 与 ❓ 项；receivables-ledger：逾期催款项），正文表格保留；skills-store 相关测试不受影响（frontmatter 不动）。
- [ ] 测试：迁移形状/工具落库与 structured 形状/route GET-PATCH 三路径（含 400）/卡片 parse（finance-cards 模板）/白名单守卫；注册 all.test.ts 末尾。
- [ ] 全量 EXIT=0 零 unhandledRejection + typecheck + lint。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/db/migrations.ts` | 修改 | v10 artifacts（开工验证末尾是 v9） |
| `lib/db/artifact-store.ts` | 新增 | createArtifact/getArtifact/patchArtifactState（含校验） |
| `lib/agent/mcp-tools/finalize-deliverable.ts` 同目录新文件 `emit-checklist.ts` | 新增 | 工具定义 |
| `lib/agent/mcp-tools/index.ts` | 修改 | 工具挂载（按既有 MCP server 组装惯例） |
| `lib/agent/tools/registry.ts` | 修改 | 注册（safe/finance） |
| `lib/agent/tools/renderers.ts` | 修改 | 中文摘要（T6） |
| `app/api/artifacts/[id]/route.ts` | 新增 | GET/PATCH |
| `app/components/checklist-card.tsx` | 新增 | 可勾选卡片 |
| `app/components/tool-cards.tsx` | 修改 | kind 判别分发 + 白名单常量 |
| `agent-skills/skills/filing-precheck/SKILL.md` | 修改 | 输出段接入指示 |
| `agent-skills/skills/receivables-ledger/SKILL.md` | 修改 | 同上 |
| `tests/artifact-checklist.test.ts` | 新增 | §1 全部行为 |
| `tests/tool-registry.test.ts` | 修改（必改，reviewer N6） | 白名单镜像扩 + 顺带对齐既有 diff_payroll_period 漂移 |
| `tests/fixtures/golden-schema.json` | 修改 | v10 同步 |
| `tests/all.test.ts` | 修改 | 注册（末尾追加） |

## 3. 实施步骤

1. 红测试。2. v10+store。3. 工具+接线（跑 T6 守卫）。4. route。5. 卡片+分发。6. SKILL 接入。7. 全量。

## 4. 测试与验证

```bash
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
npm run typecheck && npm run lint
```
- 卡片交互的浏览器级验证：mock 模式手工冒烟（audit 记录做了什么），e2e 用例等 WP14b 一起补。

## 5. 风险与开放问题

- **conversationId 注入（reviewer B1 修正先例）**：`createFinanceMcpServer`（lib/agent/mcp-tools/index.ts:22）**签名已有 `conversationId?: string` 且 claude-adapter.ts:205-211 已在传**——emit_checklist 经组装层直接拿到，正常路径非 NULL；真先例是 `createSpawnSubagentTool(sdk, outputDir, traceId, conversationId, …)`（index.ts:28），v1.0 引用的 createFinanceTools(sdk, outputDir) 实为 void 忽略参数，撤回。NULL 仅在无会话上下文的边缘场景出现。
- **PATCH 并发（reviewer N3）**：无乐观锁，last-write-wins，单机产品可接受——implementer 勿加 ETag/version。
- emit_checklist 无幂等，改口重发产生多工件（reviewer N2）：v1 接受，text 返回带 artifactId 供辨识。
- PATCH 无鉴权（单机产品、本地 API，与既有 route 一致）。
- 被否决：① 状态存 chat_agent_events UPDATE（破坏事件溯源）；② SKILL 直接产 structured（技能是 prompt 无此能力，必须经工具）；③ 乐观更新（无先例，v1 保守）；④ 勾选直接触发业务核销（工件是进度记录，业务动作走各自链路防越权）。
