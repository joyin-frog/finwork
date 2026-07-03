# Spec: 会话过程区打磨 · 向 Claude/Codex 看齐（第一期）

> 状态：待审阅
> 日期：2026-07-03
> 范围：过程时间线展示层（`app/components/tool-call-step.tsx`、`app/chat/turn-segments.ts`、`lib/agent/tools/renderers.ts`、`app/globals.css` token 消费处）。纯展示层，不改 agent 编排与工具行为。
> 前置：延续 [spec-tool-step-rendering.md](spec-tool-step-rendering.md)（时长徽章/高亮/报错摘要）与 [spec-typography-spacing-system.md](spec-typography-spacing-system.md)（token 体系）。

## 背景

以真实会话 65（单据识别记账汇总，26 步/9m5s）实机对照 Claude 与 Codex 的输出 UI，结论：结构骨架同路线（过程默认折叠、追问卡、溯源面板），差距集中在过程区展开后的"编辑功力"。本期修 6 个 P0，全部有实机截图证据。

## 修复项（P0）

### 1. 过程步骤行字号升到正文档

**现状**：步骤行用 `text-small`（0.8125rem/1.3），比正文 `--text-body`（0.875rem/1.6）小一档且行高局促。
**改法**：步骤标题行改用 `text-body` token（`tool-call-step.tsx` 的 `.text-small` 步骤行类，L102/L187 等处）；展开的详情区（输入/输出/错误）保持 `text-small` 形成层级。行间距随 token 的 1.6 行高自然放松，不额外加 margin。
**成功标准**：步骤标题行 computed font-size = 14px、line-height ≥ 1.5；详情区仍为 13px；用 preview_inspect 验证。

### 2. 展开 chevron 仅 hover/focus 显示

**现状**：每行右侧 `ChevronRightIcon` 常驻，26 行 26 个箭头，扎眼。
**改法**：chevron 默认 `opacity-0`，`group-hover:opacity-100` + `group-focus-visible:opacity-100`（行按钮已有 `group` 类）；加 `transition-opacity`。触屏无 hover：加 `@media (hover: none)` 下保持可见（或 `pointer-coarse:opacity-60`）。行本身仍整行可点，chevron 只是提示件。
**成功标准**：默认态截图无箭头；hover 行出现；键盘 Tab 聚焦也出现；行可点区域不变。

### 3. 过程叙事换源：正文进展句为主，thinking 降权（经讨论修订）

**现状**："Preparing to process documents" 等模型 thinking 首行（英文）与中文工具行交错。
**设计共识**：Claude/Codex 的"知道模型在干什么"不是靠展示 thinking，而是靠模型在工具动作之间主动输出的**正文短句**（"Looks correct—…"是正文段）。叙事不能删，要换源：
- **3a 叙事来源（提示词层）**：`lib/agent/SYSTEM_PROMPT.md` 增加规则——每个工具阶段之间输出至多一句中文进展（说接下来做什么/刚发现什么），禁止英文进展句。`turn-segments` 的 text 段管道现成，渲染无需改。
- **3b thinking 降权（渲染层）**：thinking 段标题不再展示模型原文首行，统一「思考」+ 时长徽章；原文进入展开详情。与 Claude 行为一致（它从不拿 thinking 当步骤标题）。
- **3c 兜底（渲染层）**：工具组若无前置正文叙事句，组标题使用第 7 项的确定性分组摘要（「检索科目表 ×11」），保证任何时刻过程区都有可读叙事。
**成功标准**：过程列表折叠态不出现英文句子标题；有正文进展句时按原序显示为正文段；无叙事句的工具组有分组摘要标题。

### 4. 失败行聚合与"已恢复"降级

**现状**：4 个连续猩红「执行失败」平铺（实为同因 topK 重试且已恢复），像重大事故；Claude 不展示这种噪音，Codex 折叠重试。
**改法**：纯函数（新增 `app/chat/step-aggregate.ts` 或并入 turn-segments）：
- 连续 N 个「同工具且 isError」的步骤合并为一行「<工具名> 重试 ×N」；
- 失败步骤之后存在**同工具成功**步骤 → 该失败行降级为灰色（`text-muted-foreground`）+ 后缀「已恢复」，不再用 `tone-alarm` 红；
- 红色仅保留"该工具在本回合最终仍失败"的情形。
**成功标准**：会话 65 数据回放：4 个 search_knowledge 失败折成一行灰色「检索知识库 重试 ×4 · 已恢复」；终局失败用例仍红。纯函数单测覆盖：连续同因合并/穿插不合并/恢复降级/终局保红。

### 5. 检索类步骤标题动词化

**现状**：`search_knowledge`/`query_knowledge` 把原始 query 当标题（「手续费 财务费用 6603」「应付职工薪酬 工资 2211.01」），外行不可读。
**改法**：`renderers.ts` 补条目：`search_knowledge` → `检索知识库：<query 截 24 字>`；`query_knowledge` → `查询知识库：<command 里首个 rg 模式或截断>`；`read_file` → `读取资料：<fileName>`。风格对齐现有中文 renderer（动词开头）。
**成功标准**：renderer 单测断言三个工具输出以动词开头且含截断参数；不再出现裸 query 标题。

### 6. 错误详情剥壳

**现状**：展开失败步骤直接裸吐 `<tool_use_error>…</tool_use_error>` XML 与转义 JSON 字符串。
**改法**：详情渲染前：剥 `<tool_use_error>` 包裹；内容若是合法 JSON 字符串则 parse 后 pretty-print（2 空格缩进）；MCP `-32602` 之类校验错误提取 `message` 字段为首行。纯函数 + 单测。
**成功标准**：会话 65 的 Unknown skill 错误展开后无 XML 标签；topK 校验错误首行是人话（"Too big: expected number to be <=5"）。

## 第二组（P1/P2，经用户确认并入本期实施）

7. **步骤分组摘要（Codex 向）**：连续同类工具步骤合并为组，组标题带确定性摘要与统计（「识别 3 份单据 · 14s」「检索科目表 ×11 · 含 4 次重试」），组内保留逐步明细。与第 4 项失败聚合同一纯函数域。
8. **消息底部工具条 hover 显现**：现有 复制全文/赞踩 操作区（chat-page.tsx L1500 附近）默认隐藏，hover 消息块或键盘聚焦时淡入；触屏保持可见。补相对时间戳灰字。
9. **ask-user 已答摘要**：「已确认 N 项」折叠标题追加所选答案摘要（「只做明确项 · 我来补日期」，超长截断）。数据在 ask_user_answered 事件里现成。
10. **文件卡层级**：名称为主行，类型行灰字（`电子表格 · XLSX · 6.4 KB`）；主操作按钮与更多下拉分层。
11. **交付卡摘要 chips**：`export_voucher_list` 产物卡显示 sheets/凭证笔数（数据源 = 该工具 tool_result 的 structuredContent，已持久化在 timeline，前端读取即可，不新增后端接口）。
12. **单据缩略图内联**：`read_document`/`Read` 图片类步骤在展开详情顶部内联缩略图（复用现有文件服务路由；执行前先定位 chat_attachments/资料页的文件 URL 路由，无现成路由则此项降级为"路径 chip 可点击跳资料页"）。
13. **颜色纪律清扫**：过程区仅灰阶 + 终局失败红；检查无其他彩色泄漏。
14. **答案区阅读节奏**：`.md-content` 段间距/列表缩进按 spec-typography-spacing-system 收尾项微调（token 级，不引入新值）。

**已核实无需做**：shimmer 加载态已存在（`fa-shimmer-text`「正在思考+实时计时」）；赞踩/复制工具条已存在（只做 hover 显现改造）。

## 测试与验收

- 纯函数（聚合/剥壳/renderer 文案）走 `tests/*.test.ts` 常规约定（node:assert IIFE，注册进 all.test.ts）。
- 样式类改动走源码契约断言（现有 `tests/` 中已有同风格先例）+ preview_inspect 实测 computed style。
- 验收基准：用会话 65 的真实事件数据回放（可从 chat_agent_events 导出 fixture 进 `docs/spec/fixtures/`），折叠态截图对比本 spec 附带的三张现状截图。

## 非目标

- 不改 agent 编排、路由、工具行为（上一批 commit 已处理）。
- 不动 daily/tech 模式的信息披露边界（沿用 spec-tool-step-rendering 的决定）。
- P1/P2 备选项不在本期实施，另立 spec。
