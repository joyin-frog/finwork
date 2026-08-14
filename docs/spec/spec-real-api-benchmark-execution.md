# Finwork 真实 API Benchmark 执行 Spec

状态：**Goal 实施契约**（基线缺口快照；实时进度见 Goal checkpoint）

版本：`1.0`

适用仓库：`finance-agent-public`

前置文档：[benchmark-integration.md](./benchmark-integration.md)

数据能力背景：[design-xlsx-capabilities.md](./design-xlsx-capabilities.md)

> 本文是实施契约，不是当前完成情况说明。第 3 节冻结的是 Goal 启动时、基线 `2295d76` 的缺口快照；不得据此覆盖 `.finwork-test/benchmarks/goal/spec-real-api-benchmark-execution-v1/` 中的阶段 checkpoint。Goal 必须按本文阶段顺序补齐后，才能把真实 API 结果当作产品评测结果。

## 1. Goal 目标

在不复制第二套 Agent、不把答案泄漏给 Agent、不用 Fixture Oracle 冒充真实成绩的前提下，完成以下闭环：

```text
权威上游数据 + 本地专业用例
  -> Adapter / Manifest / SHA / License
  -> Agent 可见执行合同（不含答案）
  -> 现有 production runtime / tools / policy / resource governor
  -> 真实 Anthropic Messages 兼容 API
  -> ArtifactStore / EvidenceLedger / Validator
  -> 私有 Evaluation Oracle / Scorer
  -> 可复现报告 / 故障归因 / 本地能力缺口提案
```

完成后必须能回答三个不同问题，且不能混成一个总分：

1. **模型能不能做**：FinBen、FinEval 等模型选择集。
2. **Finwork Agent 能不能交付**：FinQA、TAT-QA、FinanceBench、SpreadsheetBench v2、FinAgentBench。
3. **为什么失败**：模型、能力、依赖、验证器、策略、资源或评测器中的哪一层失败。

## 2. 不可违反的执行原则

### 2.1 不做兜底实现

- 不允许 Executor 直接读取 expected answer 后生成答案。
- 不允许失败时切换到 Fixture Oracle、规则答案或静态回放。
- 不允许缺 XLSX/DOCX/PDF 工具时退化为文字说明并判成功。
- 不允许把“调用过工具”“模型说已完成”“文件存在”当成交付成功。
- 不允许为跑通 Benchmark 新建一套绕开权限、确认、预算、取消、证据和交付门禁的 Agent。
- 不允许用最终自然语言回复猜测引用、文件校验或业务断言。

### 2.2 真实 API 是显式付费动作

真实请求必须同时满足：

1. 设置中的 Key、URL、快速/推理两模型配置就绪；
2. 命令行带 `--confirm-real-api`；
3. 当前进程设置 `FINWORK_ALLOW_REAL_API_BENCHMARKS=1`；
4. 明确给出 `--max-cases`、token、wall-time 上限；
5. 如果配置了模型价格，还必须给出 `--max-cost-usd`。

缺任一条件只能运行静态预检，不能发送付费请求。

### 2.3 真实成绩必须来自真实生产链路

真实 Benchmark 的执行链必须复用：

- `lib/task/production-runtime.ts`
- `lib/runtime/capability-foundation-gateway.ts`
- `lib/agent/tools/capability-runtime.ts`
- 现有 Agent service 与 tool registry
- ArtifactStore、EvidenceLedger、Delivery/Assertion Validator
- Resource Governor、Security Kernel、Session Grant、取消与中止机制

Benchmark 可以关闭标题生成、UI 通知等非任务副作用，但不能替换模型、工具、权限、验证或交付主链路。

## 3. 当前基线与已知缺口

### 3.1 已有能力

- `lib/evaluation/benchmarks/`：数据集目录、Adapter、合同、runner、scoring、fixture oracle、gap miner。
- `scripts/benchmark-import.mts`：本地 JSON/JSONL 导入、许可证确认、来源 SHA。
- `scripts/benchmark-fixtures.mts`：只验证接线的合成 Oracle。
- `scripts/benchmark-gaps.mts`：从报告生成待人工审查的能力缺口。
- `pnpm test:benchmark-adapters`、`pnpm eval:benchmarks:fixtures`。

### 3.2 必须先修复的可信度问题

当前 `createBenchmarkTaskContract()` 把以下评测信息写入 `TaskContractV3.invariants[].parameters`：

- `answers`
- `numericAnswers`
- `citations`
- `assertions`

同时，当前 `BenchmarkExecutor` 会收到完整 `NormalizedBenchmarkCase`，其中也包含 `expected`。如果直接接真实 Agent，答案可能进入 Agent 可见上下文，成绩不可信。

因此 **Phase 0 必须先完成 Oracle 隔离**。在此之前禁止增加真实付费执行命令。

### 3.3 真实执行仍缺失

- 没有 production `BenchmarkExecutor`。
- 没有“配置静态检查 + 单次付费探针”的 preflight。
- 报告缺 provider host、模型槽位、commit、token、费用、run/artifact/evidence 引用。
- SpreadsheetBench v2 尚未接入真实文件物化、重算和工件验证闭环。
- FinDER 与 QF-Bench 仍为 `reference_only`。

## 4. 用户 API 配置契约

### 4.1 支持的协议

当前运行时使用 **Anthropic Messages 兼容协议**：

- 请求：`POST <base>/v1/messages`
- 鉴权头：`x-api-key`
- 版本头：`anthropic-version: 2023-06-01`

因此：

- Anthropic 官方 API 可以直接配置。
- 第三方网关必须明确兼容 Anthropic Messages API 和 `x-api-key`。
- 只有 OpenAI `/v1/chat/completions` 兼容、但不兼容 Anthropic Messages 的网关当前不能使用；不得假装兼容。

### 4.2 在界面中配置

启动 Finwork 后打开：

```text
http://localhost:3000/config?tab=model
```

填写四项：

| 字段 | 填写规则 | 运行时映射 |
| --- | --- | --- |
| LLM URL | 官方填 `https://api.anthropic.com`；代理可填根地址或以 `/v1` 结尾的地址 | 自动拼成 `/v1/messages` |
| API Key | Provider 分配的真实 Key | 仅存系统密钥库 |
| 快速模型 | Provider 接受的**精确模型 ID** | `fastModel` |
| 推理模型 | Provider 接受的**精确模型 ID** | `reasoningModel` |

URL 示例：

```text
正确：https://api.anthropic.com
正确：https://gateway.example.com
正确：https://gateway.example.com/v1
错误：https://gateway.example.com/v1/messages
```

如果 Provider 暂时只有一个可用模型，可以把同一个精确模型 ID 同时填入“快速模型”和“推理模型”。功能可用，但没有模型分层，报告必须标记 `modelTierSeparated: false`。

输入后等待页面出现 `已保存 ✓`。设置通常不需要重启服务；后续新 run 会读取新配置，已经在执行的 run 不会中途切换模型。

### 4.3 Key 的存储边界

- macOS：系统钥匙串，service 为 `com.gyro.financeagent`，account 为 `anthropic-api-key`。
- Windows：DPAPI 加密存储。
- Linux/CI：受控 fallback secret 文件，并必须显示安全警告。
- Key 不写入 `local-settings.json`、Benchmark manifest、报告、日志、CLI 参数或 Git。
- 不提供把 Key 直接写进 shell history 的配置命令；优先使用设置页。

### 4.4 免费静态检查

保存后，可执行以下只读检查；它们不会打印 Key：

```bash
curl -s http://localhost:3000/api/settings/agent \
  | jq '.data | {apiUrl,apiKeyConfigured,apiKeyPersisted,fastModel,reasoningModel}'

curl -s http://localhost:3000/api/settings/doctor \
  | jq '.data | {apiKeyConfigured,modelConfigReady,missingModelTiers,python,spreadsheet}'
```

必须满足：

- `apiKeyConfigured == true`
- `apiKeyPersisted == true`
- `modelConfigReady == true`
- `missingModelTiers == []`
- `fastModel`、`reasoningModel` 均非空

`/api/health?deep=1` 只检查服务和 URL 可达性，不验证 Key 权限、模型 ID 或真实推理成功，不能替代 Phase 4 的付费探针。

### 4.5 Node 与包管理器前置门禁

本仓库默认使用 `pnpm`，同时保留 npm 脚本兼容。Goal 开始实施前必须先运行：

```bash
node --version
pnpm --version
pnpm test:benchmark-adapters
```

如果 `pnpm` 因版本下载、注册表、签名校验或 package-manager shim 失败，必须把它记录为 `tooling/package-manager` 前置故障，不能归为模型、Provider 或 Benchmark 失败，也不能进入真实付费阶段。修复前允许使用 npm 执行同名本地脚本以验证代码基线：

```bash
npm run test:benchmark-adapters
```

Goal 新增的 `eval:benchmarks:preflight` 与 `eval:benchmarks:real` 必须同时保持标准 package script 形式，因此 npm 等价调用为：

```bash
npm run eval:benchmarks:preflight -- --mode static
npm run eval:benchmarks:real -- --profile benchmark-smoke <其余显式参数>
```

npm 兼容入口不是绕过 pnpm 安装完整性检查的兜底实现；发布与默认开发链仍以仓库声明的 pnpm 版本为准。

## 5. 数据集角色与执行顺序

### 5.1 产品能力主线

按以下顺序接入真实运行，不允许一上来全量烧额度：

1. **FinQA / TAT-QA**：基础财务计算、表格与文本推理。
2. **FinanceBench**：财务 RAG、证据定位和引用。
3. **SpreadsheetBench v2**：真实 Excel 理解、修改、重算、验证和交付。
4. **FinAgentBench**：多工具 Agent 行为，作为补充覆盖。
5. **FinDER**：等专属 Adapter、权威数据和许可证核验完成后，从 `reference_only` 转为可运行。

### 5.2 模型选型线

- **FinBen / FinEval** 只用于快速模型、推理模型和候选模型比较。
- 不进入 Finwork 产品最终分数。
- 不能替代 XLSX、RAG、证据或交付验证。

### 5.3 架构借鉴线

- QF-Bench 只借鉴“任务目录 + 隔离环境 + Oracle + 自动测试”的 Harness 架构。
- 在没有 Harbor/Docker 专属 runner 前保持 `reference_only`。
- 不用通用 QA Adapter 伪装 QF-Bench 已接入。

## 6. 运行档位

### 6.1 `connection-smoke`

目的：只验证真实 API、路由模型和主模型可调用。

- 使用仓库自有、无许可证风险的最小提示。
- 快速模型 1 次，推理模型 1 次。
- 每次输出上限 32 tokens。
- 不计 Benchmark 分，不发布。
- 成功只能证明“鉴权、URL、模型 ID 与基本响应”可用。

### 6.2 `benchmark-smoke`

目的：验证完整 Agent + 工具 + Oracle + 报告链路。

默认样本：

| 数据集 | 用例数 |
| --- | ---: |
| FinQA | 2 |
| TAT-QA | 2 |
| FinanceBench | 2 |
| SpreadsheetBench v2 | 1 |

并发固定为 `1`。任何基础设施失败先停，不继续扩大样本。

### 6.3 `pilot`

只有 `benchmark-smoke` 通过后才能运行：

| 数据集 | 默认用例数 |
| --- | ---: |
| FinQA | 25 |
| TAT-QA | 25 |
| FinanceBench | 20 |
| SpreadsheetBench v2 | 5 |

### 6.4 `full`

只有 pilot 报告完成故障归因、费用评估和人工审查后才允许。必须显式给 `--max-cases`，不得用“全部”作为隐式默认值。

## 7. 目标命令

以下命令是本文要求 Goal 实现的目标接口；在对应 Phase 完成前不存在是正常现状。

```bash
# 只做设置、数据、工具、磁盘、策略检查，不发模型请求
pnpm eval:benchmarks:preflight -- --mode static

# 显式发送两次极小真实请求，验证快速/推理模型
FINWORK_ALLOW_REAL_API_BENCHMARKS=1 \
pnpm eval:benchmarks:preflight -- \
  --mode connection-smoke \
  --confirm-real-api \
  --max-input-tokens 2000 \
  --max-output-tokens 64 \
  --max-wall-ms 120000

# 小样本真实产品链路
FINWORK_ALLOW_REAL_API_BENCHMARKS=1 \
pnpm eval:benchmarks:real -- \
  --profile benchmark-smoke \
  --confirm-real-api \
  --max-cases 7 \
  --max-input-tokens 120000 \
  --max-output-tokens 20000 \
  --max-wall-ms 1800000

# pilot；只有 smoke 验收后运行
FINWORK_ALLOW_REAL_API_BENCHMARKS=1 \
pnpm eval:benchmarks:real -- \
  --profile pilot \
  --confirm-real-api \
  --max-cases 75 \
  --max-input-tokens 1200000 \
  --max-output-tokens 180000 \
  --max-wall-ms 14400000
```

如果模型价格已配置，再增加：

```text
--max-cost-usd <明确金额>
```

如果价格未知，报告必须写 `pricingKnown: false` 和 `costUsd: null`，但 token、case、wall-time 上限仍必须生效。输入 token 门禁必须计入普通 input、cache-read input 和 cache-creation input，并在报告中分字段保留。

## 8. 实施阶段

Goal 必须逐阶段实施、测试、记录 checkpoint。不得跨过失败阶段继续花费真实 API。

### Phase 0：Oracle 与 Agent 可见输入隔离

#### 改动

1. 新增 `BenchmarkExecutionCase`：只包含 prompt、上下文、能力、已物化输入和必要 provenance，不含 `expected`。
2. 新增私有 `BenchmarkEvaluationOracle`：答案、数值答案、引用、断言和工件期望只由 scorer/validator 持有。
3. 修改 `BenchmarkExecutor`，不再接收完整 `NormalizedBenchmarkCase`。
4. 修改 `createBenchmarkTaskContract()`：
   - 删除带答案的 `benchmark-expected-signal` parameters；
   - 只保留 Agent 可执行的能力、输入、业务约束、输出类型、证据要求、预算和安全策略；
   - validator ID 可以描述输出类型，但不能携带 expected value。
5. runner 私下保留原始 case 供 scoring，禁止把 Oracle 传给 Executor、prompt、tool context、run metadata 或日志。

#### 测试

- 构造一个只存在于 `expected` 的 sentinel，断言 Executor 收到的所有对象和序列化合同均不包含 sentinel。
- 断言 Agent 可见对象不存在 `expected`、`answers`、`numericAnswers`、`assertions` 字段。
- 断言 source table 中自然存在答案时仍可正常执行，测试不能误判正常来源内容为泄漏。
- Fixture Oracle 仍可测试 scorer，但必须经独立测试入口，不能实现 `BenchmarkExecutor` 接口供 real runner 选择。

#### 验收

```bash
pnpm test:benchmark-adapters
pnpm eval:benchmarks:fixtures
```

Phase 0 未通过：**禁止继续**。

### Phase 1：运行配置与报告 schema v2

#### 改动

新增显式 `RealBenchmarkRunConfig`，至少包含：

- profile、dataset/split、sample seed、max cases
- max input/output tokens、wall time、可选 USD 上限
- real API consent 状态
- provider host（只记录 host，不记录 Key）
- fast/reasoning 模型 ID 与各次调用的 executionRole
- commit SHA、runner version、Node/pnpm/app 版本
- dataset manifest SHA、source SHA、license status

报告升级为 schema v2，并保留 v1 只读迁移：

- 每个 case：traceId、caseId、taskId、runId、conversationId（如有）
- token/latency/retry/estimated cost
- ArtifactRef、EvidenceRef、Assertion/Delivery 验证摘要
- fault domain + stable failure code
- cancellation/abort/timeout 状态
- `fixtureOracle`、`realApi`、`publishable` 明确布尔值

不得记录：

- API Key、鉴权头、完整 secret 文件路径
- 未脱敏系统提示和密钥库错误原文
- 超过报告必要范围的原始敏感文档内容

#### 验收

- v1 报告可读取。
- v2 schema round-trip 稳定。
- secret sentinel 不出现在 JSON 报告和日志。
- 相同 manifest + seed 产生相同 case 顺序。

### Phase 2：Production Benchmark Executor

#### 改动

1. 从 `beginProductionTaskRun()` 抽取可接受外部 `TaskContractV3` 的共享内核，或给它增加经过 schema 验证的 prebuilt contract 入口。
2. 保留 Benchmark 合同里的预算，不得被 production 默认的更大预算覆盖。
3. 新增 `lib/evaluation/benchmarks/production-executor.ts`：
   - 建立隔离的 benchmark case/run；
   - 复用 production Agent service、tools、grants、security、resource governor；
   - 支持 AbortSignal 贯穿模型、工具、worker、交付；
   - 关闭标题生成等非任务付费副作用；
   - 不经 HTTP 自调用本应用，不复制 route 业务逻辑。
4. 从持久化结果组装 prediction：
   - 文本答案来自已持久化 assistant result；
   - 引用来自 EvidenceLedger 的稳定 `sourceId + locator`；
   - 文件来自 ArtifactStore 的不可变 delivery ref；
   - 工件 checks 来自 Validator/Assertion 记录；
   - 不能从自然语言自述合成 checks。
5. Headless 运行需要 conversation/message 时，创建 benchmark 专用临时会话并绑定 run；清理由 retention/resource 层负责，不能散落临时文件。

#### 故障映射

沿用当前 fault domain，不随意新造顶层枚举：

| 现象 | fault domain |
| --- | --- |
| Key、URL、Provider 连接、429/5xx | `dependency` |
| 模型不会推理或答案错误 | `model` |
| 工具/能力不存在或无法完成 | `capability` |
| 文件、引用、业务断言校验失败 | `validator` |
| 权限、DLP、域名、确认门禁 | `policy` |
| token、时间、内存、磁盘、取消 | `resource` |
| Adapter、Harness、Scorer、报告异常 | `evaluator` |

更细原因放 stable failure code，不靠自由文本。

#### 验收

- 使用 fake provider 但真实 production runtime 的集成测试。
- Auth 失败不重试。
- 429/5xx 最多一次有界重试，并遵守 `Retry-After` 与总预算。
- 取消后无后台继续请求、继续写文件或继续计费。
- 缺 artifact/evidence/check 时不能判通过。

### Phase 3：真实数据与文件物化

#### 改动

1. 保持“用户从权威来源取得，本仓库只本地导入”的许可证边界。
2. 每个真实 run 只读取导入 manifest，不直接扫任意目录。
3. SpreadsheetBench v2 的输入必须先进入 ArtifactStore，合同只传 ArtifactRef，不传宿主机裸路径。
4. RAG 数据必须导入 Retrieval v2，保留 source ID、document hash、chunk locator 和版本。
5. 引入 `benchmark materialization manifest`，绑定：
   - upstream source SHA
   - normalized case SHA
   - ArtifactRef / Retrieval source version
   - license acknowledgement

#### 验收

- 外部文件未物化时在 Agent 启动前失败。
- manifest/source SHA 不一致时失败。
- RAG citation 可回到具体 source locator。
- 许可证未验证的报告固定 `publishable: false`。

### Phase 4：Preflight 与真实连接探针

#### 静态 preflight

检查：

- `/api/settings/agent` 与 `/api/settings/doctor` 等价的底层设置状态
- Key 存在但不读取/打印明文
- URL 解析后目标 host 合法
- 快速/推理两模型完整
- 数据 manifest、ArtifactStore、DB、Python/XLSX worker、磁盘空间
- real API consent、case/token/time/cost budgets
- mock agent 未开启

#### 付费 connection smoke

- fast 模型一次最小请求。
- reasoning 模型一次最小请求。
- 每次使用唯一 nonce，确认不是缓存静态响应。
- 验证 HTTP、Messages 响应结构、usage、model ID。
- 401/403、400/404、模型不存在立即停止，不重试。

#### 验收

- 静态模式绝不发网络请求。
- 未同时满足 env gate 与 CLI flag 时绝不发请求。
- Key 不出现在 stdout/stderr/report。
- 付费探针有 token/latency 记录但 `publishable: false`。

### Phase 5：真实 Benchmark Smoke

按第 6.2 节运行 7 个 case，顺序执行。

#### 必查结果

- FinQA：数值答案和单位归一正确。
- TAT-QA：表格与文本证据都能定位。
- FinanceBench：citation source 与 locator 都正确。
- SpreadsheetBench v2：真实输出文件存在、SHA 固定、可打开、重算、无公式错误、业务断言通过、delivery evidence 完整。

#### 验收

- 7 个 case 都有完整 trace 与责任域；失败允许存在，但不能是无法解释的 Harness 空洞。
- `evaluator`/`dependency` 连续错误触发停止，而不是继续烧额度。
- 运行完成后进程无遗留 Agent/worker/request。

### Phase 6：Pilot 与模型矩阵

1. 先跑产品 pilot。
2. 再用 FinQA/TAT-QA（扩展阶段可加入 FinBen/FinEval）做 answer-only 模型选择矩阵。
3. 模型矩阵固定 prompt、公开上下文、数据、预算和 scorer，但不经过 Router、Pi、工具、Memory、repair 或交付 Harness；Agent 能力矩阵则固定一个模型并保留完整 production 链，两类结果禁止合并。
4. 每个候选至少重复两次；报告同时展示正确率、验证通过率、p50/p95 latency、tokens、费用和基础设施失败率。
5. 不以平均总分掩盖 XLSX 交付或引用的硬失败。

### Phase 6A：三层评测口径门禁

| 层 | 回答的问题 | 网络/模型 | 主要通过信号 |
| --- | --- | --- | --- |
| Harness | 合同、状态机、预算、证据、验证、交付和记账是否正确 | 零 Provider 请求 | 确定性回归与 soak |
| Agent | 固定模型下 Finwork Agent 能否正确使用工具并形成证据/工件闭环 | 单一显式模型，跳过付费 Router；主/子 Agent 同模型 | TaskContract + Evidence + Artifact + blocking validators |
| Model | 候选模型的答案推理能力如何 | 每 case 一次直连 completion，无工具 | answer/numeric/token F1；每候选至少两次 |

真实运行配置必须记录 `evaluationLayer`；Agent/Model 层必须记录 `fixedModel`。Router 的真实
Provider usage 必须合入 production trace；citation/retrieval 合同不得被 `cheap directAnswer`
短路。工具调用次数与回复关键词只能用于诊断，不能替代证据、产物和确定性断言。

### Phase 7：能力修复与本地专业集

1. 运行 `benchmarks:gaps` 只生成 proposal。
2. 人工区分 model / harness / tool / validator / policy / resource。
3. 把可重复且无许可证污染的缺口重写为本地专业用例。
4. 每个本地用例必须包含：
   - TaskContract
   - 输入工件与来源
   - 私有 Oracle
   - 业务断言
   - 确定性文件校验
   - 失败责任域预期
5. 先做无模型回归，再进入真实 API smoke/pilot。

优先扩展：

- 记账、薪税、税务、资金、往来、经营分析
- 复杂 XLSX 公式、合并、对账、重算与格式保真
- PDF/DOCX 表格与证据引用
- RAG 政策时效、版本冲突、locator 精度
- 尽调来源可信度、日期、交叉验证
- 长会话记忆写入、召回、冲突、过期与删除
- 大文件、多轮、多工具、取消、资源清理和长期性能

### Phase 8：长期运行与性能门禁

增加 soak/profile：

- 连续运行至少 100 个小用例或等价 2 小时任务。
- 记录 RSS、heap、worker 数、临时文件、DB 增长、检索延迟、冷/热启动。
- 每个 case 结束回收临时 workspace、子进程、流、AbortController 和失效缓存。
- 不允许 RSS、worker、临时文件数随 case 数线性无界增长。
- 把资源泄漏归为 `resource`，不得归给模型。

## 9. 自动停止条件

命中任一条件必须停止当前 run，写完整 checkpoint，不继续下一 case：

- 401 / 403。
- endpoint/model 不存在导致的 400 / 404。
- 发现 Oracle 泄漏。
- 发现请求目标域不在预期 Provider host。
- 达到 case、token、wall-time、disk、memory 或 USD 上限。
- 连续 3 个 `dependency` 或 `evaluator` 错误。
- ArtifactStore/EvidenceLedger/Validator 不可用。
- Spreadsheet 工件不能打开、重算或验证。
- 用户取消、进程收到中止信号。
- 报告无法安全持久化。

停止后允许从下一个未完成 case 断点续跑，但不得自动重跑已产生费用且状态不明的 case；必须先人工确认 provider usage 和持久化 run 状态。

## 10. Goal checkpoint 与断点续跑

Goal 使用以下忽略目录记录状态：

```text
.finwork-test/benchmarks/goal/spec-real-api-benchmark-execution-v1/
  state.json
  phases/<phase>.json
  runs/<runId>/report.json
  runs/<runId>/events.jsonl
```

`state.json` 至少包含：

- specVersion
- currentPhase
- completedPhases
- lastVerifiedCommit
- validationCommands + exit codes
- imported manifests
- real API consent（不含 Key）
- active/finished run IDs
- stop reason

Goal 每完成一阶段必须：

1. 跑该阶段验收；
2. 写 checkpoint；
3. 确认 Git diff 没有 secret、数据集原文、生成大文件；
4. 再进入下一阶段。

## 11. Definition of Done

只有同时满足以下条件才算本文目标完成：

- [ ] Agent 可见合同与 Executor 输入中不存在私有 Oracle。
- [ ] Fixture Oracle 与 real executor 在类型和 CLI 上不能混用。
- [ ] Production Benchmark Executor 复用正式 runtime、tools、policy、resource、artifact、evidence 和 validator。
- [ ] 设置静态 preflight 不产生付费请求。
- [ ] 真实请求需要 env gate + CLI consent + budgets。
- [ ] fast/reasoning 两槽真实 connection smoke 通过。
- [ ] FinQA、TAT-QA、FinanceBench、SpreadsheetBench v2 的真实 smoke 已运行。
- [ ] Spreadsheet 输出经过打开、重算、错误扫描、业务断言和不可变交付验证。
- [ ] 每个 case 可定位到 trace/run/task/artifact/evidence。
- [ ] auth、model not found、429、5xx、timeout、cancel 有确定性测试。
- [ ] 报告不含 Key，来源、模型、commit、tokens、费用状态可复现。
- [ ] fault domain 归因没有把 Harness/Provider 错误误判为模型能力。
- [ ] 许可证未验证或 fixture 报告不能发布。
- [ ] soak 测试没有无界内存、worker、临时文件或 DB 增长。
- [ ] 文档、package scripts、CI 和实现一致。

## 12. 给 Goal 的启动指令

用户配置完成后，可用下面的目标创建 Goal；不要在目标文本中写 API Key：

```text
以 docs/spec/spec-real-api-benchmark-execution.md 为唯一实施契约，从 Phase 0 开始持续实施并验证，直到 Definition of Done 全部满足。保留现有用户改动，不复制第二套 Agent，不做兜底实现，不得让 expected/oracle 进入 Agent 可见合同、提示、工具上下文或日志；真实执行必须复用 production runtime、ArtifactStore、EvidenceLedger、Validator、Security Kernel 和 Resource Governor。每阶段运行验收并写 checkpoint，失败先修复再继续。只有设置预检通过、FINWORK_ALLOW_REAL_API_BENCHMARKS=1、--confirm-real-api 和显式预算同时存在时，才允许发真实付费请求；命中自动停止条件立即停止并报告，不扩大样本。
```

建议用户在启动 Goal 前先确认：

```text
1. 设置页显示已保存。
2. /api/settings/agent 的 apiKeyConfigured/apiKeyPersisted 为 true。
3. /api/settings/doctor 的 modelConfigReady 为 true。
4. 已准备要运行的数据集本地源文件与许可证确认。
5. 已明确本次 smoke/pilot 的 token、时间和可选金额上限。
```

配置完成只代表真实 API 可以被预检；**现有仓库不会因为填好 Key 就自动拥有真实 Benchmark 执行桥**。Goal 必须先完成 Phase 0–4，再允许进行 Phase 5 的真实产品 smoke。
