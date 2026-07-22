# Spec：Run 级 Python 授权与权限生命周期

> ID：CR-P1  
> 状态：Blocked — 等待 CR-R1、CR-R2  
> 日期：2026-07-21  
> 前置依赖：CR-R0、CR-R1、CR-R2  
> 替代：conversation 级内存 session-trust  
> 安全声明：v1 是持久授权生命周期与产品路径护栏，不宣称完整 OS 级 Python 沙箱

## Problem Statement

当前 `run_python` 可以选择“本次对话不再询问”，但信任只存在进程内、绑定 conversationId，重启丢失；等待卡与 SSE 生命周期耦合。更重要的是，`run_python` 执行任意 Python，单靠路径字符串检查无法保证代码只访问任务目录。如果把一次确认描述成“仅访问本任务文件”，会形成虚假安全承诺。

## Solution

将 Python 信任迁成持久、可撤销、绑定 runId 的 capability。v1 明确其风险为“本 Run 内允许执行本机 Python”，同时继续严格限制产品管理的输入、输出和正式交付路径。依赖安装只能走产品 Dependency Manager；业务不可逆工具仍逐次确认。完整 OS 沙箱另行立 Spike/Spec。

## User Stories

1. 作为用户，我希望同一个长任务只确认一次 Python 执行。
2. 作为用户，我希望切页重连后不重复确认。
3. 作为用户，我希望新任务不会继承旧任务授权。
4. 作为安全负责人，我希望 UI 不夸大当前沙箱能力。
5. 作为管理员，我希望依赖安装和业务写操作不被 Python 信任覆盖。

## Implementation Decisions

### 1. Capability Types

```ts
type RunCapability =
  | "python_execute_unrestricted"
  | "dependency_install"
  | "network_access_managed";
```

- `python_execute_unrestricted`：允许本 Run 使用 run_python；确认卡明确说明任意 Python 理论上可以访问本机文件/网络。
- `dependency_install`：只授权产品 Dependency Manager 安装固定 manifest 组件，不允许模型任意 pip。
- `network_access_managed`：只供明确的产品下载器/外部工具使用，不代表 arbitrary Python 网络已被隔离。

在 OS 沙箱完成前，不提供或展示虚假的 `workspace_only_python` capability。

### 2. Grant Record

```text
run_id, capability,
granted_at, last_used_at, expires_at,
granted_by, revoked_at, revoke_reason,
scope_metadata_json
```

- 同一 runId + capability 唯一。
- 新 Run 不继承。
- 默认 TTL：最后使用后 30 分钟，且不超过当前 budget epoch。
- completed/failed/canceled、process_crash、scope 变化或 paused 超过 10 分钟时撤销。
- resume 后若 grant 已撤销，重新确认。

### 3. Confirmation UX

首次 run_python 展示：

- 本次准备执行的业务摘要。
- Python 可以读取/修改本机文件并执行代码的真实风险。
- “仅本次调用”。
- “本任务期间允许”。

选择本任务后，同一 Run 内不重复确认。拒绝进入 `paused/permission_denied`；过期进入 `paused/permission_expired`。等待时间不计 Run active budget。

### 4. Pending Question Persistence

- pending question 持久化并绑定 runId、toolCallId 和 capability。
- SSE 断开不取消。
- stop 会结清 pending question 并撤销 grant。
- resume 不自动重放未确认工具；用户确认后才重新安排。
- 同一 toolCallId 的重复回答幂等。

### 5. Product Path Guards

虽然 v1 不宣称完整沙箱，产品管理的路径仍必须强制：

- 输入路径必须来自该 conversation 的已登记附件。
- output_dir 必须为该 Run working 目录。
- Write/Edit/finalize 使用规范化绝对路径。
- 拒绝 `..`、symlink escape、目录外 delivered 写入。
- `delivered/` 永远不进入 run_python 可写范围。
- 所有拒绝记录审计。

这些护栏保护产品文件流，但不能作为 arbitrary Python 无法访问其他路径的证明。

### 6. Dependency Installation

- Agent 不得运行 `pip install`。
- Dependency Manager 只安装受版本控制 manifest 中的固定组件。
- 安装卡与 `dependency_install` capability 单独确认。
- 安装任务绑定 Run，但产物属于应用 Runtime；完成后 capability probe 决定是否继续。
- 网络下载、checksum、原子安装由对应 Runtime Spec 管理。

### 7. Business Risk Isolation

以下授权不被 Python grant 覆盖：

- 工资确认/锁定。
- 外部系统写入。
- 全局记忆/画像修改。
- 撤销、删除、不可逆业务动作。

它们继续按工具逐次确认。

### 8. Migration

- 旧 conversation session-trust 不迁移为持久 grant。
- 新 Run 启用 capability store 后，旧内存 set 只服务仍在进行的旧协议回合。
- 迁移窗口结束后删除双轨代码和 sentinel。
- 历史 UI 不显示旧信任仍有效。

## File Ownership

允许：

- Run capability/pending question store。
- risk confirm hook/chain。
- ask-user API 和确认 UI。
- session-trust 迁移删除。
- 产品路径规范化和审计。

禁止：

- Run 状态词表和 event persistence。
- OS 级 Python 沙箱实现。
- Spreadsheet Runtime 或 validator。
- 放宽业务高风险工具。

## Testing Decisions

- 同一 Run 50 次 Python 只确认一次。
- 新 Run 重新确认。
- reconnect 后有效 grant 保留。
- process crash、长 paused、TTL 和 stop 撤销。
- pending question 幂等、重连和拒绝。
- output/delivered 路径与 symlink escape。
- Dependency Manager 授权不允许任意 pip。
- 业务高风险工具仍逐次确认。
- UI 文案明确 unrestricted 风险，不出现“只访问本任务文件”误导。

## Acceptance Criteria

1. Python 信任从 conversation 内存迁到 runId 持久 grant。
2. 同 Run 一次确认，跨 Run 不复用。
3. 授权有 TTL、暂停和终态撤销。
4. SSE 断开不丢 grant 或 pending question。
5. 产品路径和 delivered 目录护栏生效。
6. UI 对 v1 安全边界描述真实。
7. 依赖安装和业务高风险确认保持独立。

## Out of Scope

- 阻止 arbitrary Python 读取所有目录。
- 阻止 arbitrary Python 自行建立网络连接。
- 容器、VM、macOS sandbox-exec 或 Windows AppContainer。
- 多用户远程执行隔离。

## Further Notes

若产品要求“无需展示高风险、自动允许文档 Python”，必须先立 OS/worker sandbox Spike；不能通过改确认文案实现。

