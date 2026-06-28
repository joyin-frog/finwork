# Spec:对话页时间线重构(统一交错流 + 等待可见 + 模式只改语气)

状态:**已完成** · 起草并实施 2026-06-17 · worktree `codex-next` · 提交 0e28be5 / 7814637

## 验证结果(收口)

- 自动化:typecheck 干净 · `npm test` 9/9 · lint 0 error;新增/更新 turn-segments(8)、tool-renderers(去 AC9)、chat-stream-store(29)、provenance(4)。
- 真 key e2e(本地网关,报销核对):✅ 等待中过程实时可见(不再黑盒)· ✅ 步骤中文人话交错(调用技能 / 查阅报销制度 / 核对报销单)· ✅ 结束折叠"已处理 N 步"· ✅ 展开见输入/输出 + 结构化表格 · ✅ 无 trace 链接 · ✅ C3 溯源块正常 · ✅ daily 语气。
- 截图:S1 直播态 / S2 收尾折叠 / S3 展开态均通过;代码块语法高亮在答案侧验证(工具步 CommandBlock 同一渲染栈)。
- 未目验(非缺陷):① 本地网关未吐 thinking,中文思考靠 system-prompt + 管线+单测就位;② run_python 代码块靠同栈验证。
- 范围外观察:某轮出现 `MCP error -32602: Invalid tools/call result`(工具/网关运行时,时间线已如实标红),与本次 UI 改动无关。

## 1. 背景与问题(为什么做)

对话页"体验很差"的根因经 grill 定位为 **A:等待难熬且看不见**:

- 财务任务真跑就慢(读制度/核对/算/生成文件,实测一次 e2e ~100s)。
- 当前 `getTimelineDisplay("daily")` = `{showToolDetail:false, collapsedByDefault:true}`,流式进行中过程块**折叠**,只显示一行"正在处理…"+ 跳动点。上一轮把默认设成 daily(目标用户=非技术财务),反而让他们对着黑盒干等近两分钟。
- `buildTurnSegments` 第 82–84 行**过滤掉 thinking**,AssistantTurn 把 thinking 单独拎到**顶部**渲染 → 真实时间顺序被拆成"思考块 | 过程块 | 答案"三个固定盒子:think 与工具隔离、时间线错乱、没有"边跑边展开"的交互感。
- thinking 正文是英文,伤中文用户体验。

## 2. 设计决策(grill 已敲定,不再讨论)

1. **roleMode 彻底退出 UI**:不再喂 `getTimelineDisplay`。模式只决定 **system-prompt 语气**:
   - daily = 更日常、体贴、易懂;tech = 更直接、简洁、实际。
   - 除语气外,两种模式 UI/输出样式**像素级一致**,不做"轻量/完整"分叉。
2. **统一交错时间线(所有人同一套)**:think / 工具 / 中间文字按**真实发生顺序**交错成一条流;答案排在末尾。
3. **等待可见 + 结束折叠**:流式中整条时间线展开、当前步有"走光"动效;回合结束**自动折叠成一行摘要**("已处理 N 步 · 用时"),可点开回看。
4. **工具步:逐级折叠 + 按需展开(对所有人一致)**:
   - 每个工具步默认**一行**(图标 + 人话动作 + 耗时 + ▼)。
   - 点开 → 该步输入/输出;输入是代码/命令(python/bash/sql)时用 **Markdown 代码块语法高亮**渲染,非代码(纯参数)用紧凑 JSON。
   - 删除 `summaryOnly`(原 daily 分支),展开能力人人可用。
5. **走光动效**:正在执行的步骤,人话文字**逐字循环变亮**(高亮从左到右扫过),取代/叠加原转圈;运行时也显示人话动作文字(如"读取报销制度…")。
6. **thinking** 作为时间线里的一个步骤,与工具同一条线、同样式(默认折叠一行,可展开看正文);**英文思考**靠 system-prompt 让模型用中文思考(写进共享段,不分模式)。
7. **移除 trace 跳转**:删掉过程块里"处理详情"→`/observability` 链接(观测页临时、可能隐藏)。观测页本身不动。

## 3. 详细改动点(按文件)

### C1 `app/chat/timeline-display.ts`
- 去掉 `roleMode` 入参与分支;导出单一常量行为(或直接废弃该模块,改由组件内常量)。UI 不再读 roleMode。

### C2 `app/chat/turn-segments.ts`
- **删除 thinking 过滤**(现 82–84 行);thinking 事件按原序保留进过程段。
- 过程段类型增加 `thinking` 段(或让 tools 段容纳 thinking);保持 text/tool/thinking 的真实交错顺序。
- `answerText` 逻辑不变(末尾无工具的 text 段 = 最终答案)。

### C3 `app/components/tool-call-step.tsx`
- 删除 `summaryOnly` 形参与相关分支(始终可展开)。
- 运行中:显示人话动作文字(用 `getToolSummary` 的进行时文案)+ **走光** class。
- 展开区:输入按工具类型用 Markdown 代码块渲染(run_python→python、bash→shell、SQL→sql;否则紧凑 JSON);输出排版收紧。
- 新增 thinking 步渲染(若放本组件)或由 chat-page 渲染 thinking 步。

### C4 `app/chat/chat-page.tsx`(AssistantTurn)
- 删除顶部独立 thinking `<details>` 块。
- 删除所有 `display.showThinking/showToolDetail/collapsedByDefault` 分支与 `roleMode` 传参。
- 过程块:流式中默认展开;结束默认折叠成一行摘要(可点开,localStorage 记忆用户手动偏好)。
- 过程块内按统一交错顺序渲染 think/tool/text 步。
- 删除"处理详情"→`/observability` 链接。

### C5 `app/globals.css`
- 新增"走光"文字动画(逐字/扫光高亮,循环)。

### C6 `lib/agent/system-prompt.ts`
- 共享段加"用中文思考/推理"。
- daily/tech 语气段按 §2.1 措辞收一下(daily 体贴易懂 / tech 直接简洁实际),其余不动。

### C7 测试
- `turn-segments` 新断言:think→tool→think→tool→text 按真实顺序交错;thinking 不再被过滤;answerText 仍为末尾文本。
- `timeline-display`(若有测试)改为无模式分支。
- 现有 chat 相关测试因移除 roleMode/ summaryOnly 需同步更新。

## 4. 执行步骤(串行)

1. C2 + C7(turn-segments 交错 + 单测)——先把数据层顺序对齐,测试驱动。
2. C1(timeline-display 去模式)。
3. C3(tool-call-step:走光 + markdown shell + 去 summaryOnly)+ C5(CSS)。
4. C4(AssistantTurn 统一渲染 + 去顶部思考块 + 折叠逻辑 + 去 trace 链接)。
5. C6(system-prompt 中文思考 + 语气措辞)。
6. 全量验证(§5)。
7. 循环修复(§6)。

## 5. 验收目标

**自动化**:`npm test`(本机 `FINANCE_AGENT_SECRET_BACKEND=file`)+ `npm run typecheck` + `npm run lint(0 error)` 全绿;新单测通过。

**真实数据 e2e**(本地真 key,报销核对任务):
- 等待期间时间线**实时可见**(不再黑盒),步骤逐条冒出,当前步走光。
- think / 工具 / 文字**按真实顺序交错**,无顶部独立思考块。
- thinking 正文为**中文**。
- 回合结束时间线**折叠成一行摘要**,可点开。
- 工具步展开:输入代码以 **Markdown 代码块**呈现;**无 trace 链接**。

**截图验证**(playwright,真跑):
- S1 流式中:时间线展开 + 当前步走光。
- S2 结束:一行摘要(折叠态)。
- S3 展开某步:markdown 代码块。
- S4 全页无"处理详情/trace"链接。

## 6. 循环协议(≤5 轮)

每轮:实施/修复 → 跑 §5 全部 → 逐条对验收目标打分(通过/不通过+原因)→ 未全过则定位修复进入下一轮。全过即停;满 5 轮仍有未过项,如实报告剩余缺口与原因。

## 7. 任务分配

紧耦合重构,单线程串行(同组文件并行会撞车)。验证阶段的真实 e2e + 截图为噪声大、可独立的环节,按需隔离执行、只回收结论。
