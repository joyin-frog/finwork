# AR14 / AS2 Pi-only 上下文精简报告（2026-07-30）

## 结论

AS2 实现已完成，AR14/AS3 进入发布验收。当前本机 Pi-only local gate、MiniMax-M3
真实上下文门及代表性 AS0 回归通过；尚未完成 CI Windows、另一 macOS 架构和完整
20-case golden，因此不能宣称全发布矩阵完成。

## Before / After

使用 AS0 相同快照口径比较：

| 资产 | AS0 before | AS2 after | 变化 |
|---|---:|---:|---:|
| 渲染后静态 Prompt | 4,026 chars / 9,502 bytes | 906 chars / 2,222 bytes | -77.5% / -76.6% |
| Runtime boundary | 34 chars | 0 | 删除 |
| 14 个 Skill listing | 3,092 chars / 7,139 bytes | 1,638 chars / 3,532 bytes | -47.0% / -50.5% |
| 45 个工具定义 | 52,988 chars / 68,863 bytes | 51,317 chars / 65,464 bytes | -3.2% / -4.9% |

Pi 实际 draft-7 payload 的完整工具目录为 42,909 chars / 57,056 bytes。该数值与 AS0
快照序列化格式不同，只作为 Pi 运行预算，不直接计算 before/after 百分比。

确定性渐进披露样本：

| 任务 | Skills | 财务工具 | 处理 |
|---|---:|---:|---|
| 工资计算 | 2 | 10 | payroll 子集 |
| 知识问答 | 0 | 4 | knowledge 子集 |
| 金蝶凭证 | 2 | 17 | voucher 子集 |
| 未知任务 | 14 | 45 | 保守回退完整目录 |

命中 Skill 时，Pi 会额外暴露一个受当前白名单约束的 `Skill` loader；它不计入上表 45 个
财务工具。

## 实现

- Core Prompt 只保留身份、全局安全/准确性不变量、会话/长期记忆边界和交付要求；
  领域 SOP 留在 Skills，参数和结果语义留在工具定义。
- 14 个 Skill 入口统一说明使用/不用场景、输入和完成证据，正文、references 与 scripts
  不做无证据合并。
- 主 Agent 按当前用户消息、router intent 和附件扩展名选择 Skill/工具集合；未知任务保留
  全目录，避免误收窄。
- 角色 Agent 继续使用角色白名单；业务 handler、schema、risk 和授权代码未因精简改变。
- Pi 自定义 system prompt 不会自动注入 Skills（其内置逻辑依赖 builtin `read`，而 Finwork
  禁用了 builtin tools）。Finwork 因此自有化 Skill listing 与受限 `Skill` 工具，避免开放
  任意文件读取。
- 小型 CSV/TSV/TXT/Markdown/JSON 附件直接作为不可信外部上下文注入，避免
  `read_document` 与重复 Python 读取；Office/PDF/图片仍走受控工具。

## 真实回归

模型和 Provider 固定为正式基线的 MiniMax-M3 + Anthropic Messages。

### AS0-08 工资计算

初次精简后模型看不到 Skill listing，出现 `read_document → run_python ×2 → payroll`，
17,320 input tokens / 5 turns。修复 Finwork-owned Skill loader 后：

- 6/6 机器断言通过；
- 工具为 `Skill → calculate_payroll_batch`；
- 加载 `payroll-calc`，无 `run_python`；
- 10,002 input tokens / 3 turns，输入 token 比失败样本下降约 42%。

证据：`artifacts/evals/as0/pi-20260730023313-d5008d8f`。

### AS0-19 会话口径与压缩

- 5/5 机器断言通过；
- 加载 `finance-analysis`；
- 真实发出 `compaction_completed`，压缩前后估算为 7,118 → 536 tokens；
- 压缩后保留“不含税收入”和 `(实际-预算)/预算`；
- 未调用 `remember_convention`，没有风险确认，长期记忆 hash 不变。

证据：`artifacts/evals/as0/pi-20260730024018-d5008d8f`。

旧链路“本次会话口径可能尝试写长期记忆”的问题至此在 Pi-only 语义层修复。

## 发布门

已通过：

- `npm run typecheck`
- `npm run test:pi`
- `npm run eval:ar14:context`
- `npm run eval:ar14:live`
- `npm run build`
- `npm run tauri:prepare`
- `npm run eval:ar13:pi-only`
- `npm run eval:ar14:packaged`
- 代表性 AS0-01/02/08/13/14/19 真实回归

CI 增加：

- Linux checks：AR14 上下文预算；
- Linux Next build：AR13 Pi-only closure；
- Windows：Tauri prepare 后执行 AR14 packaged Pi preflight，再跑既有 runtime smoke。

待完成：

- 当前发布矩阵的 Windows x64 与另一 macOS 架构 CI；
- 完整 20-case、多 attempts golden 与人工断言复核；
- 复杂 Excel/Word/PDF 正式交付门。

本机 `npm test` 在 smoke fixture 初始化阶段被 `workers/.venv` 缺少 `openpyxl` 阻塞；
CI 会按 workflow 创建 Python 3.12 venv 并安装 `requirements.txt`，仍须以远端结果作为全量
单测结论。`npm run lint` 已通过（0 errors，仓库既有 warnings 未纳入本工作包）。

当前产品发布矩阵是 macOS arm64、macOS x64、Windows x64，不包含 Linux 分发包；文档中的
“三平台”统一解释为这三个 target。
