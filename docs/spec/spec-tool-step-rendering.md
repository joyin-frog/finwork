# Spec: 过程时间线 · 工具步渲染修复

> 状态：待审阅
> 日期：2026-06-24
> 范围：会话过程时间线（`app/components/tool-call-step.tsx` + `lib/agent/tools/renderers.ts` + `app/chat/chat-page.tsx` 标题），纯展示层；不改 agent 编排、不改工具行为、不碰红线。

---

## 背景与问题

用户在 **技术模式（`tech`）** 看一次真实回合（已处理 13 步 · 9m22s）时提出 5 个观感问题。逐一定位到代码后，确认 4 个是展示层缺陷（第 3 个的 UI 部分用户在 tech 模式接受，撤回）：

| # | 症状 | 位置 | 根因 |
|---|------|------|------|
| 1 | 每一步都显示「1s」，与标题 9m22s 对不上 | `tool-call-step.tsx:295` `formatMs`；`:135` 徽章；`chat-page.tsx:1048` 标题 | `Math.max(1, floor(ms/1000))` 把 0–1999ms 全压成「1s」无亚秒精度；徽章无阈值满屏显示；标题把「步数」和「整回合墙钟」拼一起，让人误以为可相加（9 分钟大头是两次工具间的模型生成，无步可挂） |
| 2 | 展开里 JSON / 输出全黑无高亮（但代码输入有高亮） | `tool-call-step.tsx:64` `extractCommand`、`:162/177` 纯 `<pre>`、`:300` `formatInput` | 只有 `code`/`command`/`sql` 三个键走 `CommandBlock`（带 `rehypeHighlight`）；其余入参 → `formatInput` → 纯 JSON `<pre>`；**所有输出**恒走纯 `<pre>` |
| 4 | `Exit code 127` / `Python 执行出错 (exit code 1)` 看不懂 | `renderers.ts:134` 报错分支 | 报错摘要 = 工具错误**第一行**截 80 字。该行恰是最没用的退出码；真正能解释失败的 stderr/异常（已在 result 里）被丢弃 |
| 5 | 「运行代码」永远只显示「运行代码」，看不出目的 | `tool-call-step.tsx:29` strip 正则；`renderers.ts:113` `pythonCodeIntent` | renderers 已算出代码意图（且 `tests/tool-renderers.test.ts` 有 `intentSummary` 断言为绿），但 `run_python` 的 strip 正则 `/^(?:运行\|执行) Python(?:[:：][\s\S]*)?$/` 把冒号后的意图**整段删掉**再兜底成「运行代码」——意图算了被扔 |

**非目标 / 已撤回**：
- 问题 3 的 UI 泄漏（Glob/Read 技能内部脚本暴露）——tech 模式用户接受，不动。
- `python` vs `python3`（exit 127）、`recalc.py` 与 SKILL.md 自相矛盾——**功能层 / 技能层问题，另开一条**，不在本 spec。
- `daily` 模式不可展开，问题 2 只在 `tech` 生效；问题 1/4/5 两模式都生效（徽章/步文案在 `hasDetail` 之外）。

---

## 修复 1：时长徽章（阈值门 + 精确格式 + 标题正名）

### 设计方案

**1A — 徽章只显示「值得注意的慢步」。** 改渲染门槛与格式，杀掉满屏「1s」噪声、让真慢步跳出来。

- `tool-call-step.tsx:135` 渲染条件加阈值：`pair.durationMs != null && pair.durationMs >= STEP_DURATION_FLOOR_MS && pair.status !== "running"`，`STEP_DURATION_FLOOR_MS = 3000`。
- `formatMs`（`:295`）给精确值，去掉「最小 1s」钳位：

```ts
// 仅在 ≥ 3s 时被渲染，所以无需再钳 1s；3–60s 给整秒，≥60s 给 Xm Ys
function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
```

- 效果：本 trace 里没有真慢步（慢的 recalc 是 fast-fail），所以一个徽章都不显示——这是对的；真有 40s 的步会显示「40s」并跳出来。

**1B — 标题别让人读成「步数之和」。** `chat-page.tsx:1048`：

```diff
- `已处理 ${toolStepCount} 步${turnDurationMs != null ? ` · ${formatDuration(turnDurationMs)}` : ""}`
+ `已处理 ${toolStepCount} 步${turnDurationMs != null ? ` · 用时 ${formatDuration(turnDurationMs)}` : ""}`
```

`turnDurationMs` 是整回合墙钟（`turn_duration` 事件，见 `query/route.ts` 持久化）。「用时」点明它是总耗时，而非各步相加。

### 可选增强（不在本期最小集，单列）

- **真实子进程耗时**：`run_python` 的真实执行时长在 `run-python.ts` 可精确测，目前展示用的是适配器侧「tool_use→tool_result」消息往返近似（`tool-event-tracker.ts:44`）。如需精确，可让 worker 返回 `elapsed_ms` 并透传，替代往返值。
- **显式「思考」时长**：把 9m22s 里模型生成的占比单独画一行，让总账可读。属较大改动，留待评估。

### 验证
- 单测 `formatMs`：`2999ms→不渲染（门槛由 :135 控制，测格式即可）`、`3000ms→"3s"`、`63000ms→"1m 3s"`。
- e2e `e2e/mock/chat.spec.ts`：过程块展开后，快步无时长徽章、慢步有；标题含「用时」。

### 风险
极低，纯展示。注意 `STEP_DURATION_FLOOR_MS` 取值：3s 能滤掉绝大多数 I/O 噪声又不漏掉人能感知的慢步。

---

## 修复 2：格式感知高亮（问题 2 重点）

### 核心原则

> **展开面板是「原始 I/O 调试视图」**：忠实显示工具真实的输入/输出，只在**确有语言**时上色；纯文本、命中行、stdout 一律不硬上色。折叠那一行才是「人话视图」。

把现在「`code`/`command`/`sql` 才高亮、其余纯 JSON、输出永远纯文本」的窄特例，升级为**按工具类型驱动**的内容分类器，并对未知工具用嗅探兜底。

### 分类器：`classifyToolContent`

新增（建议落在 `tool-call-step.tsx` 或新 `lib/agent/tools/content-format.ts`）：

```ts
type ContentFormat = { lang: string } | { plain: true };
// role 区分入参/输出;两者策略不同
function classifyToolContent(toolName: string, role: "input" | "output", value: unknown): ContentFormat
```

**第一层 — 按工具的 render descriptor（权威，因为我们知道每个工具的形状）：**

| 工具 | 入参（input） | 输出（output） |
|------|--------------|---------------|
| `Bash` | `shell`（`command` 字段） | `plain`（stdout） |
| `run_python` | `python`（`code` 字段） | `json`-if-parses，否则 `plain`（worker 返回 JSON） |
| `Read` | `json`（params） | **按 `file_path` 扩展名**（`py`/`ts`/`tsx`/`json`/`md`/`sql`…），无法识别 → `plain` |
| `Write` / `Edit` / `MultiEdit` | `json`（params） | `plain` |
| `Grep` / `Glob` | `json`（params） | `plain`（命中行/路径，**不是语言**） |
| `WebSearch` / `WebFetch` | `json` | `plain` |
| MCP 财务/金蝶工具（`mcp__*`） | `json` | `json` |
| 兜底（未知工具） | 见第二层 | 见第二层 |

**第二层 — 嗅探兜底**（descriptor 没命中、或字段为空时）：`String(value).trim()` 以 `{`/`[` 开头且 `JSON.parse` 成功 → `{lang:"json"}`；否则 `{plain:true}`。保证未知工具也合理。

> 现有 `extractCommand`（`:64`）本质就是「入参侧 descriptor 的 code/command/sql 三行」，并入分类器后删除或保留为内部分支均可。

### 渲染

- 把现 `CommandBlock`（`:73`）泛化为 `HighlightBlock({ lang, text })`：`` ```${lang}\n${text}\n``` `` 走 `ReactMarkdown + rehypeHighlight`（复用 `CODE_PLUGINS`）。
- `{plain:true}` → 保持现有纯 `<pre>`（等宽、`whitespace-pre-wrap`、`max-h-64`）。
- 入参区（`:152`）与输出区（`:169`）都改为先 `classifyToolContent` 再二选一渲染。

### 判断：grep 到底要不要高亮（用户问点）

| 「grep」指的是 | 决策 | 理由 |
|---------------|------|------|
| Bash 跑的 `grep xxx`（命令串） | **高亮 shell** | 是真实 shell 命令；现已生效（`command` 字段），保持 |
| `Grep` 工具入参 `{pattern,...}` | **高亮 JSON，不重构成假命令** | 展开面板是原始调试视图；把 pattern/glob/output_mode/-i/-A 拼成 `grep …` 会失真，且折叠行已有人话「搜索「xxx」」 |
| grep / 搜索的**输出**（命中行 `path:42:…`） | **不高亮**（纯文本） | 命中行不是某种语言，硬按 bash/任意语言上色是错的、是噪声 |

### 性能护栏（必须）
- 输出先按现有 `slice(0, 2400)`（`:181`）截断**再**高亮。
- 设 `HIGHLIGHT_MAX_CHARS`（如 8KB）：超过则强制 `plain`，避免大文本 + 高亮卡顿。
- `rehypeHighlight` 只在 `tech` 展开面板触发（`daily` 不展开），成本天然受限于「被点开的步」。

### 验证
- 单测 `classifyToolContent`：`Bash/input→shell`、`Bash/output→plain`、`Grep/input→json`、`Grep/output→plain`、`Read/output` 按扩展名、`mcp__finance_worker__x/output→json`、未知工具 JSON 串→json、未知工具纯文本→plain。
- e2e：tech 模式展开「调用技能」「读取文件」，断言出现高亮 DOM（`.hljs` 或 `pre code` 着色类）；展开 grep 输出断言**无**高亮类。

### 风险
中低。重点防两件：① 别把命中行/stdout 误判成语言（靠 descriptor 明确标 `plain`）；② 大输出的高亮开销（靠字符上限 + 截断）。

---

## 修复 4：exit code → 人话

### 设计方案

`renderers.ts:134` 的报错分支，从「取 stderr 第一行」换成 `summarizeToolError(toolName, result)`，**保留 `错误：` 前缀**（`stepDisplayText:266` 仍会剥掉它、靠红色表达错误；`tests/tool-renderers.test.ts` 的 `startsWith("错误：")` 继续绿），只换后半句：

```ts
function summarizeToolError(toolName: string, result: string): string {
  const text = result ?? "";
  // 1) 已知退出码 → 直接人话
  const code = text.match(/exit code (\d+)|退出码 (\d+)/i);
  const n = code ? Number(code[1] ?? code[2]) : null;
  const byCode: Record<number, string> = {
    127: "命令未找到", 126: "无法执行", 124: "执行超时", 137: "被终止（超时/内存）",
  };
  if (n != null && byCode[n]) return byCode[n];
  // 2) shell「命令未找到」文案
  if (/command not found|not found/i.test(text)) return "命令未找到";
  // 3) Python/异常:取最后一条异常行(真正的原因)
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const exc = [...lines].reverse().find((l) => /\w*(Error|Exception):/.test(l));
  if (exc) return exc.slice(0, 80);
  // 4) 实在不知道 → 执行失败（用户口径）
  return "执行失败";
}
```

报错分支变为 `` return `错误：${summarizeToolError(bare, result)}`; ``（`bare` 已在上文 `toolName.replace(/^mcp__\w+__/, "")`，或直接传 `toolName`）。完整错误仍在 tech 展开卡里，这里只修一行摘要。

### 验证
- 扩 `tests/tool-renderers.test.ts`：
  - `exit code 127` 文本 → `错误：命令未找到`
  - `python` traceback（末行 `ModuleNotFoundError: No module named 'office'`）→ `错误：ModuleNotFoundError: …`
  - 无可识别信号 → `错误：执行失败`
  - 现有 `startsWith("错误：")` 保持绿。

### 风险
低。注意第 3 步异常正则别误吞正常输出里含「Error:」的普通行——取「最后一条」+ 仅 isError 分支进入，已收敛。

---

## 修复 5：运行代码意图（改正则 + 收紧意图）

### 设计方案

**5A — 放开 strip，保留意图。** `tool-call-step.tsx:29`：

```diff
- run_python: { icon: CommandLineIcon, strip: /^(?:运行|执行) Python(?:[:：][\s\S]*)?$/, relabel: "运行代码" },
+ run_python: { icon: CommandLineIcon, strip: /^(?:运行|执行) Python[:：]?\s*/, relabel: "运行代码" },
```

只剥「运行 Python：」前缀，保留冒号后的意图；裸「执行 Python」剥成空 → 兜底「运行代码」。这样 renderers 已算好、已被单测覆盖的意图终于能显示。

**5B — 收紧 `pythonCodeIntent`，只在「真有目的」时返回，否则返回 ""（→ 兜底「运行代码」）。** `renderers.ts:113`。现在它把 `path='…2030预测表.xlsx'` 这种纯赋值当意图，丑且无意义。新规则：

1. 若代码引用了表/文件名（`xlsx`/`csv`/`pdf`/`docx`）→ `处理《<文件名>》`（取 basename）。
2. 否则取一条**有动作**的语句（含函数调用 `xxx(...)` 或动词）；纯赋值 / `import` / 注释 / `output_dir` 噪声一律跳过。
3. 都没有 → 返回 ""（兜底「运行代码」）。

正好落在用户原话「知道目的就展示目的，不知道就这么处理没问题」。

### 决策记录
这是**有意推翻**当初「run_python 代码细节是噪声、剥成空」那条决定——用户在问题 5 已确认要展示目的，方向一致，故 5A/5B 一并改，不保留旧行为。

### 验证
- `tests/tool-renderers.test.ts`：保留 `intentSummary`；新增「纯赋值 → ""（经 stepDisplayText 兜底「运行代码」）」「引用 `2030年预测表.xlsx` → 处理《2030年预测表》」「生成文件类不受影响」。
- 注意 5A 是组件层正则，单测覆盖 `pythonCodeIntent` 产出即可；端到端文案由 e2e 兜。

### 风险
低。意图已截断 48 字（`renderers.ts:119`），不会过长。

---

## 落地顺序与统一验证

建议顺序（互不耦合，可单独提交）：**4 → 5 → 1 → 2**（先小后大；2 改面最大放最后）。

每步改完按 CLAUDE.md「改完必跑」：
```
npm test            # 含 tests/tool-renderers.test.ts（4/5 主要靠它）
npm run typecheck
npm run lint
npm run test:e2e    # e2e/mock/chat.spec.ts:过程块展开（1/2 靠它）
```

**红线核对**：本 spec 纯展示层，不取数、不写库、不外发、不碰审批门——八条红线均不触及。唯一需留意的是修复 2 的高亮**不得**改变/截断已有的 result 内容口径（只换渲染外壳，截断仍用现有 2400 上限），避免误伤「数据信任链 / 我不知道」的如实呈现。
