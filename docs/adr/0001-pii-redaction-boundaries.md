# ADR 0001 — PII 脱敏边界

**状态**: 已接受  
**日期**: 2026-06-15

## 背景 (Context)

**产品模型**: 单机桌面财务工作台,面向 1–4 人财务团队。SQLite 数据库仅存于用户本机,无云端同步。

**PII 类型**: 手机号、身份证号、银行卡号、电子邮箱(正则可识别);姓名、地址(未纳入当前正则,见已接受差距)。

**外部出口**:
1. **外网出口** — 用户配置的 LLM 网关(任意 Anthropic 兼容端点),包括:路由分类请求、主模型请求。
2. **本地导出文件** — 可观测性导出接口(`/api/observability/export`)生成可下载/可分享的 JSON。

## 决策与边界映射 (Decision / Boundary Map)

| 存储 / 传输路径 | 是否脱敏 | 依据 |
|---|---|---|
| `agent_traces.user_message` / `final_answer` | **是** — 落盘前脱敏 | `lib/observability/trace-write.ts` 调用 `redact()` |
| `agent_spans.input_summary` / `output_summary` / `error` / `error_message` | **是** — 落盘前脱敏 | 同上 |
| 路由分类 LLM payload + `model_routing_log.user_message` | **是** — 出网前脱敏 | `lib/agent/router.ts` 调用 `redact()` |
| `chat_messages` / `chat_agent_events` | **否** — 原文保留 | 见下方「接受」决策 |
| 本地诊断导出 | **否** — 完整数据库快照 + 白名单日志 | 本地支持包,含醒目警告;见 `docs/retention-and-diagnostics.md` |
| 主模型出口(税务/对账的完整 prompt) | **否** — 刻意不脱敏 | 见下方「接受」决策 |

### 接受的未脱敏情况

1. **`chat_messages` / `chat_agent_events` 原文落盘**  
   这两张表为会话历史与事件回放提供数据源。单机单用户桌面场景下,本机访问权限即为数据访问边界。若纳入脱敏会破坏历史回溯与会话重放能力。  
   **风险缓解**: 这两张表从不出现在可观测性导出路径中(由测试守卫,见下文)。

2. **主模型完整 prompt 不脱敏**  
   税务计算与银行对账工具需要真实的账号/金额才能正确执行。脱敏会导致工具失效。  
   **风险缓解**: 用户对其所配置的 LLM 网关具有知情同意。

### 已接受的差距 (Accepted Gaps)

- 当前正则不覆盖**姓名与地址**。在单机本地威胁模型下接受此差距;如需扩展可在 `lib/safety/pii.ts` 补充规则。

## 不变量 (Invariant) — 由测试守卫

> **导出路由 (`app/api/observability/export/route.ts`) 绝对不得读取 `chat_messages` 或 `chat_agent_events`。**

该约束由 `tests/safety-redaction.test.ts` 的静态源码检查持续守卫。

## 结果 (Consequences)

- 本地 SQLite 中 `chat_messages` / `chat_agent_events` 含明文 PII;单机桌面威胁模型下接受。
- 可观测性导出文件(用户可分享)只含已脱敏的 `agent_traces` / `agent_spans`,可安全分享。
- 正则脱敏不覆盖姓名/地址 — 已接受差距,未来可按需扩展。
