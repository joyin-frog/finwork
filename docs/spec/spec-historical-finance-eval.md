# 历史财务工作流评测集

## 目标

将用户在 Codex 桌面端完成过的真实财务任务转为可重复的评测，验证 Pi Agent 是否能完整、准确、可复核地完成真实财务工作流。工具调用数和步骤数只作为诊断指标，不得为了减少调用牺牲质量。

脱敏 manifest 会提交到仓库；用户授权的原始工作簿、文档和图片放在主 checkout 下被 `.gitignore` 忽略的 `real-fixtures/` 中，真实输出放在当前 worktree 被忽略的 `tests/history-eval/real-reports/<batch>/<case>/<runId>/` 中。每个样例保留：任务意图、真实附件映射、等价的合成输入、显式交付合同、产物级质量断言和历史会话的工具调用基线。

真实附件的 SHA-256 冻结在 manifest 中。Runner 在启动 Agent 前同时检查“存在性 + hash”；缺文件或文件曾被历史会话原地写回时直接报 `fixture_integrity_failed`，禁止把带答案的附件作为输入。HISTORY-004/HISTORY-005 已从原始接收目录恢复为写入前版本。

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

评分对象是不可变 `delivered/` 中的实际 XLSX/DOCX，而不是 Agent 最后一段回复。

- 硬门：Run 未超时/取消、显式 `TaskContract` 所需文件数量与 MIME 齐全、文件可解析、公式无错误、CompletionEvidence 通过。硬门失败时 `qualityScore=null`，直接 FAIL。
- `deterministicScore`：逐 Case 的关键数字、公式数量、工作表、业务主题和文档完整性断言。任一 critical assertion 失败即 FAIL。
- `judgeScore`：LLM 只评价难以确定性编码的完整性、正式程度、可追溯性和风险说明；它读取产物摘录，不读取工具调用次数。Judge 同时返回 `blocking`，重大业务矛盾、违反核心约束或无依据精确数字会直接 FAIL，不能再被 85% 的浅层确定性分稀释。
- `qualityScore = deterministicScore × 0.85 + judgeScore × 0.15`；默认门槛为 `0.85`。`SKIP_LLM=true` 时只使用 deterministicScore。
- 真实模式的 judge 不可用时不得静默换一套评分尺度：记录 `semanticStatus=unavailable` 并 FAIL。
- 质量门槛：所有样例质量达标后，才允许讨论效率收益。
- `toolReduction`：`1 - currentToolCalls / historicalToolCalls`，仅作诊断指标。
- `stepReduction`：当前 Agent 产生的工具事件轮次与历史工具调用基线的相对减少，仅作诊断指标。
- 质量不达标时，即使调用更少，也明确判定为失败。
- 工具名称、是否使用 Bash/Python、回复关键词均不参与质量分。

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
- `repair`：验证失败后把失败原因反馈给同一个 Pi session，要求修改工作文件并再次定稿；当前评测默认最多 2 次，这只是硬上限，不应作为默认重试目标。连续失败必须变成验证失败或等待用户，不能伪装成功。
- `finalize`：只在产物验证通过后复制到不可变 `delivered/<sha256>/`、记录 hash 和 CompletionEvidence，并由 CompletionGate 决定是否允许 Run completed。同名文件在 repair 后再次定稿会产生新的内容寻址版本，不覆盖旧证据。它不是普通文本回答。

### 本次实施

`runPiAgent` 现在对直接调用和 Query Pipeline 调用都取得有效 `TaskContract`；历史 Case 显式声明合同，不再从输入附件猜输出类型。Pi 首轮 `stop` 后，Harness 先读取 CompletionGate，再执行调用方提供的任务级确定性断言。未通过时把具体文件、验证错误和断言差异反馈给同一个 session，要求修改后再次 `finalize_deliverable`。修复耗尽或连续两次验证指纹（错误 + 文件 hash）不变时返回 `ValidationError`，而不是正常成功。

每次 `session.prompt()` 和 `session.waitForIdle()` 都与内部 abort signal 竞争，硬超时或外部取消后不再无限等待 SDK idle。评测记录 `terminationReason`、`numTurns`、验证结果、修复轮数、`repairStopReason` 和最终是否 finalize，以区分提前停止、验证失败、无进展、超时、取消和真正完成。

Case 合同中的关键差异：

- HISTORY-005 要求 DOCX，而不是因为输入含 Excel 就误要求 workbook。
- HISTORY-007 同时要求预测 XLSX 和说明 DOCX。
- HISTORY-002/HISTORY-006 使用 `financial_consolidation` profile，要求重算与渲染。
- HISTORY-003 使用 Codex 写入前的备份工作簿作为输入，避免把参考答案喂给被测 Agent；任务文本同时复现历史会话中用户已确认的计算口径，不能只截取首轮提问后把合理的澄清行为算失败。真实模式冻结抽查 `Sheet1!H5=940`、`H10=140`、`H18=340`，从而拦住“把年度专项附加扣除先按月扣除再乘 12”的语义错误。

### Bash 与 Skill 接线修复

真实个税评测的首轮事件证明：Pi 已注册 `read/grep/find/ls/write/edit/bash`，模型也确实调用了 `bash`，但评测附件位于输出目录的兄弟目录，原 Bash 沙箱只允许 `path.dirname(outputDir)` 读取，导致模型复制附件到输出目录时被拒。修复后，附件所在目录作为显式只读根加入 Bash profile；写权限仍只有本回合输出目录。`read_document` 同样显式接收本回合输出根，并对文件和根执行 `realpath` 后校验，既能读取隔离评测附件，又不会通过 symlink 越界。

命中 Excel 附件时，当前请求提示还会要求模型先读取 `xlsx` Skill，再使用受限 Bash 调用 Python/openpyxl/pandas 等通用工具，避免把 `run_python` 或专用 `export_tax_workbook` 当成前置依赖。全盘 `find /`、`find ~` 和 `find /Users...` 被 Bash 早期拦截，要求模型使用提示词提供的已知附件路径。

模型侧 Bash 的 `PATH` 必须同时保留 Finwork 启动进程和 Pi 注入的路径；否则测试进程已配置的受控 Python/LibreOffice 会在工具里变成“未安装”。工作簿重算直接使用隔离 LibreOffice profile 的 `convert-to xlsx` 路径；不能先调用并不存在的用户宏 `Standard.Module1.RecalculateAndSave`，该调用会挂满 60 秒并让交付工具在真正重算前超时。

### 非目标

- 不把所有文本问答强制变成文件交付任务。
- 不用 LLM judge 替代确定性财务校验。
- 不通过无限重试或单纯增加超时掩盖模型、工具或输入问题。

## 真实评测记录：2026-08-03

### 执行方式

修复前的旧记录曾使用本机真实模型配置并行执行全部 7 个历史用例；修复后的正式回放改为串行执行，每个用例设置 30 分钟硬预算，最多 2 轮 repair。真实 key 只从本机临时配置读取，不进入仓库。

```bash
FINANCE_AGENT_SETTINGS_PATH=/tmp/finwork-minimax-eval-settings.json \
HISTORY_FIXTURE_ROOT=/Users/gyro/codex/finance-agent-public/real-fixtures \
HISTORY_REAL_FIXTURES=true \
HISTORY_TIMEOUT_MS=1800000 \
HISTORY_MAX_REPAIR_ROUNDS=2 \
HISTORY_CONCURRENCY=1 \
npm run eval:history
```

单用例重跑：

```bash
FINANCE_AGENT_SETTINGS_PATH=/tmp/finwork-minimax-eval-settings.json \
HISTORY_FIXTURE_ROOT=/Users/gyro/codex/finance-agent-public/real-fixtures \
HISTORY_REAL_FIXTURES=true \
HISTORY_CASE_ID=HISTORY-003 \
HISTORY_TIMEOUT_MS=1800000 \
HISTORY_MAX_REPAIR_ROUNDS=2 \
npm run eval:history
```

真实输入和输出目录已加入 `.gitignore`：`real-fixtures/`、`tests/history-eval/real-reports/`。提交前不得把其中的原始工作簿、文档、图片或模型配置加入 Git。

真实 fixture 放在仓库主根目录的共享路径，供不同 worktree 复用：

```text
/Users/gyro/codex/finance-agent-public/real-fixtures/
```

从 Codex worktree 运行时必须显式指定该路径，并把输出写入当前 worktree：

```bash
HISTORY_FIXTURE_ROOT=/Users/gyro/codex/finance-agent-public/real-fixtures \
HISTORY_REAL_FIXTURES=true \
npm run eval:history
```

### 结果

以下是旧评分器（工具名 + 回复关键词 + 看不到产物的 LLM judge）的历史记录，仅用于保留故障现场，不能再作为 Agent 能力结论：

| Case | 状态 | 当前工具调用 / 历史基线 | qualityScore |
| --- | --- | ---: | ---: |
| HISTORY-001 | FAIL | 54 / 78 | 0.39 |
| HISTORY-002 | 超时未收敛 | — | — |
| HISTORY-003 | FAIL | 26 / 34 | 0.12 |
| HISTORY-004 | FAIL | 75 / 44 | 0.54 |
| HISTORY-005 | FAIL | 64 / 24 | 0.28 |
| HISTORY-006 | 超时未收敛 | — | — |
| HISTORY-007 | FAIL | 34 / 41 | 0.69 |

修复评分器、合同、Skill 接线、交付质量门和运行隔离后，使用真实附件和同一 MiniMax 模型串行重跑。随后又按 Codex 会话参考产物逐个复核，发现首轮新评分器仍存在“浅层确定性断言拿满分后压过 judge 重大异议”的系统性虚高。下表以二次审计结论为准；旧 `summary.json` 保留故障现场，不再作为能力结论：

| Case | 状态 | 工具调用 / 历史基线 | deterministic | judge | quality |
| --- | --- | ---: | ---: | ---: | ---: |
| HISTORY-001 | PASS（核心结果可信） | 29 / 78 | 1.00 | 0.45 | 0.9175 |
| HISTORY-002 | FAIL（关键合并数不一致） | 77 / 85 | 0.5000 | 0.35 | — |
| HISTORY-003 | PASS（核心结果可信，空白样式区缩短） | 19 / 34 | 1.00 | 0.55 | 0.9325 |
| HISTORY-004 | FAIL（费用类别/单位错误且工资公式缺失） | 20 / 44 | 旧 1.00 | 0.35 | 旧分无效 |
| HISTORY-005 | FAIL（正式回复存在未解释的数值和时间线矛盾） | 59 / 24 | 旧 1.00 | 0.82 | 旧分无效 |
| HISTORY-006 | FAIL（内部往来未正确抵消） | 68 / 101 | 0.5833 | 0.35 | — |
| HISTORY-007 | FAIL（生产线启动年份违反协议触发条件） | 29 / 41 | 旧 1.00 | 0.82 | 旧分无效 |

二次审计后，当前可确认通过的是 `HISTORY-001` 和 `HISTORY-003`，可信通过率为 `2 / 7 = 28.6%`。这不等于其余任务的运行链路全部失败：HISTORY-002/HISTORY-006 已从技术性超时收敛为可复现的业务差异，HISTORY-004/005/007 也都实际生成了可打开文件；但“生成了文件”不能代替核心业务正确性。旧 `5 / 7` 和平均质量分 `0.9397` 均不得再引用。

本次产物级证据包括：

- HISTORY-001：7 个 Sheet、1,183 个公式、8 个冻结关键单元格全部一致；只允许写入的 P 列发生 43 处变化，其他列 0 处变化。
- HISTORY-003：冻结值 `Sheet1!H5=940`、`H10=140`、`H18=340` 均正确，98 个公式覆盖全部 14 名员工；与写入前附件比较，95 处值/公式变化全部位于允许的 H:M，A:G 无越界变化。候选将原模板延伸到第 189 行的空白样式区缩到第 36 行，但没有删除第 37 行后的业务数据（原表该区本就无值/公式），因此不应误判为数据丢失。现保留 A:G allowlist 保护，后续若要严格保护空白样式需另加样式差异断言。
- HISTORY-004：候选虽有 6 个公式，但 `C7`/`D7` 的研制类和技术类比例写反，公式按元使用 `500000` 分档而模板/参考口径为万元 `50` 分档，`C10:E10` 工资公式缺失。现冻结事务费和工资费关键公式单元格，不能再用“公式数 ≥ 4”放行。
- HISTORY-005：文档可打开、结构完整，但前五大客户 592.18 万元被写成 Q1 收入的 116.2%、Q4 利润率同时出现 33.8%/32%、回款比 1.04 无口径说明，且后续月份事项混入 Q1 事实。现把重大数值矛盾、时间线错置和无来源精确数字列为语义硬门。
- HISTORY-007：repair 后生成 5 个 Sheet、81 个公式且版式可读，但母公司 2026E/2027E 收入分别约 1.33/1.86 亿元，均未达到协议 2 亿元触发线，候选却写“2027 启动、2028 建成”。这不是风险披露不足，而是核心协议条件冲突，现列为语义硬门。
- HISTORY-002：修复后候选可以重算、2,914 个公式无错误，但资产总计 `134,678,840.67`、负债权益 `130,663,007.15`，差 `4,015,833.52`；期末现金为 0，且利润与参考结果不一致。Codex 参考产物冻结值为资产/负债权益均 `133,213,633.47`、期末现金 `18,299,442.55`。
- HISTORY-006：修复后候选可以重算、2,915 个公式无错误，但资产总计 `157,855,047.58`、负债权益 `176,555,047.58`，正好差 `18,700,000`；其他应收款与其他应付款的内部借款抵消方向没有进入 TB 审定数。Codex 参考产物冻结值为资产/负债权益均 `139,155,047.58`。

旧回放中 HISTORY-004 和 HISTORY-005 在 repair 后的调用量反而明显增加，说明 repair loop 会重复劳动，不能用“增加轮次”解决质量问题。旧 HISTORY-002/HISTORY-006 超过 30 分钟仍未退出；修复后虽然不再超时，但也证明“能 finalize、公式无错误”仍不等于合并报表业务正确。

### 2026-08-03 真实重跑记录

为验证上述结论，使用 `/Users/gyro/codex/finance-agent-public/real-fixtures` 和同一 MiniMax 配置串行重跑 7 个 Case。报告保存在 `tests/history-eval/real-reports/` 下对应的 run 目录；本次把超时、评分器不可用和业务失败分开记录：

| Case | 运行结果 | 确定性断言 | judge / 质量 | 工具调用 | 主要结论 |
|---|---|---:|---:|---:|---|
| HISTORY-001 | FAIL（真实业务问题） | 1.00 | 0.42 / 0.913 | 26 / 78 | P23 等关键净值被硬编码，且折旧/平均余额口径不保留；不是评分虚高。 |
| HISTORY-002 | TIMEOUT（无 result.json） | — | — | — | 超过 30 分钟仍卡在合并报表分析，外层停止未能可靠中断 SDK 调用。 |
| HISTORY-003 | PASS（修正 judge 后） | 1.00 | 0.75 / 0.9625 | 25 / 34 | 关键值、公式和 A:G 保护均通过；剩余问题是税率/速算扣除列部分硬编码，属于可追溯性改进。 |
| HISTORY-004 | TIMEOUT / 无交付 | 0 | — | 75 / 44 | 19 页 PDF 被逐页 OCR，最终没有 XLSX；主要是输入摄取和预算控制问题。 |
| HISTORY-005 | FAIL（真实语义问题） | 1.00 | 0.45 / 0.9175 | 41 / 24 | Q1/Q4 时间线、33.8%/32%利润率和 2066.39/2066.77 等口径矛盾未解释。 |
| HISTORY-006 | TIMEOUT / 无交付 | 0 | — | 92 / 101 | 长时间映射合并模板，LibreOffice 失败后未能定稿。 |
| HISTORY-007 | 产物通过，judge 不可用 | 1.00 | unavailable | 45 / 41 | XLSX/DOCX、99 公式、结构断言均通过；本次 judge 没有返回，不能据此判能力失败。文档已把 2028 达线、2029 投产写清。 |

HISTORY-003 的第一次重跑曾被旧 judge 以“摘录不足、无法完全排除风险”为 blocking，修正后的规则已明确：缺少摘录或可追溯性建议不能单独阻断确定性断言已通过的产物；补跑后该 Case PASS。HISTORY-007 则暴露了另一类 harness 问题：`semanticStatus=unavailable` 时当前实现直接把 Run 标成失败，应该改成 `needs_review`，而不是与真实业务失败混同。

修复后的首轮抽样还发现两项必须作废旧分数的边界：

- HISTORY-003 首次产物虽然含 103 个公式、确定性文本断言为 1.00，但原生工作簿预览中的个税缓存值仍为 0；因此该次 `quality=0.92` 无效。HISTORY-003/HISTORY-001 的合同现强制 LibreOffice 重算和渲染，不能以“打开 Excel 后可能自动算”为完成证据。
- HISTORY-005 在干净的写入前 Word 上独立生成了 4,877 字正式回复，DOCX 可解析、原生 Quick Look 版式正常、全部产物断言通过；但一次中途模型 `terminated` 被 `lastAssistantError` 在后续成功 stop/finalize 后重新翻出，误判为 Run 失败。settle 现只读取最后一条 assistant 结束态，早期 transient error 只有在未被成功 repair 覆盖时才失败。

HISTORY-003 的后续故障还进一步区分了三类问题：第一，旧真实任务只保留历史会话首句，漏掉用户随后确认的“G 列为年度扣除”口径，导致谨慎询问被误判为无进展；第二，模型曾把 G 列当月度数，生成 `0` 而不是仲梁 `140`、洪益佳 `340`，说明“含公式/含表头”不足以证明业务正确；第三，Finwork 的 LibreOffice 路径虽在父进程可用，却被 Pi 的 `PATH` 覆盖，而且旧重算入口调用不存在的用户宏导致固定 60 秒超时。三项均已加入任务输入、确定性值断言和运行时回归路径。

原始夹具审计同时确认：HISTORY-004/HISTORY-005 的旧共享夹具分别含历史公式和完整回复正文，属于答案污染。两份文件已从原始接收目录恢复为 0 公式模板和只含 5 个问题的 Word，并将全部 Case 输入 hash 冻结在 manifest 中。

### Codex 会话对照与 LibreOffice 结论

用户提供的 Codex 会话 `019f832e-76ef-7573-9645-502499650c2c` 可作为历史任务意图、用户确认口径、期望结果和返工边界的参考，但不作为被测 Agent 可读取的答案。该会话实际读取了 Spreadsheets Skill，并使用 `@oai/artifact-tool` 完成工作簿导入、检查、渲染和导出；它没有把 LibreOffice 当成“写 Excel”的前置条件。

因此，“没有 LibreOffice 就写不了 Excel”本身是错误约束：

- XLSX 写入可由 openpyxl、ExcelJS 或 artifact-tool 完成。
- LibreOffice 在当前 Finwork 中承担的是无头公式重算、缓存刷新、原生渲染和交付前验证；只有合同要求这些能力时才是完成门槛。
- 旧 xlsx Skill 把写入和 LibreOffice 混在一起，促使模型反复探测 `soffice`、直接调用不存在的宏，甚至尝试手工模拟公式缓存；现已改为“先用 openpyxl 写入并静态检查，再立即调用 `finalize_deliverable`，由 Finwork 统一完成所需重算/渲染”。
- 旧 docx Skill 还要求运行时 `npm install -g docx`，与实际预装的 `python-docx` 环境冲突；现已移除运行时安装路径。

这也说明 Codex 与当前 Finwork/MiniMax 不是完全同条件比较：Codex 会话使用更强模型和 artifact-tool 的结构化电子表格能力；Finwork 目前只有 openpyxl/pandas 加统一质量门。Codex 会话适合做 golden intent/evidence，不能把工具栈差距全记到模型分数上。

### 本次定位到的 Finwork 实现问题

1. Pi 的相对 `read/write/edit` 路径曾错误地相对进程 cwd 解析，而不是本轮只读/写根，导致模型明明给出正确相对路径仍写错位置。
2. LibreOffice 路径被 Pi 注入的 `PATH` 覆盖，旧入口还调用不存在的用户宏，固定浪费 60 秒。
3. `finalize_deliverable` 曾只返回“存在公式错误”，不带 `Sheet!Cell`，HISTORY-006 无法定点修复；现返回错误码、位置和消息。
4. Excel 验证曾只抽样公式，无法发现采样窗口外的 `#NAME?/#VALUE!/#REF!`；现扫描全部公式并返回完整计数和前 100 个错误位置。
5. 旧质量门只证明“可以渲染”，没有检查渲染后的可读性；现对需要渲染的任务拦截窄列长文本导致的巨高行/竖排字。
6. 历史 runner 曾复用目录、并行污染文件、缺少 fixture hash 和独立不可变交付路径；现按 batch/case/run 隔离、启动前校验 hash、串行默认并设置硬超时。
7. 重算后曾把 IF/空白模板行合法产生的空字符串当成“无公式缓存”，导致已经被 LibreOffice 重算的工作簿仍失败；现仅在全部公式均无缓存时判重算失败，部分合法空结果记录 warning。
8. 沙箱中的输入附件为只读；模型使用 `shutil.copy/copy2` 会把 `0444` 权限复制到输出并在每次脚本执行时重新覆盖。XLSX Skill 与请求提示现要求从只读源加载并保存到新文件，或使用 `copyfile + chmod(0o600)`。
9. MiniMax-M3 的单次输出上限当前按 8,192 token 注册，HISTORY-002/HISTORY-006 都出现过 `stopReason=length`；HISTORY-002 还在 8 分钟内因大段模板 dump 把上下文推到约 196k token。Skill 现要求大型脚本分段写入，但长期方案仍应是有界的结构化 spreadsheet inspect/patch 工具，而不是让模型生成上万 token 的 Python 数据映射。

上述问题解释了旧超时和额外工具调用。修复后 HISTORY-002/HISTORY-006 已能在硬预算内交付，但冻结配平、利润和现金流单元格仍失败；后两者主要剩下的是复杂财务合并任务的长链规划、批量公式生成和抵消方向判断能力不足。这是当前模型 + 工具抽象共同的能力缺口，不能继续通过放宽评分或无限增加 repair 隐藏。

### 诊断结论

1. 评分器现在能区分产物正确、视觉不可用、合同未完成和真正超时；旧分数已不具备比较价值。
2. Bash、相对文件路径、Skill、重算、取消和验证反馈中的 Finwork 问题已修复并有回归覆盖；工具不可用不再是唯一主因。
3. 当前模型能稳定完成誊抄、个税、限额公式、Excel-to-DOCX 和中等规模预测，但复杂合并/多表分析仍容易在“分析—修改—再分析”之间循环。
4. 同一个长 Pi session 承担复杂分析、文件生成、校验和修复时仍会上下文膨胀；H002/H006 需要更高层的工作分解或更结构化的 spreadsheet tool，而不是单纯提高 repair 次数。
5. LLM judge 只能辅助评分，不能替代工作簿可打开性、公式、重算值、差异边界、勾稽关系、可读版式和交付文件存在性等确定性校验。

### 重跑顺序

1. 串行重跑 HISTORY-003 和 HISTORY-005，检查 Excel 公式闭环和 Excel-to-DOCX 合同。
2. 串行重跑 HISTORY-001、HISTORY-004、HISTORY-007。
3. 最后重跑需要 LibreOffice 重算/渲染的 HISTORY-002、HISTORY-006。
4. 单次全量稳定后，每个 Case 至少重复 3 次，分别报告通过率、确定性得分、语义得分、时长和工具调用，不用一次偶然结果代表 Agent 能力。

### 相关实现文件

- `lib/agent/pi/agent-service.ts`：TaskContract、CompletionGate、repair loop、超时和取消链路。
- `lib/agent/pi/builtin-tools.ts`：Pi 内置工具和 Bash 根目录接线。
- `lib/agent/tools/bash-sandbox.ts`：Bash 只读附件目录和输出目录写权限。
- `lib/agent/pi/extension.ts`：Bash 全盘探查拦截。
- `lib/agent/contracts.ts`：repair/verification 结果字段。
- `tests/history-eval/cases.ts`：7 个历史用例及质量标准。
- `tests/history-eval/scoring.ts`：交付物解析、合同检查、确定性断言和 judge 产物摘要。
- `tests/history-eval/run.ts`：真实 key runner、隔离输出、fail-fast fixture、可配置串并行、硬超时和汇总指标。
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
