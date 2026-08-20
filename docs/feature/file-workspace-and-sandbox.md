# 文件工作区、动态脚本与本地沙箱

> 状态：当前实现说明，不是待实施 Spec。
>
> 适用范围：Finwork 桌面端的用户文件、授权文件夹、Agent 动态 Python、正式交付、macOS 与 Windows 11 沙箱。

## 1. 结论

Finwork 使用“受管资产面 + 短期执行面 + 正式交付面”的本地混合架构：

```text
上传文件 / 授权文件夹
        ↓
加密资产库（版本、分块去重、路径密文）
        ↓
runs/<runId>/inputs（只读快照）
        ↓
runs/<runId>/work（Agent 唯一写入区）
        ↓
脚本执行证据 + 候选文件版本 + 语义 diff
        ↓
finalize_deliverable 质量门
        ↓
runs/<runId>/outputs + 会话 delivered/<runId>
```

核心取舍：

- 默认本地处理财务文件，不把 Docker、远程 VM 或云端 Code Interpreter 作为前置条件。
- 常规 Excel/文档操作优先使用声明式工具；动态 Python 是通用工具不足时的能力扩展。
- Agent 不接触用户真实路径；文件工具使用 `assetId`，动态代码只看到任务快照路径。
- 工作文件不是交付物。只有通过合同质量门并复制到 `delivered/` 的文件才能成为正式聊天附件。
- 现有 Excel 修改做语义 diff；新文件形成 `base=null` 的出生变更集；每次脚本执行都有可追溯版本。

## 2. 三个存储面

### 2.1 受管资产库

位置：`<app-data>/file-workspace/managed`。

- 上传文件进入 AES-256-GCM 加密、内容寻址的分块存储。
- 使用带主密钥的私有内容 ID，避免裸 SHA-256 暴露相同文件关联。
- 相同内容和相同分块自动去重。
- 主密钥在 macOS 使用 Keychain，在 Windows 使用当前用户 DPAPI。
- 资产、版本、父版本和任务引用保存在 SQLite。
- 浏览器多文件上传保留独立文件身份和同一批次 ID，但浏览器没有提供目录句柄时不伪造目录层级。

### 2.2 授权文件夹

授权文件夹不整体复制进 Finwork：

- 数据库只保存路径密文、路径 HMAC、显示名、权限和写回策略。
- 初次索引只保存文件名、相对路径、大小、修改时间等 manifest。
- 文件真正进入任务时才创建不可变加密快照。
- 所有真实路径先 `realpath`，并验证仍位于授权根内，拒绝软链接逃逸。
- 默认写入授权根下的 `Finwork 输出`；只有 `confirm_replace` 且用户明确批准的变更集才可替换原件。
- 替换使用同目录 staging、备份和失败回滚。

当前索引默认最多 50,000 个文件，硬上限 200,000；列表单次默认 500、硬上限 5,000。

### 2.3 Run 工作区

位置：`<app-data>/file-workspace/runs/<runId>`。

| 目录 | 权限与用途 |
| --- | --- |
| `inputs/` | 按版本解密的任务输入，只读授予动态代码 |
| `work/` | Agent 和动态脚本的唯一可写目录，脚本、候选和中间文件都在这里 |
| `outputs/` | 通过交付门后的最终资产版本物化副本 |

生产对话和正式 benchmark 使用同一目录约定。旧会话 `generate/` 不再是生产执行源；会话目录只继续承载兼容数据和 `delivered/` 正式附件。

Run 明文工作区默认保留 24 小时后回收。加密资产版本按引用和墓碑策略独立保留。

## 3. 动态脚本证据链

动态代码入口只有 `run_task_python`：

1. Agent 先在 `work/` 写入 `.py`。
2. 工具在执行前冻结脚本内容，形成或复用脚本资产版本。
3. `script_executions` 写入 running 记录，绑定：
   - `runId`
   - 脚本 asset/version
   - 参数
   - 当前任务 input asset/version 列表
   - 沙箱类型
4. 沙箱执行结束后比较工作目录快照。
5. 每个新增或修改输出登记为受管输出版本，并记录 SHA-256、大小和逻辑路径。
6. 新文件首次输出形成 `base_version_id=NULL` 的出生变更集；修改既有受管工作簿时，`patch_workspace_workbook` 直接在原 asset 的唯一 run 分支头追加子版本，不再按 v2/v3 文件名创建 standalone asset。
7. execution 以 completed 或 failed 收口；超时、配额、沙箱启动失败也不会残留 running。

脚本内容与已执行版本一致时不制造重复版本；内容发生变化才生成新脚本版本。工作簿的变更计划、diff 与 review 由 patch 工具在 Harness 内自动冻结，主 Agent 不再调用协议工具。

固定 `workers/*.py` 是 Finwork 发布的受信应用代码，不等同于模型生成脚本。它们使用收窄环境变量和固定入口，但不进入动态脚本的 asset/version 链。

## 4. Diff 与交付

### 4.1 Diff 层级

| 文件 | 当前证据 |
| --- | --- |
| XLSX/XLSM | 工作表、格子值、公式、样式、批注、名称、表格、验证、隐藏行列、宏和包结构 |
| 文本/CSV/JSON/脚本 | 行级差异；CSV/TSV 附带字段统计 |
| 新文件 | 出生变更集、类型、大小和 SHA-256 |
| 其他二进制 | 前后 SHA-256 与字节数 |

既有受管 Excel 的模型可见完成链：

```text
read_workspace_file
→ Write/Edit 任务脚本
→ run_task_python（输出结构化 edits JSON）
→ patch_workspace_workbook
→ 按业务 Validator 结果继续修正
→ finalize_deliverable
```

`patch_workspace_workbook` 自动完成：

- 通过共享的 `resolveWorkspaceBranchHead` 选择当前 run 的唯一候选头；读取与 patch 不再各自猜测父版本。
- 拒绝旧父版本和无效果 patch。
- 从实际编辑清单生成内部变更计划。
- 计算语义 diff，并将候选追加为原 asset 的子版本。
- 淘汰上一 pending changeset，只保留一个权威 head。
- 形成 finalize 所需的 review 证据。

旧的 `begin_workspace_change`、`review_workspace_change` 模型协议已经删除。计划冻结、父版本选择、语义 diff 和复核证据都由 `patch_workspace_workbook` 内部完成。

同一 `assetId + versionId` 在一个 Run 内只物化和解析一次；重复读取返回缓存结果。候选头更新后自动使用新版本缓存键，因此既不会重复解析旧文件，也不会读回原始上传件。

### 4.2 正式交付

`finalize_deliverable` 负责：

- 按 DeliverySpec 核对文件数量、ID、扩展名与 MIME。
- 验证文件可打开性、正文或表格结构。
- 按合同进行公式重算、错误扫描和必要渲染。
- 以校验后 hash 复制不可变 `delivered/<runId>/` 副本。
- 提交 CompletionEvidence。
- 将最终版本登记到加密资产库，并物化到 run `outputs/`。

聊天附件只从 `delivered/` 登记；`work/` 中间文件不会冒充正式产物。

## 5. 动态 Python 安全边界

所有平台共有的纵深层：

- 只允许执行 `work/` 内的普通 `.py` 文件。
- 环境变量采用显式小白名单，不继承模型供应商密钥和宿主业务密钥。
- HOME、TEMP、缓存目录都落在本次 `work/`。
- Python audit hook 和 API 替换限制文件读写、网络、子进程、fork/exec、软链接和硬链接。
- 只读根来自真正调用过 `read_workspace_file` 的输入快照。
- 最长 180 秒；stdout/stderr 上限 2 MiB；新增文件上限 2,000；新增数据上限 512 MiB。
- OS 沙箱缺失或不满足要求时 fail-closed，不退回普通 Python。

Python 层是纵深防御，不代替 OS 隔离。允许原生库的条件是已经存在合格的 OS 沙箱边界。

## 6. macOS 与 Windows 11

| 能力 | macOS | Windows 11 |
| --- | --- | --- |
| OS 后端 | Apple Seatbelt (`sandbox-exec`) | Microsoft MXC `process` → BaseContainer |
| 动态 Python | 支持 | 仅 probe=`base-container` 时支持 |
| 通用 Shell | Pi Bash 在 Seatbelt 中支持 | 不注册 Bash |
| 输入 | 任务快照只读 | 任务快照只读 |
| 输出 | 仅 run `work/` 可写 | 仅 run `work/` 可写 |
| 网络 | Seatbelt deny | MXC policy default-deny |
| UI/剪贴板/输入注入 | Bash/Python 不授予 | MXC policy 全部关闭 |
| 降级 | Seatbelt 不可用则不注册 Bash/拒绝动态执行 | BFS/DACL tier 一律拒绝 |

### 6.1 macOS

Seatbelt profile 采用 deny-by-default：

- 系统命令、动态库、字体、时区等运行时根只读。
- 本次输入和技能根只读。
- `work/` 唯一可写。
- 网络完全禁止。

Pi Bash 只在 macOS 注册。动态 Python 同时受 Seatbelt 和 Python runner 两层约束。

已知限制：

- 没有内核级 CPU 和内存配额，当前依靠超时、进程终止和输出配额。
- `sandbox-exec` 是较旧的系统接口，需要在 macOS 大版本升级时持续跑真实逃逸回归。

### 6.2 Windows 11

Windows 使用随安装包固定版本的 `@microsoft/mxc-sdk` 和当前架构 `wxc-exec.exe`：

- 对随包 runner 执行官方 `--probe`。
- 只接受 SDK 定义的 `base-container` tier。
- `appcontainer-bfs` 和 `appcontainer-dacl` 不允许降级执行。
- filesystem/network/UI/timeout policy 交给 SDK `createConfigFromPolicy()` 生成正式 wire config。
- 调用时显式启用 BaseContainer experimental contract。
- runner 不从 PATH 查找，生产包优先使用自身固定二进制。

Windows CI 对打包后的 runner 执行：probe、SDK config dry-run；当 CI 主机提供 BaseContainer 时再运行真实命令。主机只有 fallback tier 时，CI 验证 config 后记录预期的产品 fail-closed 路径。

MXC 当前仍是微软早期预览项目。即使 BaseContainer 可用，Finwork 也继续保留 Python runner、秘密剥离、路径白名单、超时和输出配额，不把单一 MXC profile 当作全部安全边界。

## 7. 与开源 Agent 的位置

### OpenAI Codex

Codex 更擅长通用代码仓库：跨平台命令执行、可配置 workspace policy、审批与终端体验成熟。Finwork 的差异点是加密资产身份、Office 语义 diff、修改计划和正式交付证据，而不是复刻完整开发终端。

参考：https://github.com/openai/codex/blob/main/codex-rs/README.md

### Anthropic Sandbox Runtime

它与 Finwork macOS 路线接近：使用 Seatbelt 限制任意子进程，并为 Linux 提供 Bubblewrap。Finwork 范围更窄，不开放跨平台通用 shell，但把文件版本和财务交付闭环放在沙箱之外统一治理。

参考：https://github.com/anthropic-experimental/sandbox-runtime

### OpenHands / SWE-agent

Docker 提供更完整、可复现、可安装依赖的开发环境，适合代码 Agent 和 benchmark。代价是 Docker Desktop、镜像、卷挂载和 Windows 文件系统性能；读写挂载还可能直接修改用户仓库。Finwork 默认本地细粒度 broker 更适合敏感财务文件。

参考：https://docs.openhands.dev/openhands/usage/sandboxes/docker

### Cline

Cline 的 Shadow Git checkpoint 和用户可见文本 diff/回滚体验更成熟。Finwork 不用 Git 管理 Office 文件，而是保存资产版本和 Excel 语义变化；对于二进制财务文件，这比通用 Git diff 更有价值。

参考：https://docs.cline.bot/core-workflows/checkpoints

### E2B / 远程 microVM

Firecracker microVM 的隔离、资源配额、快照和任意依赖能力强于本地进程沙箱。但它要求上传文件并承担云端成本、延迟和合规边界，因此不作为 Finwork 本地财务处理的默认执行面。

参考：https://www.e2b.dev/docs

## 8. 当前验证门

- TypeScript typecheck。
- 文件资产加密、去重、授权根、快照、替换回滚。
- 动态脚本正常读写、秘密剥离、拒绝越界读写、拒绝网络和子进程。
- 脚本 execution、脚本版本、输出出生变更集和输出 manifest。
- Excel 变更计划、脚本迭代、格子级 diff 和最终 review。
- macOS 真实 Seatbelt 测试。
- Windows policy 契约测试、打包 runner probe/config dry-run、可用主机上的 BaseContainer 执行。
- 数据库迁移 golden schema。

## 9. 可继续提升的点

这些不是当前闭环的前置条件，按收益排序：

1. **真实 Windows 设备矩阵**：固定验证 Win11 24H2、25H2、x64/arm64 的 probe、原生库、网络、路径逃逸、进程树终止和安装包升级。
2. **CPU/内存硬限制**：macOS 增加独立 helper 与 RLIMIT/watchdog；Windows 等 MXC 暴露稳定资源限制后接入。现阶段只有时间、输出和磁盘增量限制。
3. **DOCX/PPTX 结构 diff**：增加段落、表格、幻灯片、图表和媒体关系差异，避免只看二进制 hash。
4. **大目录增量索引**：文件 watcher、游标分页、后台限速 fingerprint、显式重建索引和可选全文索引。
5. **输出目录去重物化**：`outputs/` 当前是短期明文副本；可改为只保存 manifest，并在用户预览时按需从 CAS 物化。
6. **沙箱诊断页**：设置页展示当前 OS 后端、MXC tier、动态脚本是否可用和明确原因，避免用户首次执行时才发现能力不足。
7. **可选强隔离后端**：对企业高风险场景提供用户自选的本地 VM/企业 BYOC microVM，不改变默认本地处理路线。

## 10. 不采用的方向

- 不把 prompt、路径字符串检查或 Python monkey-patch 单独称为沙箱。
- 不在 Windows BaseContainer 不可用时静默退回普通 Python、DACL 修改或不受控 Shell。
- 不让模型直接拿用户文件夹绝对路径自由读写。
- 不要求所有二进制都做伪语义 diff；未知格式使用 hash 证据。
- 不把 Docker/E2B 设为桌面端默认依赖。
