# AS0 离线复核与重评分规则 v1

> 日期：2026-07-29
> 状态：Frozen for Claude/Pi comparison
> 上游：`as0-agent-context-baseline.md`

## 1. 目的与边界

Phase B 的 `attempt-*.json`、`events.jsonl`、`response.txt` 和 `summary.json` 是冻结的 raw
evidence，后续不得修改或覆盖。离线复核只生成派生的 `manual-review.json` 与
`rescored-summary.json`，不调用模型、不执行工具、不改变应用数据。

本规则只处理已确认的评测器口径偏差，不修复、隐藏或放宽 Runtime 的真实失败：

- Skill 未加载继续记为 fail；
- 高风险导出绕过确认继续记为 fail；
- CompletionEvidence 缺失继续记为 fail；
- 强制 compaction 不受支持继续记为 fail；
- 错误工具、无效重试和长期记忆越界继续按 raw evidence 判定。

## 2. Machine rescore

### AS0-R1：准备工具不算首次业务工具

`tool.first` 从实际 toolCalls 中跳过 `Skill`、`Read`、`AskUserQuestion`，再判断第一个业务工具。
这些调用分别是资源加载、输入读取和补充提问，不代表任务选择的业务能力。

不跳过 `Bash`、`run_python`、写文件或任何财务工具；它们会执行实质工作，必须参与首次选择
判定。

### AS0-R2：纯文本 Read 等价入口

AS0-04 的 fixture 是纯文本文件，System Prompt 允许使用内置 `Read`。因此仅对 AS0-04：

- `Read` 可满足 `tool.required.read_document|read_file`；
- `Read` 可满足对应 `tool.first`。

该别名不扩展到 PDF、Word、Excel 或其他任务，也不把任意读取工具视为业务工具命中。

## 3. 人工复核

仅复核 valid attempts 中 raw status 为 `not_observable` 的业务断言。每条结论必须包含：

- task id、attempt、assertion id 和原断言描述；
- response SHA-256，与 raw evidence 完全一致；
- `pass | fail | not_observable`；
- 可审计的简短理由；
- reviewer 与 reviewedAt。

`not_observable` 只用于现有证据不足以得出结论，不能用于回避失败。涉及正式交付、数据库、
文件、确认、终态和 compaction 的断言，必须优先使用结构化 evidence，不以模型自述替代。

## 4. 复算命令

先生成 review 模板：

```bash
npm run eval:as0:rescore -- --baseline artifacts/evals/as0/<baseline-id>
```

填写并复核后生成派生结果：

```bash
npm run eval:as0:rescore -- \
  --baseline artifacts/evals/as0/<baseline-id> \
  --review docs/spec/reports/evidence/<baseline-review>.json
```

工具会验证 baseline id、policy version、断言全集、response hash、重复/缺失结论及理由。
`rescored-summary.json` 同时保留 raw 与 effective machine counts，禁止只发布修正后的数字。
正式 review 应保存为脱敏、可版本化的独立 evidence 文件；不提交 raw response、事件日志或用户
配置。
