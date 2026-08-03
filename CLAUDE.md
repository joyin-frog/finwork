# CLAUDE.md

## UIUX前端设计
参考 app/globals.css，最好围绕token设计。间距节奏、交互态、界面文案约定见 `docs/ui-conventions.md`。

## Agent skills

### Issue tracker

问题与 PRD 使用 `joyin-frog/finwork` 的 GitHub Issues 管理。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix` 五个标准标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context 布局：根级 `CONTEXT.md`（存在时）与 `docs/adr/`。详见 `docs/agents/domain.md`。

## 任务执行

**默认路径（绝大多数任务）**：主循环直接做——读懂相关代码 → 回复里简述计划与成功标准 → 实施 → 跑测试/真机验证 → 汇报。不落盘 spec、不写 audit、不派子代理。

**按需升级**（满足才用，不叠加仪式）：
- **高风险 diff 加一道独立审查**：改动触及 数据迁移/删除、金额计算、计费、安全、公共契约（共享类型/API schema/DB schema/IPC）时，完成后派 reviewer（全新上下文、只读）审一轮 diff，ship / fix first；fix 至多两轮。写代码者不自审，这条不变。
- **跨会话的大功能先落设计文档**：`docs/spec/design-<名>.md`（决策、功能点、验收），实施时按它拆任务；不再为每个任务写 spec/audit。
- **并行或大批机械改动才派 implementer**：几句话说清目标、允许改动的文件、验证命令即可。
- **大范围探索且不想污染上下文才派 scout**。

**不可省的硬规矩**（历史上真机才抓到迁移撞号、假绿灯、时区偏移）：
- 测试门禁与环境变量见「测试套件跑法」记忆（`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true` + venv）；改迁移前做三查（main 链尾 / 各 worktree 链尾 / 库实际版本）。
- 可在界面观察到的改动必须真机/浏览器验证，不能只靠测试绿。

## 一、先读，再写

模型生成的劣质代码，最大的来源就是还没读懂代码库便开始动手。

阅读你即将修改的文件——是真正地读，而不是略看。复制项目中已有的模式，检查相关导入，确认项目实际依赖了什么，这样你才不会去寻找那些本来就存在的解决方案。

找不到某种既有模式时，应该询问，而不是猜测。

## 二、复制之前，先思考

在敲代码之前，先弄清楚自己到底要做什么。

明确写出你的假设，例如：“添加身份验证”可能有五种不同含义，要说明你选择了哪一种，并指出相应的取舍。

如果确实有不清楚的地方，就停下来询问。不要用一段看似可信的代码填补空白——这种代码往往能通过随手审查，却会在真正关键时出问题。

## 三、保持简单

只编写能够解决眼前问题的最少代码，不要编写试图解决未来所有可能问题的最少代码。

抵制过早抽象；不要为不可能发生的错误编写处理逻辑；在确实需要配置之前，可以先把值直接写清楚。

判断是否过度设计有一个简单标准：如果某个抽象存在的唯一理由是“以后可能会用到”，那你已经做过头了。

## 四、只做必要的手术式修改

代码差异应当与任务允许的范围一样小。

不要修改未被要求改动的内容。保持现有风格，不要顺手重新格式化；一次格式化可能把真正重要的三行改动埋进三百行无关差异中。

检验标准是：你能否说明每一处改动都由当前任务直接要求？如果某一行只是因为“我既然已经改到这里了”，那就撤销它。

## 五、验证

“能运行的代码”与你“以为能运行的代码”之间，差的就是测试。

修复缺陷时，先写出会失败的测试，亲眼确认它确实失败；然后修复问题，再确认它通过。应修复根因，而不是修补表象。

测试真正可能出错的行为，而不是只测试某个构造函数是否设置了字段。如果某段代码很难测试，这反映的是设计问题，而不是可以跳过测试的理由。

## 六、以目标驱动执行

每项任务在编写代码之前，都必须有明确的成功标准。

“增加校验”可以具体化为：“拒绝缺失或格式错误的电子邮件，返回 400 状态码并给出清晰提示，同时测试成功与失败两种情况。”

对于包含多个步骤的任务，先说明计划，让用户能在你花费一小时构建错误方案之前及时发现方向问题。

## 七、调试

出问题时，应当调查，而不是猜测。

完整阅读错误信息和堆栈跟踪；在修改任何内容之前，先复现问题；然后每次只改一处。

不要看到意外的空值就加一个空值判断来掩盖问题。应当找出它为什么为空——否则缺陷只会转移到一个更隐蔽的位置。

## 八、依赖管理

每一个依赖，都是一段你无法控制的永久代码。

添加依赖之前，先确认项目自身或标准库能否实现同样的功能。不要为了避免编写一个微小函数，就引入 `crypto-randomUUID` 之类的包。

确实需要添加依赖时，要说明原因，让这个选择在清单文件中清晰可见，而不是偷偷混进去。

## 九、沟通

说明你做了什么，以及为什么这么做，而不是只丢下一段代码。

即使你严格完成了要求，也要指出值得关注的问题；同时要准确表达不确定性。

“我不确定这个库是否支持流式处理”能告诉用户需要验证什么；“我觉得应该能用”则不能。

## 十、常见失败模式

下面几种模式频繁出现，值得专门命名：

- **厨房水槽（Kitchen Sink）**：重构了半个代码库，而实际只要求增加一个条件判断。
- **错误抽象（Wrong Abstraction）**：复制粘贴两次后，还没弄清规律就急着抽象。
- **乐观路径（Optimistic Path）**：只处理正常路径，忽略 500 错误等异常情况。
- **失控重构（Runaway Refactor）**：一个修复不断扩散，最终波及多个文件。

一旦发现自己落入其中任何一种模式，正确做法都是停下来，而不是硬着头皮继续推进。

---

## CodeGraph

This project uses CodeGraph for local code intelligence. The index lives in the ignored `.codegraph/` directory and is recreated with `codegraph init .` when needed.

Rules:
- For codebase questions, first run `codegraph explore "<question>"` when `.codegraph/` exists. Use `codegraph node "<symbol>"`, `codegraph callers "<symbol>"`, `codegraph callees "<symbol>"`, or `codegraph impact "<symbol>"` for focused source and relationship tracing.
- Prefer the indexed source and call paths, but verify important conclusions against the current source. Treat dynamic dispatch and documentation-only relationships as hypotheses until confirmed.
- Use `codegraph status` to check index freshness and `codegraph sync .` after modifying code. Use `codegraph init .` only when the index is missing or needs a clean rebuild.
- Do not use the retired Graphify workflow or recreate `graphify-out/` in this repository.
