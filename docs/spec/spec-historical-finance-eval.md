# 历史财务工作流评测集

## 目标

将用户在 Codex 桌面端完成过的真实财务任务转为可重复的评测，验证 Pi Agent 是否能完整、准确、可复核地完成真实财务工作流。工具调用数和步骤数只作为诊断指标，不得为了减少调用牺牲质量。

脱敏 manifest 会提交到仓库；用户授权的原始工作簿、文档和图片放在被 `.gitignore` 忽略的 `tests/history-eval/real-fixtures/` 中，真实输出放在被忽略的 `tests/history-eval/real-reports/` 中。每个样例保留：任务意图、真实附件映射、等价的合成输入、质量验收断言、历史会话的工具调用基线。

## 评测对象

来源为用户明确提供的 7 个 Codex 会话：

| Case | 历史任务 | 历史工具调用基线 |
| --- | --- | ---: |
| HISTORY-001 | 母子公司 Q2 报表数据誊抄与列保护 | 78 |
| HISTORY-002 | 母子公司合并报表与现金流抵消 | 85 |
| HISTORY-003 | 个人所得税计算与 Excel 公式 | 34 |
| HISTORY-004 | 事务费/工资费/管理费限额公式 | 44 |
| HISTORY-005 | 根据 Excel 回答正式业务问题并写回文档 | 24 |
| HISTORY-006 | 多 Sheet 财务报表分析 | 101 |
| HISTORY-007 | 子公司研发、固定资产、营收预测 | 41 |

基线是对应会话中实际记录的工具调用总量，包含用户补充要求后的返工与复核，因此它代表“完成整个真实任务链”的成本，而不是单轮理想路径。

## 评分

- `qualityScore`：关键数字、公式/口径、交付状态、风险说明和用户要求的保留项；真实模式再由 LLM judge 复核。
- 质量门槛：所有样例质量达标后，才允许讨论效率收益。
- `toolReduction`：`1 - currentToolCalls / historicalToolCalls`，仅作诊断指标。
- `stepReduction`：当前 Agent 产生的工具事件轮次与历史工具调用基线的相对减少，仅作诊断指标。
- 质量不达标时，即使调用更少，也明确判定为失败。
- `SKIP_LLM=true` 只验证工具与关键词断言；真实评测需配置模型并由 judge 复核质量。

## 使用

```bash
npm run eval:history
HISTORY_REAL_FIXTURES=true npm run eval:history
HISTORY_CASE_ID=HISTORY-002,HISTORY-003 npm run eval:history
```

该评测集用于发现真实质量问题：交付物缺失、公式丢失、现金流抵消遗漏、列被误改或没有解释数据来源，均视为质量失败。报告中的工具调用下降不能抵消任何一项质量失败。

## Harness 决策与实施

本次评测暴露的不是 Pi 缺少 Agent Loop。Pi 已经负责模型调用、工具调用、工具结果回传、会话、压缩和事件；它的定位是可嵌入、可扩展的 Agent runtime/coding harness。Finwork 需要在其外层补充财务领域的完成语义。ReAct（reason/action/observation）描述 Pi 内部的工具循环，但不等于业务任务完成保证。

本项目的 Harness 分层如下：

```text
Pi Agent Loop
  → Finwork 工具与权限
  → TaskContract（完成条件）
  → verify（确定性验证与 CompletionEvidence）
  → repair（验证失败后的有限自动修复）
  → finalize（不可变交付与 CompletionGate）
  → Run settle / eval evidence
```

### 四个核心概念

- `TaskContract`：机器可检查的 Definition of Done，声明任务类型、必须交付的文件、表格要求和业务断言；模型不得覆盖。
- `verify`：读取工作文件并执行可重复的存在性、类型、可打开性、公式/重算/渲染和业务断言检查。验证结果必须产生事实证据，不能接受模型自报“已检查”。当前内置交付验证器在 `finalize_deliverable` 路径执行，并由 CompletionEvidence 记录。
- `repair`：验证失败后把失败原因反馈给同一个 Pi session，要求修改工作文件并再次定稿；当前评测允许最多 5 次，但这只是硬上限，不应作为默认重试目标。连续失败必须变成验证失败或等待用户，不能伪装成功。
- `finalize`：只在产物验证通过后复制到不可变 `delivered/`、记录 hash 和 CompletionEvidence，并由 CompletionGate 决定是否允许 Run completed。它不是普通文本回答。

### 本次实施

`runPiAgent` 现在对直接调用和 Query Pipeline 调用都取得有效 `TaskContract`；Pi 首轮 `stop` 后，如果合同要求交付物，Harness 会读取 CompletionGate。未通过时自动启动有上限的 repair 回合，要求模型修复并再次调用 `finalize_deliverable`。修复耗尽仍未通过时返回 `ValidationError`，而不是正常成功。

这条闭环优先保证质量，不以减少工具调用为目标。后续评测还必须记录 `terminationReason`、`numTurns`、验证结果、修复轮数和最终是否 finalize，以区分提前停止、验证失败、超时、取消和真正完成。

### Bash 与 Skill 接线修复

真实个税评测的首轮事件证明：Pi 已注册 `read/grep/find/ls/write/edit/bash`，模型也确实调用了 `bash`，但评测附件位于输出目录的兄弟目录，原 Bash 沙箱只允许 `path.dirname(outputDir)` 读取，导致模型复制附件到输出目录时被拒。修复后，附件所在目录作为显式只读根加入 Bash profile；写权限仍只有本回合输出目录。

命中 Excel 附件时，当前请求提示还会要求模型先读取 `xlsx` Skill，再使用受限 Bash 调用 Python/openpyxl/pandas 等通用工具，避免把 `run_python` 或专用 `export_tax_workbook` 当成前置依赖。全盘 `find /`、`find ~` 和 `find /Users...` 被 Bash 早期拦截，要求模型使用提示词提供的已知附件路径。

### 非目标

- 不把所有文本问答强制变成文件交付任务。
- 不用 LLM judge 替代确定性财务校验。
- 不通过无限重试或单纯增加超时掩盖模型、工具或输入问题。

## 真实评测记录：2026-08-03

### 执行方式

本次使用本机真实模型配置执行全部 7 个历史用例，7 个用例并行运行；每个用例设置 30 分钟硬预算，最多 5 轮 repair。真实 key 只从本机临时配置读取，不进入仓库。

```bash
FINANCE_AGENT_SETTINGS_PATH=/tmp/finwork-minimax-eval-settings.json \
HISTORY_REAL_FIXTURES=true \
HISTORY_TIMEOUT_MS=1800000 \
HISTORY_MAX_REPAIR_ROUNDS=5 \
npm run eval:history
```

单用例重跑：

```bash
FINANCE_AGENT_SETTINGS_PATH=/tmp/finwork-minimax-eval-settings.json \
HISTORY_REAL_FIXTURES=true \
HISTORY_CASE_ID=HISTORY-003 \
HISTORY_TIMEOUT_MS=1800000 \
HISTORY_MAX_REPAIR_ROUNDS=5 \
npm run eval:history
```

真实输入和输出目录已加入 `.gitignore`：`tests/history-eval/real-fixtures/`、`tests/history-eval/real-reports/`。提交前不得把其中的原始工作簿、文档、图片或模型配置加入 Git。

### 结果

质量门槛为 `0.75`，本次没有用例达标：

| Case | 状态 | 当前工具调用 / 历史基线 | qualityScore |
| --- | --- | ---: | ---: |
| HISTORY-001 | FAIL | 54 / 78 | 0.39 |
| HISTORY-002 | 超时未收敛 | — | — |
| HISTORY-003 | FAIL | 26 / 34 | 0.12 |
| HISTORY-004 | FAIL | 75 / 44 | 0.54 |
| HISTORY-005 | FAIL | 64 / 24 | 0.28 |
| HISTORY-006 | 超时未收敛 | — | — |
| HISTORY-007 | FAIL | 34 / 41 | 0.69 |

HISTORY-004 和 HISTORY-005 在 repair 后的调用量反而明显增加，说明当前 repair loop 会重复劳动，不能用“增加轮次”解决质量问题。HISTORY-002 和 HISTORY-006 超过 30 分钟仍未退出；本次已安全终止 runner，因此这两个用例没有被误记为成功。

### 诊断结论

1. Bash、文件读写和 Skill 接线已基本打通；工具不可用不再是唯一主因。
2. 模型能生成或修改中间文件，但缺少可靠的任务阶段和完成判定，容易在“分析—修改—再分析”之间循环。
3. 当前验证反馈过于粗粒度（例如只报告“缺少 workbook”），没有告诉模型缺少的具体文件、工作表、单元格、公式或业务断言。
4. 同一个长 Pi session 承担复杂分析、文件生成、校验和修复，容易上下文膨胀；H002/H006 的超时还暴露出 `session.abort()` 后 `waitForIdle()` 可能不返回，取消链路不完整。
5. LLM judge 只能辅助评分，不能替代工作簿可打开性、公式、重算值、勾稽关系和交付文件存在性等确定性校验。

### 后续修复顺序

1. 先修取消链路：为每次 `session.prompt()` 和 `session.waitForIdle()` 增加真正可超时的 `Promise.race`，超时后回收 session/子进程，并让 runner 能稳定记录 `TimeoutError`。
2. 将验证结果结构化为具体差异：缺少文件、实际文件、缺少 Sheet、公式/单元格错误、业务断言失败和建议动作。
3. 给 repair loop 增加无进展检测：相同错误连续出现两次或文件 hash 没有变化就停止；5 次只是上限，默认应为 1—2 次。
4. 将复杂任务拆成独立阶段或子 session：读取与规划、计算、生成文件、验证、交付分别传递结构化结果和文件路径。
5. 先只重跑 HISTORY-003 和 HISTORY-005，确认个税 Excel 与 Excel-to-DOCX 两种典型交付闭环达标，再恢复全部 7 个并行评测。

### 相关实现文件

- `lib/agent/pi/agent-service.ts`：TaskContract、CompletionGate、repair loop、超时和取消链路。
- `lib/agent/pi/builtin-tools.ts`：Pi 内置工具和 Bash 根目录接线。
- `lib/agent/tools/bash-sandbox.ts`：Bash 只读附件目录和输出目录写权限。
- `lib/agent/pi/extension.ts`：Bash 全盘探查拦截。
- `lib/agent/contracts.ts`：repair/verification 结果字段。
- `tests/history-eval/cases.ts`：7 个历史用例及质量标准。
- `tests/history-eval/run.ts`：真实 key 评测 runner、并行、30 分钟预算、5 轮上限和汇总指标。
- `tests/pi/bash-sandbox.mts`、`tests/pi/extension.mts`、`tests/pi/main-service.mts`：对应回归测试。

基础验证命令：

```bash
npm run typecheck
node --import tsx tests/history-eval/manifest.test.ts
node --import tsx tests/pi/bash-sandbox.mts
node --import tsx tests/pi/extension.mts
node --import tsx tests/pi/main-service.mts
git diff --check
```
