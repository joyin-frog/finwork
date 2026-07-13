# Security Release Blockers Spec

> 版本 v1.4 / 2026-07-13
> 状态：实施完成，owner 安全收口及独立实施审查通过
> 依赖：`docs/spec/spike-tool-gate-findings.md`
> 架构事实：Agent 通过 `@anthropic-ai/claude-agent-sdk` 的 `allowedTools` 与 `canUseTool` 控制工具；仓库运行时实验已证明内置工具处于 `allowedTools` 时会绕过 `canUseTool`，而 MCP 工具仍会经过它。知识库文档记录的 `storage_path` 会在删除知识条目时被物理删除。

## 0. 目标与非目标

**目标**：关闭当前发布阻断的本机执行与数据丢失路径：确保所有内置工具都不能绕过安全 hook；`run_python` 每次必须经主对话用户确认且在无确认通道的子 Agent 中 fail-closed；从文件库加入知识库时创建知识库自有副本，删除知识条目不再删除原附件。

**非目标（本期不做，已知并接受)**：
- 不把 Python monkey-patch 宣称为沙箱；OS 级文件、网络、子进程、CPU、内存和磁盘隔离另立任务。
- 不在本期收窄内置 `Read`/`Glob`/`Grep` 的读取根；本期只保证它们实际经过现有 hook 链，后续再做授权根设计。
- 不处理上传总量、目录扫描配额、Tauri capability、本地 API 认证、下载摘要和发布签名。
- 不修改既有 `src-tauri/Cargo.lock` 用户改动。

## 1. 成功标准

- [x] `ALLOWED_TOOLS` 不包含任何 `category === "builtin"` 的工具；主 Agent 与子 Agent 同时注册 SDK 原生 `PreToolUse` 机制闸，形成双重防线，不能用自动放行绕过安全 hook。
- [x] `Bash` 仍由 `createUnwiredToolHook` fail-closed；`Write`/`Edit`/`MultiEdit` 仍由现有输出目录 hook 控制。
- [x] 原生 `PreToolUse` 回调测试覆盖 Bash deny、越界 Write deny、输出目录内 Write defer，并以源码合同确认主 Agent、子 Agent 均注册；安全检查通过不直接 approve，继续交给 `canUseTool` 作最终裁决。
- [x] 子 Agent 与主 Agent 一样只加载 `BUILTIN_TOOLS + Skill` 显式工具集合，不得加载会额外暴露 `NotebookEdit` 等未登记写能力的完整 `claude_code` preset。
- [x] `run_python` 风险等级为 `high`，不在 `ALLOWED_TOOLS`；只有精确的明确肯定答案允许，取消、空值及“拒绝/不要执行/稍后”等其他文本全部拒绝；子 Agent 无确认通道时拒绝。
- [x] `run_python` 的确认文案明确说明它可读取、修改本机文件并执行代码，不暴露内部 MCP 名称。
- [x] 文件库 `promote` 使用内容寻址的知识库自有副本作为 `storage_path`，不再保存原聊天/文件库路径。
- [x] 回归测试覆盖“promote → DELETE 知识条目”后原附件仍存在、知识库副本被删除。
- [x] promote 解析/入库失败时不即时删除可能被并发请求使用的内容寻址副本；双 hash/path ingest lease 在 `finally` 释放，安全孤儿留待未来基于年龄的 GC（由 `spec-integrity-atomic-csv.md` v1.4 取代旧清理合同）。
- [x] 同名不同内容的知识文档更新时同步更新 `content_hash` 和 `storage_path`；旧路径仅在真实知识库根目录内才允许物理删除。历史共享路径、任意外部路径和经 symlink/junction 逃逸的路径均物理删除 no-op，但逻辑知识条目仍可正常删除。
- [x] 定向测试、类型检查和标准全量测试通过；若全量检查仅受已有 stale Tauri 产物影响，必须原样记录而不得修改这些产物。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `docs/spec/spec-security-release-blockers.md` | 新增/更新 | 本 spec 状态 |
| `lib/agent/tools/registry.ts` | 修改 | 内置工具全部移出自动放行；`run_python` 改为 high risk |
| `lib/agent/hooks/built-in.ts` | 修改 | 为 `run_python` 增加清晰的高风险影响说明并修正失效注释 |
| `lib/agent/hooks/chain.ts` | 修改 | confirm 改为仅明确肯定回答放行 |
| `lib/agent/hooks/sdk-pre-tool-use.ts` | 新增 | 将内置工具安全 hook 映射为 SDK 原生 PreToolUse deny/allow 输出 |
| `lib/agent/claude-adapter.ts` | 修改 | 主 Agent 注册原生 PreToolUse 机制闸 |
| `lib/agent/subagent-runner.ts` | 修改 | 子 Agent 注册同一原生 PreToolUse 机制闸 |
| `tests/confirm-gate-fix.test.ts` | 修改 | TDD 锚定内置工具与 `run_python` 均不在 `ALLOWED_TOOLS` |
| `tests/agent-confirm-flow.test.ts` | 修改 | TDD 锚定 `run_python` 主对话确认与无通道拒绝 |
| `tests/sdk-pre-tool-use.test.ts` | 新增 | 验证原生 hook 输出和主/子 Agent 注册合同 |
| `tests/skill-xlsx.test.ts` | 修改 | 更新工具“可见”与“自动放行”的合同，技能仍有工具定义但不要求自动放行 |
| `tests/role-registry.test.ts` | 修改 | 高风险/内置工具不再要求出现在子 Agent 自动放行集合 |
| `tests/all.test.ts` | 修改 | 注册新增测试 |
| `app/api/files-library/route.ts` | 修改 | promote 写入知识库自有副本并传入其路径 |
| `tests/files-promote.test.ts` | 修改 | 增加真实 route promote/delete 生命周期回归 |
| `lib/knowledge/storage.ts` | 修改 | 物理删除前强制知识库根目录 containment |
| `tests/knowledge-storage.test.ts` | 修改 | 外部路径拒删与知识库路径可删回归 |
| `lib/knowledge/pipeline.ts` | 修改 | 同名内容更新时迁移 hash/storage ownership 并安全清旧副本 |
| `lib/db/sqlite.ts` | 修改 | metadata 更新同步持久化 content_hash/storage_path |
| `docs/spec/audit-security-release-blockers.md` | 新增 | 实施审计与验证结果 |

实施中如需修改列表外文件，停止并报告。

## 3. 实施步骤

1. 先修改 `tests/confirm-gate-fix.test.ts` 和 `tests/agent-confirm-flow.test.ts`：断言所有 builtin 都不在 `ALLOWED_TOOLS`、`run_python` 不在自动放行列表；确认只接受明确肯定答案，补“拒绝/不要执行/稍后”拒绝用例。运行并确认 RED。
2. 修改 `lib/agent/tools/registry.ts` 与 `lib/agent/hooks/chain.ts` 实现上述合同。`BUILTIN_TOOLS` 保持工具定义集合不变；`ALLOWED_TOOLS` 仅表示自动放行集合，不再承担工具可见性语义。
3. 新增 `sdk-pre-tool-use.ts`：仅对安全敏感内置工具 `Bash`、`Read`、`Write`、`Edit`、`MultiEdit` 复用 `createUnwiredToolHook`、`createReadGuardHook`、`createPathSafetyHook` 与 `runBeforeHooks`。deny 映射为 `permissionDecision: "deny"`；安全检查通过统一映射为 `permissionDecision: "defer"`，绝不在原生 hook 中 approve，继续交给 `canUseTool` 最终裁决。其他工具返回无 permissionDecision 的 continue 结果，不能抢先绕过 `AskUserQuestion` 等逻辑。主/子 Agent 的 SDK `hooks.PreToolUse` 都注册它。
4. 更新 `skill-xlsx`、`role-registry` 测试合同：技能需要的是 `BUILTIN_TOOLS` 中存在 Bash/Write 定义，不是自动放行；角色自动放行集合可以排除 builtin 与 high-risk `run_python`。新增 `sdk-pre-tool-use.test.ts` 验证 callback 行为和主/子注册源码合同，并断言子 Agent 使用 `BUILTIN_TOOLS + Skill` 而非完整 `claude_code` preset，注册到 `tests/all.test.ts`。
5. 修改 `lib/agent/hooks/built-in.ts`：给 `run_python` 增加用户能理解的风险说明；修正“Bash 已安全接线”等已失效注释，不改变其余 hook 行为。
6. 在 `tests/knowledge-storage.test.ts` 先增加外部现存文件和目录 symlink/junction 逃逸拒删用例（平台不支持创建 symlink 时显式 skip）；修改 `deleteStoredFile` 返回 boolean/no-op 语义：仅当现存目标的 `realpath` 位于现存知识库根的 `realpath` 内才删除并返回 true，其他情况返回 false，不抛错。
7. 在 `tests/files-promote.test.ts` 增加真实 route 生命周期：唯一附件 promote 后删除知识条目，原件保留、副本删除；历史外部 `storage_path` 的 DELETE 仍返回成功、原件保留且 DB 行删除；再覆盖同名不同内容，确认 DB hash/storage 切到新副本且旧知识副本被清理。测试用 `try/finally` 恢复 env，避免污染全量测试。先确认 RED。
8. 修改 `app/api/files-library/route.ts`，复用 `writeUploadedFile` 创建知识库自有副本，并以副本作为 parse/storage 路径；后续 `spec-integrity-atomic-csv.md` v1.4 已将失败即时清理替换为双 lease + 年龄 GC 合同。修改 `pipeline.ts` 与 `sqlite.ts`：同名内容变化时同步更新 hash/storage；新 DB 状态落盘后，仅在最后 owner 且无 active lease 时安全清理不同的旧知识副本。历史外部共享路径不会被删除。
9. 运行全部定向测试、类型检查和全量测试，编写 audit。

## 4. 测试与验证方式

```bash
node --import tsx tests/confirm-gate-fix.test.ts
node --import tsx tests/agent-confirm-flow.test.ts
node --import tsx tests/sdk-pre-tool-use.test.ts
node --import tsx tests/knowledge-storage.test.ts
node --import tsx tests/files-promote.test.ts
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```

- 新增 callback 行为测试必须检查 SDK 规定的 `PreToolUse` 输出形状，特别断言通过检查时为 `defer` 而非 `allow`，并确认主/子 Agent 都接线；不能只测试孤立过滤函数。
- 本期不把需要模型联网且可能产生费用的 spike 纳入 `npm test`；仓库已有 `spike-tool-gate-findings.md` 的 SDK 运行时实验作为 `allowedTools` 绕过依据，SDK 原生 `PreToolUse` 则作为不依赖 permissionMode 的机制闸。发布前仍需桌面 smoke 一次合法 Read/Write 与 Bash 拒绝。
- 本期不需要桌面构建，未修改 Tauri 配置或 Rust。

## 5. 风险与开放问题

- 内置工具移出 `allowedTools` 后会更多地进入 permission 流；原生 `PreToolUse` 是强制机制闸，桌面 smoke 仍需确认合法 Read/Write 不退化。
- `run_python` 每次确认会增加交互成本，这是 OS 级隔离完成前有意接受的临时安全代价。
- 知识库副本会增加一次磁盘占用，但建立了清晰所有权，避免删除共享原件；全局存储配额另立任务。
