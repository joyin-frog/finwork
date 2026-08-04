# Spec：历史财务评测可靠性与 Spreadsheet Runtime v2

> 状态：Ready for implementation
> 日期：2026-08-04
> 范围：历史财务评测、XLSX 交付质量门、Spreadsheet Runtime、XLSX Skill
> 前置：`spec-historical-finance-eval.md`、`spec-spreadsheet-runtime-preflight.md`

## 1. 决策摘要

本 Spec 同时解决两类问题：

1. 评测器把超时、judge 不可用和真实业务错误混成同一种 FAIL，导致能力评分失真。
2. Agent 把 LibreOffice 当成“写 Excel”的前置条件，造成反复探测、无效重试和不必要超时。

最终架构采用分层迁移：

```text
Agent 写入层：ExcelJS / openpyxl / artifact-tool
        ↓
静态结构检查：工作表、公式文本、错误字符串、源文件保护
        ↓
计算/渲染 Provider：artifact-tool 主路径；LibreOffice 兼容 fallback（过渡期）
        ↓
业务断言与语义 judge
        ↓
finalize_deliverable
```

LibreOffice 立即从 Agent 路径和写入能力中移除；在 artifact-tool 完成真实附件兼容性验收前，不删除 Runtime fallback。

## 2. 问题证据

2026-08-03 使用真实附件串行重跑 7 个 Case：

| Case | 结果 | 说明 |
|---|---|---|
| HISTORY-001 | 业务失败 | 关键净值硬编码，公式 lineage 被破坏 |
| HISTORY-002 | 超时 | 超过 30 分钟无 `result.json` |
| HISTORY-003 | 通过 | 修正 judge blocking 规则后通过 |
| HISTORY-004 | 超时/无交付 | 逐页 OCR，最终没有 XLSX |
| HISTORY-005 | 业务失败 | 时间线、利润率和数值口径矛盾 |
| HISTORY-006 | 超时/无交付 | 合并模板映射过久，LO 失败后未定稿 |
| HISTORY-007 | 产物通过、judge 不可用 | XLSX/DOCX 与确定性断言通过，但 judge 未返回 |

结论：质量分不能代替完成证据；写出 XLSX 也不等于公式正确；没有 LibreOffice 也不是不能写 XLSX。

## 3. 目标与非目标

### 3.1 目标

- 把 Run 结果拆为 `passed`、`failed`、`timeout`、`cancelled`、`needs_review`、`harness_error`。
- 超时由独立 watchdog 可靠终止，并始终落盘 `result.json`。
- judge 不可用时不得伪装成模型失败。
- deterministic artifact assertions 作为一等质量门；judge 只阻断明确核心业务矛盾。
- Agent 可以在没有 LibreOffice 时创建和编辑 XLSX。
- 以 artifact-tool 为候选主计算/渲染 Provider，保留 LibreOffice 过渡 fallback。
- 任务上下文使用结构化 spreadsheet inspect/patch，避免整表 dump 和无界脚本生成。
- 对真实历史附件建立 Provider 兼容性回归矩阵。

### 3.2 非目标

- 本阶段不实现完整 Excel 公式引擎。
- 不承诺 `.xlsm` 宏、VBA 签名、外部链接的编辑保留。
- 不把 artifact-tool 未验证的能力写成已支持能力。
- 不通过 Python 手工计算后把结果硬编码为公式缓存。
- 不为了降低工具调用数牺牲业务正确性。

## 4. 结果模型与评分规则

### 4.1 RunOutcome

在 `tests/history-eval/run.ts` 与报告 schema 中增加：

```ts
type RunOutcome =
  | "passed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "needs_review"
  | "harness_error";

type JudgeStatus = "available" | "unavailable" | "error" | "skipped";
```

`result.json` 必须同时记录：

```ts
{
  outcome: RunOutcome,
  terminationReason: string,
  hardGatePassed: boolean,
  deterministicScore: number | null,
  judgeStatus: JudgeStatus,
  judgeBlocking: boolean | null,
  qualityScore: number | null,
  deliveryFailures: string[],
  timeoutMs: number,
  watchdogFired: boolean,
  lastProgressAt: string | null,
  artifactHashes: string[]
}
```

兼容旧报告时保留 `passed` 字段，但新逻辑以 `outcome` 为准。

### 4.2 判定优先级

1. 没有必需交付物、文件不可解析、公式错误、核心 deterministic assertion 失败：`failed`。
2. watchdog 触发或硬超时：`timeout`，不调用 judge 兜底。
3. 用户取消：`cancelled`。
4. 产物和 deterministic assertions 通过，但 judge 服务不可用：`needs_review`，不记为 Agent FAIL。
5. judge 明确指出核心业务矛盾或违反硬约束：`failed`。
6. 只有摘录不足、建议补充来源、排版建议、无法完全排除风险：`needs_review` 或 warning，不得 blocking。

### 4.3 Judge Prompt 硬约束

Judge 必须返回：`score`、`blocking`、`reason`、`evidence`。Prompt 必须明确：

> 只有产物明确出现重大业务矛盾、违反任务核心约束、用无依据数字代替待确认项，或虽有文件但不能完成核心用途时，`blocking=true`。确定性断言已通过的事实，不得仅因摘录未展示、无法完全排除风险、排版或措辞问题而 blocking。

评测报告要保存 judge 原文和 evidence 地址，禁止只保存一个分数。

## 5. 超时与无进展控制

### 5.1 独立 watchdog

文件：`tests/history-eval/run.ts`、`lib/agent/pi/agent-service.ts`。

- Runner 启动独立 timer，不依赖 Pi event loop 或当前 tool promise 返回。
- 到时执行：AbortController、session cancel/dispose、底层子进程 SIGTERM，宽限期后 SIGKILL。
- watchdog 触发后立即写临时 `result.json.partial`，清理完成后原子改名为 `result.json`。
- `result.json` 即使没有 finalize 也必须包含 `outcome=timeout`、最后工具、最后进度、已生成文件路径。
- 底层 tool promise 未响应时，不能继续等待它自然返回。

### 5.2 无进展停止

每个 Case 记录进度指纹：

```text
toolName + outputFileSha256 + verificationFingerprint + turnNumber
```

连续两轮没有新文件、没有新验证证据、没有错误变化时：

- 停止 repair loop；
- 若已有可交付但未通过，返回 `failed`；
- 若仍在探索且未交付，返回 `timeout` 或 `harness_error`，按 watchdog 状态区分。

### 5.3 预算

- 默认串行运行。
- repair 最多 2 轮，但不自动消耗满额；无进展时提前结束。
- 工具预算默认不超过历史调用量的 1.5 倍。
- 每个长任务先要求最小可用文件并 finalize，再进行修复。

## 6. 评测输入与确定性断言

### 6.1 结构化读取

为 Agent 提供定向接口，禁止以整本工作簿或长脚本替代：

- `inspect`: 工作表、范围、公式计数、错误计数、布局摘要；
- `inspect_cells`: 指定地址的值；
- `inspect_formulas`: 指定地址的公式文本；
- `compare_allowlist`: 源文件和候选文件的变化白名单；
- `formula_error_scan`: 全量扫描错误值；
- `render_preview`: 只渲染指定 Sheet/区域。

大型表格输出必须分页或按范围请求，单次响应限制行列和 token。

### 6.1.1 PDF 摄取：文本层优先，定向 OCR

PDF 不得默认逐页转图片并交给模型。输入摄取必须按以下顺序执行：

1. 先读取 PDF 文本层，保留页码、段落顺序和表格边界；优先使用 `pdftotext`/`pdfjs-dist` 等确定性解析能力。
2. 对文本层为空、乱码、表格关键字段缺失的页面建立 `ocrCandidates`，只对这些页面或页面中的指定裁剪区域 OCR。
3. OCR 前先由页级文本/关键词定位候选页；不得因为 PDF 总页数大就对所有页面 OCR。
4. OCR 结果必须记录页码、裁剪框、识别引擎、耗时和置信度；低置信度内容只能作为待确认证据，不能直接作为确定性数字。
5. 单 Case 设置 OCR 页数、图片像素和输出 token 上限；达到上限后返回 `input_extraction_limited`，不继续无限重试。
6. 先把文本层和必要 OCR 结果保存为本轮结构化输入，再让 Agent 读取；禁止在每一轮 repair 中重复全 PDF OCR。

建议接口：

```ts
type PdfExtraction = {
  pages: Array<{ page: number; text: string; source: "text_layer" | "ocr"; confidence?: number }>;
  ocrCandidates: number[];
  truncated: boolean;
  extractionMs: number;
};

extractPdfText(path, { pages?, maxOcrPages?, crops? }): Promise<PdfExtraction>
```

HISTORY-004 的验收必须证明：先完成文本层提取，只对必要页面 OCR，且不会重复执行整本 PDF OCR。没有文本层或 OCR 依赖缺失时，要返回可解释的 `input_extraction_unavailable`，而不是让 Agent 自行安装依赖并循环尝试。

### 6.2 财务专用断言

增加可复用 validator：

- 单位检查：元/万元/亿元；
- 期间检查：Q1、Q4、年度和文档生成日期一致；
- 百分比基数检查；
- 资产 = 负债 + 权益；
- 内部借款/往来抵消方向；
- 现金流抵消；
- 公式 lineage 与模板公式保护；
- 触发条件先于行动年份；
- 关键数字必须来自指定来源或明确标为假设。

具体 Case 规则继续冻结在 `tests/history-eval/cases.ts`，不得只依赖自然语言 judge。

## 7. Spreadsheet Runtime v2

### 7.1 Provider 接口

新增 `lib/runtime/spreadsheet-provider.ts`：

```ts
export type SpreadsheetProvider = {
  id: "artifact_tool" | "libreoffice";
  inspect(path: string, opts?: InspectOptions): Promise<InspectResult>;
  inspectCells(path: string, addresses: string[]): Promise<CellResult>;
  inspectFormulas(path: string, addresses: string[]): Promise<FormulaResult>;
  scanFormulaErrors(path: string): Promise<FormulaErrorResult>;
  recalc?(path: string, opts?: RecalcOptions): Promise<RecalcResult>;
  render?(path: string, opts: RenderOptions): Promise<RenderResult>;
  convertXls?(input: string, output: string): Promise<ConvertResult>;
};
```

Provider 选择顺序：

1. 任务要求计算/渲染时优先 `artifact_tool`；
2. artifact-tool 不支持该文件特性时使用 LibreOffice fallback；
3. 两者都不可用时返回稳定的 `recalc_unavailable`/`render_unavailable`，不得跳过后假装完成。

### 7.2 artifact-tool Spike

先不要直接替换 Runtime。新增 `tests/spreadsheet-provider/artifact-tool-spike.mts`，验证：

- 创建和导出 XLSX；
- 读取真实 HISTORY-003、HISTORY-007；
- 公式值与公式文本同时可读；
- `#REF!/#DIV/0!/#VALUE!/#NAME?/#N/A` 全量扫描；
- render 输出非空；
- 样式、合并单元格、冻结窗格、图表不破坏；
- 导出后用 ExcelJS/openpyxl 再读可打开；
- 复杂函数和跨 Sheet 引用结果正确。

Spike 结果必须记录 provider 版本、支持/不支持的公式、文件 hash 和耗时。未通过的能力不得标记为 `artifact_tool` 支持。

### 7.3 ExcelJS/openpyxl 的职责边界

- 负责读写、样式、公式字符串、结构检查和 allowlist 比较。
- 不负责声称完成公式求值。
- 如果没有计算 Provider，允许静态分析和写入，但公式型交付必须返回 `needs_review` 或 `recalc_unavailable`，不能把 Python 计算值写回公式缓存冒充重算。

### 7.4 LibreOffice 过渡策略

立即变更：

- Skill 和 Agent prompt 禁止 Bash 查找/启动 `soffice`；
- 写 XLSX 不调用 LO；
- Runtime 只在合同要求 recalc/render 时调用 Provider；
- LO resolver 保留，但只作为 fallback；
- `recalc_unavailable` 在 UI/报告中明确显示，不进入无界 repair。

删除条件：

- artifact-tool 通过全部历史真实附件回归；
- H001/H002/H003/H006 的公式和业务冻结值一致；
- 复杂函数、跨 Sheet、缓存、渲染均通过；
- 无 LO 环境下 release smoke 通过；
- 文档明确 `.xls`、`.xlsm`、外部链接的替代策略。

## 8. Skill 修复

文件：`agent-skills/skills/xlsx/SKILL.md`。

删除冲突内容：

- “LibreOffice Required for Formula Recalculation”作为 Agent 级前置条件；
- 直接运行 `scripts/recalc.py`；
- 临时安装公式库；
- 缺 LO 时让 Agent 自行探测和重试。

统一为：

1. 用 ExcelJS/openpyxl/artifact-tool 写入；
2. 通过产品 Spreadsheet Runtime 请求 inspect/recalc/render；
3. 没有计算 Provider 时明确报告，不硬编码缓存；
4. 先保存最小可用交付，再修复；
5. 使用指定范围 inspect，不 dump 整个工作簿。

同时检查其他 Skill 是否复制了旧版 XLSX 规则，避免 Agent 读取到互相矛盾的副本。

## 9. 实施拆分

### Batch 1：评测结果和 watchdog

文件：

- `tests/history-eval/run.ts`
- `tests/history-eval/scoring.ts`
- `tests/history-eval/cases.ts`
- `lib/agent/pi/agent-service.ts`

交付：RunOutcome、judgeStatus、独立 watchdog、partial result 原子落盘、无进展指纹、HISTORY-007 不再被 judge unavailable 判为 Agent FAIL。

### Batch 2：结构化 Spreadsheet Runtime

文件：

- `lib/runtime/spreadsheet-provider.ts`
- `lib/runtime/spreadsheet-runtime.ts`
- `lib/deliverable/validators/xlsx.ts`
- `workers/finance_worker.py`
- `lib/agent/mcp-tools/read-document.ts`
- `lib/runtime/pdf-runtime.ts`（新增）

交付：统一 inspect/inspectCells/inspectFormulas/errorScan 接口，增加 PDF 文本层优先与定向 OCR，Provider 错误码稳定，计算/渲染与写入解耦。

### Batch 3：artifact-tool Spike 与适配器

文件：

- `tests/spreadsheet-provider/artifact-tool-spike.mts`
- `lib/runtime/providers/artifact-tool-provider.ts`
- `package.json` / lockfile（仅 Spike 通过后添加依赖）

交付：真实附件兼容矩阵和明确的支持边界。

### Batch 4：Skill 与历史评测回归

文件：

- `agent-skills/skills/xlsx/SKILL.md`
- `tests/history-eval/manifest.test.ts`
- `tests/history-eval/scoring.test.ts`

交付：去掉 LO Agent 前置依赖；7 条评测在无 LO、artifact-tool 可用和两者都不可用三种环境下结果可解释。

### Batch 5：移除或降级 LO

仅在 Batch 3/4 验收后实施：

- 默认 provider 改为 artifact-tool；
- LO 仅保留 feature flag fallback；
- 一个完整 release cycle 后再删除 resolver、LO probe 和安装引导。

## 10. 测试矩阵

### 单元测试

- watchdog 超时、宽限期、SIGKILL 和 partial result；
- judge unavailable → `needs_review`；
- judge blocking → `failed`；
- 无进展 repair stop；
- Provider 路由和稳定错误码；
- 源文件 hash 不变、临时目录隔离；
- 全量公式错误扫描；
- allowlist 与公式 lineage。

### 集成测试

- 无 LibreOffice + 可写 XLSX：写入成功；
- 无 LibreOffice + 需要 recalc：明确 `recalc_unavailable`，不进入模型循环；
- PDF 有文本层时不启动全量 OCR；仅对文本缺失或关键字段缺失页面 OCR；
- PDF 重复 repair 不重复全量提取，OCR 页数和 token 超限会稳定失败；
- artifact-tool 可用 + 无 LO：H003/H007 通过；
- artifact-tool 不支持复杂文件 + LO 可用：fallback 成功；
- 两个并发 recalc 不共享临时 profile；
- H002/H006 在超时后必有 `result.json`。

### 真实评测验收

必须保存每个 Case 的：

- 输入 hash、输出 hash；
- outcome、terminationReason、watchdog 状态；
- deterministic assertions；
- judge 原文、状态和 evidence；
- provider、版本、耗时；
- 工具调用和 repair 轮次。

## 11. 验收标准

完成本 Spec 必须满足：

1. Agent 在没有 LibreOffice 时可以创建、修改并 finalize 普通 XLSX。
2. Agent 不再通过 Bash 探测 `soffice`，也不运行临时 pip 或旧版 recalc 脚本。
3. 公式型任务没有计算 Provider 时不会假装完成。
4. 任何超时都在硬期限内落盘结果，不留下无限等待进程。
5. judge 不可用不会被计为模型 FAIL。
6. 真实业务矛盾由 deterministic assertion 或 blocking judge 明确指出。
7. H003 的旧误判不再复现；H001/H005 的真实业务失败仍能被阻断。
8. H002/H004/H006 超时报告可区分“模型无交付”和“harness 未能终止”。
9. artifact-tool 的支持边界由真实 fixture 测试证明，而不是由 Codex 会话推断。
10. 文档、Skill、Runtime 和评测报告使用同一套术语和结果模型。

## 12. 风险与回滚

- artifact-tool 公式兼容性不足：保留 LO fallback，不切换默认 Provider。
- artifact-tool 导出破坏样式：Provider 层按文件特性路由，原 XLSX 写入层不变。
- 新评分规则改变历史分数：保留旧报告，只用新 `outcome` 生成新汇总，不覆盖原始证据。
- watchdog 误杀长任务：设置 tool-level progress heartbeat 和宽限期，并记录 kill 原因。
- 无 LO 环境的公式缓存不完整：阻止“公式型完成”，但允许静态分析和明确说明。
