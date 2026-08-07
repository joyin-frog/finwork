# Finwork Pi 长活 Session 设计

> 版本：v1.0
> 日期：2026-07-30
> 状态：**核心决策已推翻（2026-08-03）** —— 见 §0。收益经核实后由两项更小的改动分别实现，
> 不再做「session 活过 HTTP 回合」。本文件保留为决策记录。
> 前置：AR12/AR13 已 ship（Pi-only 主链）
> 架构 SSOT：`design-pi-agent-runtime.md`（本文件修订其 §8 与 §5）
> 总纲账本：`ROADMAP-agent-runtime.md`（新增 AR15）

## 0. 推翻记录（2026-08-03，L6 实施时）

本文件的核心决策是「Session 活过单个 HTTP 回合」。实施前逐条核实它的收益，只剩一条半：

| 原列收益 | 核实结果 |
|---|---|
| compaction 连续性（§1 第 3 条） | **不成立**。`SessionManager.appendCompaction()` 把压缩条目写进 JSONL，重开 session 即恢复——已读 pi 源码确认。 |
| 免掉每回合 `loader.reload()` / 重注册 provider | 真实，但**不需要长活 session**。provider 按装配指纹缓存即可；而 loader 实测重建只要 **~7ms**（首次 1054ms 是模块冷加载，缓存也救不了），对比数秒的模型调用是 0.1% 量级，**不值得为它冒险**。 |
| 运行中插话（steering） | 真实，但插话的语义是「往**正在跑**的 session 注入」。回合结束后那个 session 已经 idle，没有什么可插。需要的是**在途**注册表，不是跨回合持有。 |

而代价被低估了：跨回合持有要求 `emit`、`traceId`、`resolveUserQuestion`、`onSubagentEvent`
全部改成经可变「当前回合上下文」间接引用。这条路径每条消息都走，一旦指向错了，事件会串进
**另一个会话的 SSE 流**——财务应用里的跨会话泄漏。

**结论**：收益都能用更小、彼此独立、各自安全的改动拿到，因此不做跨回合持有。实际落地为：

- `lib/agent/pi/live-sessions.ts`（L6a）—— 在途 session 注册表，解锁 `steer`/`followUp`。
- `provider.ts` 的 ModelRuntime 指纹缓存（L6b）—— 指纹含 apiKey，换密钥必换 runtime。
- ResourceLoader **不缓存**，理由见上表（7ms）。

下面 §1–§7 为原始设计，保留以记录判断是如何变化的；其中 D1/D2/D3/D6 已不适用。

## 1. 为什么（原始论证，第 3 条已证伪）

Pi-only 迁移在合同层做得干净：Pi 类型止于 `lib/agent/pi/**`，Zod 保持权威校验，
事件映射不泄漏 SDK 形状。但**会话生命周期照搬了 Claude Agent SDK 的 `query()`
请求/响应模型**：每条用户消息完整走一遍

```
ModelRuntime.create() → registerProvider() → SettingsManager.inMemory()
→ new DefaultResourceLoader() → loader.reload() → SessionManager.create/open()
→ createAgentSession() → prompt() → waitForIdle() → dispose()
```

Claude SDK 是「配置好然后调用」的黑盒，一次性装配是它的正确用法。Pi 是「组合起来
用」的库，它的单位是长活 `AgentSession`。把前者的形状搬到后者上，产生四类代价：

1. **每条消息重扫 skill 目录**（`resource-loader.ts` 的 `await loader.reload()`）、
   重建 ModelRuntime、重注册 provider。
2. **steering 在架构上不可能**。session 在回合末 `dispose()`，没有活体可以 steer 进去。
   AR10 E7 已验证 `steer`/`followUp` 可用，但当前架构里没有它的位置。
3. **compaction 收益减半**。Pi 的压缩是 session 内的持续状态，每回合重开只能靠 JSONL 复原。
4. **横切关注点无处安放**。授权、审计、计时、错误映射全挤进 tool-adapter 的 `execute` 闭包。
   （**订正**：当初以为是 `noExtensions: true` 关掉了 extension 机制。实测不是——
   `noExtensions` 只过滤磁盘发现的扩展路径，内联 `extensionFactories` 照常加载。
   真正的原因只是没人去建这个落点。L1 已建。）

第 4 条是 `design-pi-agent-runtime.md` §8 与实现漂移的真正原因：§8 要求的 extension
在一次性 session 下确实没有落点，实现只能绕开它。

**这不是 Next.js 的约束。** Finwork 是 Tauri 桌面应用，单用户、常驻 Node 进程。
按 conversationId 在进程内持有活 session 完全可行——`pending-questions.ts` 和
`session-trust.ts` 已经用 `globalThis` Map 做同类事情，并注明「仅支持单进程部署」。

## 2. 决策

**Session 活过单个 HTTP 回合。** 按 conversationId 在进程内持有 `AgentSession`，
回合结束不 `dispose()`；空闲超时或会话关闭才释放。

由此连带确定：

| # | 决策 | 内容 |
|---|------|------|
| D1 | 生命周期所有者 | 新增 session registry，按 conversationId 持有活 session；`globalThis` 挂载，照 `pending-questions.ts` 的既有形态，注明单进程约束 |
| D2 | 释放时机 | 空闲 TTL（缺省 30 分钟）+ 会话删除 + 进程退出；不按回合释放 |
| D3 | 并发 | 同一 conversationId 串行——第二个请求要么排队（steering 语义），要么 409；**不允许**两个 prompt 并发进同一 session |
| D4 | Provider / loader 缓存 | ModelRuntime 按 provider profile hash 缓存；ResourceLoader 按 skill 目录 mtime 缓存。设置变更或 skill 增删使缓存失效 |
| D5 | Extension 复位 | §8 的 Finwork extension 重新立项：承载 provider 请求/错误 trace、compaction 审计、未接线工具拦截。**授权仍留在 tool-adapter**（那里能拿到 Zod 解析后的入参，是正确挂点） |
| D6 | ~~builtin 仍全关~~ **已被 L1 取代** | 原决策为「不打开 Pi builtin」。L1（2026-07-30）改为**按会话目录自构造** read/write/edit + `tool_call` 路径闸；L1b（07-31）给 bash 加 OS 沙箱并在无沙箱平台不注册。自建 `Skill` 工具仍保留（删它属 L4） |
| D7 | locator 语义 | locator 归 runtime 所有，Query 只搬运不铸造；恢复时「文件不在」降级为新会话，「越界」硬失败。**已随本设计先行修复** |
| D8 | 事件合同不变 | `AgentRuntimeEvent` 不变，`run_settled` 仍由 Query 单一收口。live session 是运行时优化，不是协议变更 |

### 明确不做

- 不做多进程/多用户 session 共享（`globalThis` 方案的既有边界）。
- 不做 session 迁移或跨进程恢复——进程重启后按 JSONL locator 冷恢复，与现在一致。
- 不在本包做 steering UI（AR5 的 UI 仍暂缓），只让它成为可能。
- 不打开 Pi builtin 工具（D6）。
- 不改 `AgentRuntimeEvent`、SSE 帧或前端终态逻辑。

## 3. 功能点

### AR15a　Session Registry

`lib/agent/pi/session-registry.ts`：

- `acquire(conversationId, factory): Promise<LeasedSession>` —— 命中返回活 session，
  未命中用 factory 建。**返回租约，同 conversationId 串行**（D3）。
- `release(lease)` —— 归还，重置空闲计时器，不 dispose。
- `evict(conversationId, reason)` —— 显式释放（会话删除、设置变更、模型槽切换）。
- 空闲 TTL 到期 dispose；`timer.unref?.()` 照 `pending-questions.ts`。

关键约束：**模型/角色/工具白名单变化必须 evict**。同一 conversation 切「深度思考」
档位会换模型槽，复用旧 session 会静默沿用旧模型——这是本包最容易埋的坑。
registry key 应为 `conversationId + 装配指纹`，指纹变化即视为未命中。

### AR15b　Provider / ResourceLoader 缓存

- `provider.ts`：ModelRuntime 按 `(apiUrl, apiKey 指纹, modelId)` 缓存。
- `resource-loader.ts`：按 skill 根目录 mtime + 启停状态指纹缓存，替代无条件 `reload()`。
  **前置已由 L3a 完成**：系统提示词已拆成静态前缀（只依赖公司名/Agent 名/roleMode，可缓存）
  与动态段（走 `before_agent_start` 每回合重算），loader 因此不再被动态内容绑死。
- 两者都必须能被设置写入显式失效——`/api/settings/agent` 落盘后 evict。

### AR15c　Finwork Pi Extension　—— **已提前落地，本包只剩 compaction 审计**

`lib/agent/pi/extension.ts` 已由 L1/L2/L3 建成并承载：内置工具 `tool_call` 路径闸（L1）、
provider trace `before_provider_headers`/`after_provider_response`（L2c）、
动态系统提示词 `before_agent_start` 与历史回放 `context`（L3）。授权确如 D5 所述留在
tool-adapter（Zod 之后）。**本包剩余项只有 compaction 审计**（`session_before_compact`）。

### AR15d　Steering 底层接线

活 session 之上把 `steer`/`followUp` 接到已存在的 `queue_updated` 映射，删掉
`runtime-events.ts:66` 的「本期只定义不发射」注释。UI 仍不做。

## 4. 验收标准

必过：

1. 同一 conversation 连续三轮，`loader.reload()` 与 `registerProvider()` 各只发生一次
   （用调用计数断言，不看日志）。
2. 切换「深度思考」档位后，下一轮实际使用新模型槽——断言 `message.model`，不是断言没报错。
3. 同 conversationId 并发两个请求，不出现两个 prompt 同时进同一 session；第二个按 D3 排队或 409。
4. 空闲 TTL 到期后 session 被 dispose，进程内无泄漏（registry size 归零）。
5. 进程重启后按 JSONL locator 冷恢复，续聊行为与当前一致。
6. `run_settled` 仍每 run 恰好一条，且仍由 Query 发射。
7. 恢复降级：locator 指向已删除文件时起新会话，并经 `context` 钩子回放历史（L3b 起不再是
   扁平文本回顾），不抛错；越界 locator 仍硬失败。
8. 现有 `tests/pi/**` 与 `npm test` 全绿。

不得回退：事件合同、Zod 权威校验、session 目录 confinement、ambient 关闭、
子代理 fail-closed 注入。

## 5. 前置欠账（已清）

这两条不清，本包的验收标准无法被信任。**2026-07-30 均已修复。**

- **P1　worktree 装不上 pi** —— 已修。`scripts/link-worktree-node-modules.mjs` 原来只判
  `node_modules` 是否**存在**，从不判它是否**满足本 worktree 的 package.json**。worktree 与
  主检出可在不同分支，改依赖的分支（本迁移分支即是）会静默拿到主检出那棵树，报错形如
  `TS2307 Cannot find module '@earendil-works/...'`——长得像代码错误，实际是环境错误。
  现在软链前后都校验：缺包一定报，精确锁定版本（pi 三包的 `0.82.1`）漂移也报，
  不满足即 exit 1 并给出修复命令，绝不交出一棵错的树。范围声明（`^`/`~`）仍交给 npm 自己判，
  避免误报。
- **P2　`test:pi` 不在 CI** —— 已修。`npm test` 改为 `npm run test:pi && all.test.ts`：
  一个入口同时覆盖 Pi 边界层与主套件，CI 的 `npm test` 因此自动获得 Pi 门，且**两者仍是
  独立进程**（Pi 套件各自 mutate env、跑真 Python 子进程，塞进 all.test.ts 的单进程会与
  DB 单例和 `APP_DATA_DIR` 串味，属于该文件头部记载的假绿灯同一类）。
  只想跑主套件用 `npm run test:main`。已实测：Pi 套件失败 → `npm test` exit 1 且短路，
  主套件不再执行。

P1 + P2 合起来解释了 D7 那个 bug 为什么能带着「本机 local gate 通过」的报告存活。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 装配指纹漏字段 → 静默沿用旧模型/旧工具白名单 | 指纹由单一函数产出并单测枚举字段；验收 2 直接断言 `message.model` |
| 活 session 内存增长 | 空闲 TTL + registry 容量上限；超限按 LRU evict |
| 并发语义引入死锁 | 租约必须 try/finally 归还；租约获取带超时 |
| 与 G1（session 文件无保留期）叠加 | 保留期清理必须先 evict 活 session 再删文件，否则删掉正在写的 JSONL |

## 7. 与 G1 的关系

保留期治理（Pi session JSONL 无界增长）是独立缺陷，但**必须在本包之后或与本包协同**：
活 session 持有打开的 JSONL 句柄，清理器不能直接删。顺序是 AR15a 建好 registry 与
`evict()`，保留期清理调用 `evict()` 再删文件。
