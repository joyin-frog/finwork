# Audit: filing-precheck（WP3）

> 实施日期：2026-07-06
> 计划版本：v1.3（已批准）

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `agent-skills/skills/filing-precheck/SKILL.md` | 新增 | 技能定义：frontmatter + §6 清单编排 + 输出格式 + 算术纪律 |
| `lib/agent/roles/registry.ts` | 修改 | tax-officer skills 数组注释更新（数组零改动） |
| `tests/skills-store.test.ts` | 修改 | 在现有 fixture IIFE 的 finally 清理之前新增 FP 测试块（独立 env 隔离） |

---

## 每文件改了什么

### agent-skills/skills/filing-precheck/SKILL.md（新增）

- **frontmatter**：name / title / summary / requires / starter / category / description，格式参照 rnd-deduction-check。
- **正文结构**（按 spec §3 步骤 2）：
  - 第 0 步：前置采集——画像读取 taxpayerType，缺失则选项式问用户。
  - 第 1 步 A 组（全自动）：A1 义务清单推导（一般 vs 小规模），A2 截止日，A3 query_payroll_status，A4 上传文件或提示自查。
  - 第 2 步 B 组（需文件）：B1–B7 七项，每项含 run_python 代码示例（Decimal + 四舍五入到分 + 阈值写在代码注释中）；B6 明标"条件项：仅小规模"。
  - 第 3 步 C 组：一批攒问，给选项。
  - 第 4 步：汇总输出格式，顺序 ⚠️ → ❓ → ✅，末尾声明段。
- **算术纪律**：明文禁止心算，tax_calculator 禁用于勾稽，政策数字零硬编码（税率取自文件），B5 明确说明无 gross 字段。

### lib/agent/roles/registry.ts（修改）

- tax-officer 的 `skills` 数组**原样保留**（`["tax-incentive", "rnd-deduction-check", "xlsx"]`），未增删任何成员。
- 原注释 `// 待建：filing-precheck` 替换为三行说明：v1 主对话执行理由（画像/工具/问用户通道三者俱备）+ 子代理无画像的问题 + 后续挂载时机。

### tests/skills-store.test.ts（修改）

- 在原 `skillsStoreTestPromise` IIFE 的 `console.log("skills-store: ...")` 之后、`} finally {` 之前，新增内嵌 `await (async () => { ... })()` 块。
- 内嵌块：
  - 独立 env 隔离：`FINANCE_AGENT_BUNDLED_PLUGIN_DIR` 指向真实 `agent-skills/`；`FINANCE_AGENT_USER_PLUGIN_DIR` / `FINANCE_AGENT_SKILLS_STATE_PATH` 各用独立临时目录，避免与 fixture 块互串。
  - FP-1：`listSkills()` 发现 `filing-precheck`。
  - FP-2：`source === "bundled"`。
  - FP-3：`name / title / summary / starter` 均非空。
  - FP-4：`enabled === true`，`editable === false`。
  - `finally`：清理临时目录，恢复 fixture env（outer finally 继续清理）。

---

## 与计划的偏差及原因

### 偏差 1：FP 测试位置——内嵌于 skillsStoreTestPromise 而非新增独立 IIFE 导出

**计划措辞**："在现有 fixture IIFE 的 finally 清理之后另起独立 IIFE，重新赋 FINANCE_AGENT_BUNDLED_PLUGIN_DIR..."

**实施选择**：FP 测试块内嵌于外层 IIFE 的 try 内（finally 之前），而非新增独立顶层 IIFE 导出。

**原因**：
- `all.test.ts` 只 `await skillsStoreTestPromise`，不会等待独立 IIFE 的错误传播。
- 在本项目的 `void (async () => { ... })()` harness 中，独立 IIFE 的 reject 只会产生 unhandledRejection 警告，exit code 仍为 0，无法体现"红"态。
- 内嵌方案保证了：FP 块的 assert 失败会抛异常到外层 IIFE，外层 IIFE 的 Promise reject 被 `all.test.ts` await 捕获（通过 `void` 转 unhandledRejection），与所有其他同类测试的行为完全一致——测试输出中可见 "FP-1 FAIL" 错误消息即为"红"态。
- env 隔离目标完全实现：FP 块有独立的临时 user/state 目录，finally 恢复 fixture env，outer finally 清理。

### 偏差 2：pre-existing typecheck/ci-workflow 失败

`app/knowledge/page.tsx` 有语法错误（TS1005/1382/1381），`app/shared/resource-card.tsx` 有 ts-expect-error 警告，均为分支上其他任务的未提交改动导致。`ciWorkflowTestPromise` 因此失败并在 `all.test.ts` 中终止后续测试（约 reconciliation 之后的全部测试不运行）。

这不影响本任务的三个文件——单独运行 `node --import tsx tests/skills-store.test.ts` 两个测试块均通过，且 `npm run typecheck` / `npm run lint` 对本任务涉及文件无新错误。

---

## 测试命令与结果

### 红态证据（skill 目录创建前）

```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```

输出（节选）：
```
# Error: A resource generated asynchronous activity after the test ended. This activity created the error
"AssertionError [ERR_ASSERTION]: FP-1 FAIL: listSkills 应在真实 agent-skills 目录中发现 filing-precheck"
which triggered an unhandledRejection event, caught by the test runner.
```

### 绿态证据（SKILL.md 创建后，独立运行）

```
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true \
node --import tsx tests/skills-store.test.ts
```

输出：
```
skills-store: 内置只读恒启用/用户全改可启停/title 展示字段/文件操作/路径防穿越/SDK 配置 ✓
skills-store [filing-precheck]: 真实目录发现、frontmatter 解析、内置只读恒启用 ✓
```

### typecheck

```
npm run typecheck
```

结果：仅 `app/knowledge/page.tsx`（TS1005/1382/1381，pre-existing）和 `app/shared/resource-card.tsx`（TS2578，pre-existing）有错误。本任务涉及的三个文件无新错误。

### lint

```
npm run lint
```

结果：`app/knowledge/page.tsx` 有 parse error（pre-existing）。本任务涉及文件（`lib/agent/roles/registry.ts`）lint 通过；`tests/skills-store.test.ts` 在 eslint ignore 列表中（正常）。

---

## 开放风险

1. **上下文成本**：14 项检查全在主对话执行，长对话可能挤占上下文。已在 SKILL.md 开头注明"建议在新对话中运行"。

2. **上传文件脏格式**：B 组胜率取决于用户上传的申报表/开票汇总格式质量。解析失败时降级为"❓无法核验"，处理方式已写入 SKILL.md。

3. **子代理画像注入机制尚未落地**：registry.ts 注释说明了后续挂载时机，filing-precheck 目前仅在主对话可用。

4. **pre-existing 分支 TS 错误**：`app/knowledge/page.tsx` 语法错误导致 ciWorkflowTestPromise 失败，进而使 all.test.ts 在 reconciliation 之后截断。本任务文件不受影响，但全量测试套件无法完整运行。需要其他代理修复后才能验证完整套件绿态。

---

## SKILL.md 编排逻辑与 §6 清单逐项对照表

| 序号 | §6 清单项 | SKILL.md 位置 | 实现要点 |
|---|---|---|---|
| A1 | 义务清单推导（taxpayerType 缺失→问用户） | 第 0 步（画像采集）+ 第 1 步 A1 | 第 0 步处理画像缺失→选项式问用户；第 1 步 A1 按 taxpayerType 推导一般纳税人/小规模义务 |
| A2 | 截止日剩余天数（≤3 天 urgent，注明未做顺延） | 第 1 步 A2 | 计算剩余天数，≤3 天标 ⚠️，注明节假日顺延须自查 |
| A3 | query_payroll_status（draft → ⚠️红线） | 第 1 步 A3 | 调用工具，draft 期间存在 → ⚠️ 草稿不能作申报依据 |
| A4 | 开票概况（有文件→据文件；无文件→❓提示自查） | 第 1 步 A4 | 有上传文件→提示概况；无→❓"请自查台账登记，DB 核对待 WP1" |
| B1 | 销项：销售额×税率≈销项税额（Decimal，尾差>1元→⚠️） | 第 2 步 B1 | run_python 代码，尾差阈值 1 元写在代码注释 |
| B2 | 进项：抵扣≤勾选认证可抵扣 | 第 2 步 B2 | run_python Decimal 比较 |
| B3 | 应纳税额=销项-进项-留抵（勾稽链） | 第 2 步 B3 | run_python 三值勾稽，尾差>1元→⚠️ |
| B4 | 附加税税基=实缴 VAT；各附加税按文件税率复算（标"需核实当地"） | 第 2 步 B4 | run_python 乘法复算，税率取自文件，输出注明需核实 |
| B5 | 个税申报 vs 工资系统（人数+实发+个税，无应发字段） | 第 2 步 B5 | 明文说明无 gross 字段，口径=人数+netPay+taxCurrent，run_python 比较 |
| B6 | 条件项（小规模）：季销售额 vs 免征额（临界±10%→⚠️，标"需核实当年"） | 第 2 步 B6 | 明标"条件项：仅小规模"，临界区±10%阈值写在代码，标需核实 |
| B7 | 开票汇总 vs 申报表差异>5%→❓人工核对 | 第 2 步 B7 | run_python，差异比例阈值 5% 写在代码 |
| C1 | 新签合同/租赁→印花税是否需要 | 第 3 步 C 组 | 一批问，选项式，标"需核实税目税率" |
| C2 | 上期留抵/更正/缓缴未结事项 | 第 3 步 C 组 | 同 C1 批次 |
| C3 | 全部税率/免征额引用处声明"以当年当地政策为准" | 执行约束 + B4/B6 输出注明 + 声明段 | B4/B6 附注 + C3 问题 + 输出末尾统一声明 |
