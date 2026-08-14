# 财务 Agent 外部评测接入

状态：已实现 Adapter、隔离物化、Production Benchmark Executor、零网络 preview、真实连接探针、断点 checkpoint、私有 Spreadsheet Oracle 与长期 soak 门禁。目标是“先接入，再吸取精华扩展本地专业用例”，不是用公开题目替代 Finwork 自己的交付物验证。真实运行操作以 [`benchmark-real-api-runbook.md`](../benchmark-real-api-runbook.md) 为准。

## 1. 底层闭环

```text
上游本地数据文件
  -> 数据集专属 Adapter
  -> NormalizedBenchmarkCase + 来源 SHA / 许可证状态
  -> TaskContractV3 + 外部文件隔离/物化
  -> BenchmarkExecutor（真实 Agent 运行桥）
  -> 确定性答案、引用、断言、工件校验
  -> model/capability/dependency/validator/policy/resource/evaluator 归因
  -> 待人工审查的私有能力缺口提案
```

外部基准只负责提供问题分布和可核验预期。是否交付成功仍由 TaskContract、不可变工件引用、引用证据和确定性校验共同判断，不能以模型自述或“调用过工具”作为通过条件。

## 2. 当前目录

| 数据集 | 方向 | 状态 | 接入方式 |
| --- | --- | --- | --- |
| FinQA | 财务问答、表格推理 | ready | 专属 Adapter |
| TAT-QA | 财务问答、表格与文本 | ready | 专属 Adapter |
| ConvFinQA | 多轮财务推理 | ready | 专属 Adapter，逐轮展开 |
| FinanceBench | 财务 RAG、引用 | ready | 专属 Adapter |
| FinBen | 财务知识、量化 | ready | 通用 QA Adapter |
| FinEval | 中文财务知识 | ready | 通用 QA Adapter |
| SpreadsheetBench v2 | 表格理解、编辑、工件交付 | ready | 专属 Adapter；运行前必须物化输入文件 |
| FinAgentBench | 财务 Agent、工具使用 | ready | Agent Adapter |
| FinDER | 财务检索、尽调 | reference_only | 仅登记论文；权威数据发布与结构核验后再开放 |
| QFBench | 量化金融 Agent | reference_only | 依赖 Harbor/Docker 状态环境，尚未实现专属执行桥 |

`reference_only` 数据集会在导入阶段硬拒绝，避免用一个看似兼容的 JSON 适配器伪装完成接入。

## 3. 安全、许可证与可复现性

- 仓库不下载、不内嵌、不再分发公开基准数据；用户从权威上游获得数据后，以本地文件导入。
- 当前目录中的许可证状态保守标记为 `review_required`。导入时必须显式传 `--ack-license`；许可证未验证的运行报告禁止标记为 `publishable`。
- 每次导入记录源文件 SHA-256、字节数、原始记录数、归一化用例数、版本和 split；空数据源或产出零用例的 Adapter 会硬失败。
- 每份运行报告内嵌实际参与运行的 dataset/version/split、源文件 SHA-256、许可证状态和用例数，报告不能脱离导入来源单独解释。
- Spreadsheet/Agent 工件用例必须提供已隔离、已物化的 `ArtifactRef`；缺失时在执行器调用前失败，归因为 capability，而不是让 Agent 猜路径。
- 工件用例必须返回确定性 checks；只有文件或 SHA、没有验证结果时归因为 evaluator，不算 Agent 通过。
- 引用评分同时核对稳定 sourceId 与 locator；只命中文档但定位到错误章节，不算引用成功。

## 4. 命令

项目默认使用 pnpm；同一脚本也可由 npm 执行。

```bash
# 导入用户从权威来源取得的本地 JSON/JSONL
pnpm benchmarks:import -- \
  --dataset finqa \
  --version upstream-commit-or-release \
  --split test \
  --source /absolute/path/to/test.json \
  --ack-license

# 只验证 Adapter -> Contract -> Scorer -> Gap Miner 管线
pnpm eval:benchmarks:fixtures

# 从真实运行报告生成待人工审查的能力缺口提案
pnpm benchmarks:gaps -- /absolute/path/to/report.json

# 回归测试（含 production executor、物化、preflight、真实 runner、gap proposal 与 100-case soak）
pnpm test:benchmarks:production

# 三层口径：Harness 零模型；Agent 固定模型；Model 矩阵只生成零网络计划
pnpm eval:benchmarks:harness
pnpm eval:benchmarks:real -- --layer agent --fixed-model <id> <其余 preview/预算参数>
pnpm eval:benchmarks:model-matrix -- --models <a,b> --repetitions 2 --profile benchmark-smoke --max-cases 7
```

默认输出位于 `.finwork-test/benchmarks/`，该目录被 Git 忽略。导入器不联网，也不会自动接受许可证。

## 5. 合成 Oracle 的严格边界

`tests/fixtures/benchmarks/` 中的数据全部是自造结构样例。`createFixtureOracleExecutor()` 会直接回放样例预期，只用于确认：

1. Adapter 能否稳定归一化；
2. TaskContract 是否阻止未物化外部文件；
3. 答案、引用、断言、工件校验能否正确计分；
4. 故障是否归到正确责任域；
5. 报告和缺口提案能否稳定生成。

这类报告固定 `fixtureOracle: true`、`publishable: false`。它不是模型成绩，也不能用来宣称 Finwork 已具备对应能力。

## 6. Production Executor：复用真实 Agent，不复制另一套运行时

真实执行已经通过唯一的 `BenchmarkExecutor` 桥，把物化后的 `TaskContractV3` 交给现有 production capability runtime，并从持久化运行记录组装 `BenchmarkPrediction`。该桥：

- 复用现有权限、确认、取消、预算、证据和交付门禁；
- 从真实 Artifact/Evidence/Assertion 记录取结果，不从最终自然语言回复猜成功；
- 保留 provider、tool、validator、policy、resource 和 evaluator 的结构化失败；
- 对 RAG 返回稳定 sourceId 和 locator，对 XLSX/DOCX/PDF 执行文件级确定性检查；
- 将原始运行报告与导入 manifest 的 SHA 绑定，保证复现。

真实付费请求还必须同时通过环境变量、CLI consent、显式 token/time（以及价格已知时的 USD）预算和已持久化 preview receipt。CI 只运行零模型回归，不会发送真实请求。

## 7. 从测试中扩展本地专业集

真实基准运行后，`mineBenchmarkGapProposals()` 只生成 `status: proposal` 的候选，不自动写入 Golden 集。每个候选必须经过人工确认：

1. 先确认是模型、能力、依赖、验证器、策略、资源还是评测器问题；
2. 只把可重复、无许可证/记忆污染风险的案例改写为本地财务业务用例；
3. 为用例补 TaskContract、输入工件、证据定位、业务断言和交付门禁；
4. 先做无模型确定性回归，再进入真实模型矩阵；
5. 能力稳定后再精简重复公开用例，保留覆盖矩阵而不是堆题量。

这样公开基准提供覆盖面，本地 Golden 集约束产品真正要交付的记账、薪税、税务、资金、往来、经营分析、复杂文档和 Excel 能力。
