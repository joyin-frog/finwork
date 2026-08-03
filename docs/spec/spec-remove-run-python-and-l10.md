# run_python 下线与 L10 写入串行化 Spec

状态：已实施（2026-08-03）

## 1. 决策

本次变更一次性移除模型可见的 `run_python`，不保留兼容别名、灰度开关或“先运行再逐步替换”的过渡层。原因是任意 Python 同时承担了文件解析、业务计算、文件生成和副作用写入，权限边界、确认语义、产物追踪和评测契约都无法稳定成立。

下线范围包括：工具注册、角色白名单、系统提示、Skill 说明、确认/信任/卡片文案、运行时事件类型、测试与 golden rubric，以及 worker 的通用 `run` 入口。内部 Python 仍可作为固定能力的实现，但只能由明确的 typed service/command 调用，不能接收模型提供的代码。

## 2. 替代契约

| 旧职责 | 新入口 |
| --- | --- |
| PDF/Word/Excel/图片取文本 | `read_document` |
| 结构化表格汇总、分组、统计 | `analyze_tabular`：模型提交结构化 rows 与声明式聚合，不提交代码 |
| 工资、个税、报销、对账、税务、凭证 | 对应领域工具 |
| 工资单、凭证、最终交付文件 | 对应 `export_*` / `finalize_deliverable` |
| 固定 Skill 脚本 | 产品内固定 service；脚本不再作为模型执行入口 |

`analyze_tabular` 只允许有限、可审计的操作（`count/sum/avg/min/max`，可选 `groupBy`），限制行数、列数和数值精度；无法表达的操作必须转为领域工具或明确报告不支持，不能退回任意代码执行。

### 工具命名

Pi 的模型可见工具名使用全局唯一的裸名，例如 `analyze_tabular`、`export_kingdee_draft`。不再暴露 `mcp__`、`finance_worker__` 或 `kingdee_worker__` 前缀；`finance_worker`/`kingdee_worker` 仅保留为内部 handler 来源域和旧 Claude MCP 兼容工厂的实现细节。若未来新增工具名冲突，必须在 catalog 层解决，而不是恢复协议前缀。

## 3. L10：文件写入串行化

L10 统一要求所有会改变用户文件或交付状态的自定义工具，在“读取旧状态 → 计算 → 原子写入/提交”的完整临界区使用 Pi 的 `withFileMutationQueue`：

- 单文件写入按规范化绝对路径排队；同一文件不能并发读改写。
- 多文件导出、`finalize_deliverable` 先规范化并按路径排序，再逐个进入队列，避免锁顺序不一致。
- `Write/Edit` 继续使用 Pi 原生队列；路径安全仍由 Finwork hook 负责。
- 不再保留 `run_python` 的 outputDir 粗锁例外，因为不存在未知文件集合的任意执行入口。
- 只读工具不加写锁；数据库事务和 delivered 不可变规则继续由各自领域服务负责。

## 4. 验收与评测

静态门：仓库生产代码、系统提示、角色工具集和 golden 不再出现可调用的 `run_python`；通用 worker 不再接受代码 stdin。

行为门：`analyze_tabular` 的聚合、行数/列数限制、非法数值和错误输入有单测；L10 有同一路径并发写入测试；已有领域工具回归通过。

真实模型门：优先运行现有 golden 的定向替换用例，使用本机已配置的真实 API key（只读取布尔存在性，不打印 key）。若没有可直接运行的替换用例，新增 `replacement-*` golden，覆盖结构化汇总、领域工具选择和 `run_python` 禁用；无 key 时只允许运行非模型单测，不能宣称真实模型门通过。

## 5. 非目标

本次不实现任意 Python 的安全沙箱，也不把“Skill 里仍可写脚本”包装成模型工具；不借 L10 重构所有数据库写入事务；不为了保留旧 golden 而恢复通用代码执行能力。
