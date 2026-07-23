# Spec：Spreadsheet Runtime 依赖与任务前置检查

> ID：CR-S1  
> 状态：Runtime Core 已ship（Batch 0）· `audit-spreadsheet-runtime-preflight.md`；TaskContract 接线等待 CR-R0  
> 日期：2026-07-21  
> 前置依赖：CR-R0 的 SpreadsheetRequirement 扩展点  
> 下游：CR-Q1、CR-Q2  
> v1 决策：Python 依赖随包；LibreOffice 使用系统安装 + 强 preflight

## Problem Statement

Finwork 当前 release 只准备裸 Python Runtime，用户侧首启仍需 pip；`xlrd` 缺失导致 `.xls` 无法读取，worker 却把 `.xls` 交给 openpyxl。公式重算只存在于 skill 脚本，真实应用中没有可执行的产品接口；skill 同时写“强制重算”和“没有 LibreOffice 就跳过”，导致 Agent 在任务中临时安装库、反复猜测环境并最终假交付。

## Solution

把 Spreadsheet 能力前移到模型执行之前：构建期预装并锁定 Python 包，提供真实 capability probe、`.xls` 路由、系统 LibreOffice resolver 及安装引导。公式型任务缺少重算能力时进入 `waiting_dependency`，不让模型自行兜底。

## User Stories

1. 作为用户，我希望旧 `.xls` 上传后能直接读取。
2. 作为用户，我希望缺少 LibreOffice 时在任务开始前得知，而不是十分钟后失败。
3. 作为用户，我希望安装依赖后能继续原任务。
4. 作为发布负责人，我希望基础表格能力断网可用。
5. 作为开发者，我希望 Agent 不再运行临时 pip 或寻找 Bash。

## Implementation Decisions

### 1. Pinned Python Runtime

基础依赖至少包含：

- `openpyxl==3.1.5`
- `pandas==2.2.3`
- `xlsxwriter==3.2.0`
- `xlrd==2.0.1`
- `Pillow==12.2.0`
- 当前 worker 已直接 import 的其余文档依赖

新增按平台/架构生成的 hash lock：

```text
runtime-lock/<platform>-<arch>.txt
```

- 使用受控脚本生成，全部版本固定。
- 使用 binary wheels，执行 `pip install --require-hashes`。
- 构建和设置页修复必须读取同一 lock。
- Runtime stamp 为 `pythonVersion + runtimeTag + sha256(platformLock)`。
- release job 在构建机安装 site-packages、运行 self-check，再归档完整 Runtime。
- 正常生产安装只解压，不联网 pip。
- 设置页“一键修复”只用于损坏或 stamp 不匹配。

### 2. Capability Contract

```ts
type Capability = {
  ok: boolean;
  version?: string;
  source?: string;
  errorCode?: string;
};

type SpreadsheetCapabilities = {
  python: Capability;
  packages: {
    openpyxl: Capability;
    pandas: Capability;
    xlsxwriter: Capability;
    xlrd: Capability;
  };
  read: { csv: boolean; xlsx: boolean; xlsm: boolean; xls: boolean };
  write: { xlsx: boolean; preserveXlsm: false };
  recalc: {
    ok: boolean;
    provider?: "system_libreoffice";
    executable?: string;
    version?: string;
  };
  render: { ok: boolean; provider?: "system_libreoffice" };
  problems: Array<{
    code: string;
    severity: "blocking" | "warning";
    remediation: "repair_python" | "install_libreoffice" | "none";
  }>;
};
```

Doctor API 返回完整 capability，而不是单一 `python.ok`。

### 3. Real Probe

Probe 必须运行行为 fixture，不只 import：

1. 用 `xlrd` 读取固定 `.xls` sheet/cell。
2. 用 openpyxl 读取和写入 `.xlsx`。
3. 若发现 LibreOffice，重算 `=SUM(A1:A2)` 并以 data-only 读取出 `3`。
4. 渲染一个可见 sheet，确认输出非空。

Probe 结果包含 provider 版本、耗时和稳定错误码。

### 4. LibreOffice Resolver v1

v1 只支持系统 LibreOffice：

- macOS：标准应用目录、用户应用目录、PATH。
- Windows：注册表、Program Files、PATH。
- Linux：PATH 和常见安装目录。

Resolver 返回绝对 executable，不允许业务代码直接调用字符串 `soffice`。

缺失时：

- 显示操作系统对应安装引导和“重新检测”。
- Run 进入 `waiting_dependency`。
- 不允许模型执行公式型生成/编辑。
- 用户安装后重新 probe，向 Run 层发布 dependency-ready。

Finwork 托管 LibreOffice 不属于本 Spec，由 `spike-managed-libreoffice-distribution.md` 决定后续是否立项。

### 5. Requirement Derivation

使用 CR-R0 的 `SpreadsheetRequirement`：

- 附件 `.xls`：`needsLegacyXlsRead=true`。
- 用户要求创建/编辑/合并工作簿：`needsWrite=true`。
- 输出含公式或需要读取最新公式结果：`needsRecalc=true`。
- 正式 Office 文件交付：`needsRender=true`。
- 输入 `.xlsm`：`needsMacroPreservation=true`。

附件规则是确定性的；动作意图由 Router 输出。合并后在模型执行前冻结到 TaskContract。歧义先询问用户。

### 6. Preflight Matrix

| Requirement | Required capability | Missing behavior |
|---|---|---|
| legacy xls read | `read.xls` | waiting_dependency / repair Python |
| xlsx write | `write.xlsx` | waiting_dependency / repair Python |
| recalc | `recalc.ok` | waiting_dependency / install LO |
| render | `render.ok` | waiting_dependency / install LO |
| macro preservation | v1 unsupported | 只读或确认另存 `.xlsx` |

- 无 LO 时可做静态只读分析，但必须提示公式缓存可能过期。
- 最终交付包含公式时不可降级。
- `.xlsm` v1 只读；编辑必须确认另存 `.xlsx`，不得声称保留 VBA/签名。

### 7. Runtime Commands

产品拥有以下确定性命令/服务：

```text
spreadsheet_runtime probe
spreadsheet_runtime inspect <file>
spreadsheet_runtime convert-xls <input> <output>
spreadsheet_runtime recalc <xlsx> --timeout <seconds>
spreadsheet_runtime render <xlsx> --outdir <dir>
```

本包拥有 probe、inspect、convert、recalc 和 render；不实现业务 validator。

重算要求：

- 独立临时 UserInstallation。
- 语言运行时原生 timeout，不依赖 `timeout/gtimeout`。
- 工作副本重算，上传文件不原地修改。
- timeout、非零退出、文件未更新均失败。
- 默认不更新外部链接、不允许网络。
- 返回输入/输出 hash、provider/version、公式数量和耗时。

### 8. Skill Update

Spreadsheet skill 删除：

- “没有 LibreOffice 就跳过”。
- 通过 Bash 执行 skill 脚本。
- 运行时临时安装公式计算库。

Skill 只描述何时调用产品工具，不再承担 Runtime。

## File Ownership

允许：

- Python Runtime lock/build/install/doctor。
- finance worker 与 spreadsheet runtime worker。
- LibreOffice resolver。
- Spreadsheet skill 中与工具使用相关的说明。
- capability API 和设置页依赖提示。

禁止：

- Run 状态、event persistence、resume UI。
- validator、deliverable registry、CompletionGate。
- Managed LibreOffice 下载/签名/更新。

## Testing Decisions

### Fixtures

- legacy input `.xls`。
- formula-ok `.xlsx`。
- named-range `.xlsx`。
- render-visible `.xlsx`。
- macro input `.xlsm`。

### Tests

- lock/stamp 一致性。
- 构建产物断网 self-check。
- `.xls` 不进入 openpyxl。
- resolver 优先级与绝对路径。
- recalc timeout 必须失败。
- 输入文件 hash 不变。
- 两个并发重算不共享 profile。
- 缺 LO 的 preflight 在模型执行前阻断。

普通 PR CI 可在无 LO 时明确 skip 真实重算；release job 必须在支持平台运行真实 probe。

## Acceptance Criteria

1. 正式 Python Runtime 断网具备所有基础 Spreadsheet 包。
2. `.xls` fixture 可读取且错误路由已删除。
3. 公式型任务缺 LO 时不进入模型工具循环。
4. LO 存在时真实重算与渲染通过。
5. Agent 运行中不出现 pip、Bash 或 `soffice not found` 探索。
6. `.xlsm` 编辑不会被错误宣称为宏保留。
7. 定向测试、typecheck、lint 和 runtime smoke 通过。

## Out of Scope

- Managed LibreOffice。
- 业务财务勾稽。
- 完整 Excel 公式解释器。
- `.xlsm` 编辑和签名保留。
- Run 自动恢复实现。

## Further Notes

安装完成后恢复 Run 是 CR-R2 的职责；本包只发布新的 capability 结果。
