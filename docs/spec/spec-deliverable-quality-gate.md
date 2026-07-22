# Spec：通用交付物质量门与不可变交付

> ID：CR-Q1  
> 状态：Blocked — 等待 CR-R0 与 CR-S1  
> 日期：2026-07-21  
> 前置依赖：CR-R0、CR-S1  
> 下游：CR-Q2、CR-R2

## Problem Statement

当前 `finalize_deliverable` 只把模型提供的文件名写入 marker，不检查文件存在、路径、类型、可打开性、公式重算或业务质量。未完成回合生成的文件也可能作为普通附件出现。因此模型可以用文字和文件名制造虚假成功。

## Solution

新增 deliverable registry、validator registry 和 CompletionEvidence。文件必须经过系统确定的 Profile 验证，并原子复制到模型不可写的 `delivered/` 区域后，才能成为正式附件。RunStore 通过 CR-R0 CompletionGate 决定完成状态。

## User Stories

1. 作为用户，我希望不存在或损坏的文件不能显示为已交付。
2. 作为用户，我希望验证失败的文件明确显示为工作文件。
3. 作为安全负责人，我希望模型无法通过改文件名或修改已验证文件绕过检查。
4. 作为领域 validator，我希望复用统一的文件、重算、渲染和不可变交付机制。
5. 作为 RunStore，我希望只接收可验证的完成证据。

## Implementation Decisions

### 1. Deliverable State

```text
working → candidate → validating → validated → delivered
                              └→ validation_failed
```

registry 记录：

```text
id, run_id, contract_deliverable_id,
working_path, delivered_path,
file_name, mime_type, size_bytes,
working_sha256, delivered_sha256,
validator_id, quality_profile,
validation_report_json,
status, created_at, validated_at, delivered_at
```

- 新生成文件默认为 working/candidate。
- 未验证文件不是正式 assistant attachment。
- 历史 marker 可继续用于展示历史附件，但不能作为新 Run 的质量证明。

### 2. Validator Registry

```ts
type ValidatorResult = {
  status: "passed" | "failed";
  validatorId: string;
  fileSha256: string;
  errors: Array<{ code: string; message: string; location?: string }>;
  warnings: Array<{ code: string; message: string; location?: string }>;
  evidence: Record<string, unknown>;
};
```

- validator 由 MIME + TaskContract qualityProfile 选择。
- 模型不能传 `kind=other` 或降低 Profile。
- validator report 与候选文件 hash 绑定；文件变化立即失效。
- 错误码稳定、人话可本地化。

### 3. Generic File Gate

所有文件必须检查：

- 路径在 Run output scope 内。
- 规范化路径无 traversal、symlink escape。
- 文件存在、非目录、大小非零。
- 内容签名、MIME 与允许交付类型一致。
- 对应解析器可打开。
- TaskContract 所需数量和 MIME 全部满足。

Office 文件额外检查：

- 使用 CR-S1 Runtime 重算（如 requirement 需要）。
- 渲染可见页面或 sheet。
- 解析后无结构损坏。
- 公式错误类型单元格失败。
- Profile 必需公式缓存为空时失败；其他合法空公式只 warning。

### 4. Immutable Delivered Copy

验证通过后：

1. 关闭工作文件写句柄。
2. 原子复制/移动到 Run 专属 `delivered/` 区域。
3. `run_python`、Write/Edit 和后续模型工具无该目录写权限。
4. 对 delivered 副本重新计算 SHA-256 和 MIME。
5. 在同一 DB 事务写 registry、正式附件和 CompletionEvidence。
6. 任一步失败则不产生 delivered 状态。

正式附件只指向不可变副本，关闭校验后修改的 TOCTOU 窗口。

### 5. Finalize Contract

```ts
type FinalizeFile = {
  name: string;
  contractDeliverableId: string;
};
```

- expectations、Profile、MIME 和数量来自 TaskContract。
- finalize 不接受覆盖字段。
- 不存在的 contractDeliverableId 失败。
- 所有 required deliverables 通过后才提交 CompletionEvidence。
- validation failed 时保留工作文件和报告，不清理中间材料。

### 6. Completion Ownership

- 本包不直接写 Run `completed`。
- 本包提交 CR-R0 的 CompletionEvidence。
- RunStore CompletionGate 同时核对模型回合结束、TaskContract 和全部 Evidence。
- 纯文本任务由 TaskContract 标记 qualityStatus=not_applicable，不伪造文件 Evidence。

### 7. UI Contract

附件状态至少包括：

- 工作文件/未验证。
- 验证中。
- 验证失败，可查看报告。
- 已验证正式交付。

CR-R2 负责把这些状态接入权威 Run 完成态；本包只提供数据和组件接口。

## File Ownership

允许：

- deliverable migration/store。
- validator registry 与通用 validator。
- finalize tool。
- generated file cleanup/attachment registration。
- 文件状态展示组件的数据合同。

禁止：

- RunStore 终态写入。
- Spreadsheet Runtime/recalc 实现。
- 合并报表领域断言。
- SSE/replay/resume。

## Testing Decisions

- 不存在文件、空文件、目录、路径穿越、symlink escape。
- MIME 欺骗与扩展名不一致。
- parser open failure。
- 旧 validation hash 被拒。
- 验证后工作文件被修改不影响 delivered 副本。
- DB/文件原子事务失败不产生半 delivered。
- incomplete Run 工作文件不成为正式附件。
- TaskContract 缺一个 required deliverable 时 CompletionEvidence 不齐。

使用临时目录和 fixture，测试外部行为，不依赖 validator 内部实现细节。

## Acceptance Criteria

1. 模型无法声明不存在、目录外或类型伪装文件。
2. validation report 与候选 hash 绑定。
3. 正式附件只指向不可变 delivered 副本。
4. 未验证和失败文件不显示为正式交付。
5. finalize 无法降低 TaskContract Profile。
6. 本包只提交 Evidence，不直接完成 Run。
7. 定向工具/DB/文件测试、typecheck 和 lint 通过。

## Out of Scope

- 合并报表财务勾稽。
- Run 状态恢复 UI。
- Managed LibreOffice。
- 完整病毒扫描或 DLP。

## Further Notes

CR-Q2 通过 validator registry 注册领域 Profile，不应修改 finalize 或复制 delivered 流程。

