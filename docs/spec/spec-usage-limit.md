# 用量限制 Spec

> 版本 v1.0 / 2026-06-30
> 依赖：`spec-observability-panel.md`（`agent_traces` 的 token 列、`getTraceTokenSummary` 查询模式）
> 架构事实：SQLite 走 `node:sqlite`；前后端走 fetch→API Route；BYO API（用户自配 `apiUrl`/`apiKey`，请求直接计费到用户的 key）

---

## 0. 目标与非目标

**目标**：给 BYO-API 用户一个**累计用量护栏**，防止长期/高频使用把用户自己的 key 烧出意外账单。两个滚动窗口：**5 小时** 与 **一周**。

**非目标（本期不做，已知并接受）**：
- **不做单任务断路器**。无法阻止"单个任务在预算内瞬间烧穿"（如 bug 死循环在 5h 额度内狂烧）。现有 `maxTurns: 30` + 10 分钟超时是仅有的单任务兜底。
- **不做逃生口**。撞墙后硬锁到重置，用户无法调高/关闭/确认放行。

---

## 1. 计量：成本加权"计费 token"

UI 只显示百分比，**绝对 token 数与上限都不对用户暴露**。内部以 token 计（网关无关、可靠），不信任 `total_cost_usd`（自定义网关下不准）。

### 1.1 token 类型权重（贴合官方价比例）

```
billable(行) = tierWeight(model) × ( input
                                   + 5.0 × output
                                   + 1.25 × cache_write
                                   + 0.1 × cache_read )
```

- 比例来自官方价：output≈5×input、cache 写≈1.25×、cache 读≈0.1×（缓存命中不冤枉用户）。
- token 字段取自 `agent_traces`：`input_tokens` / `output_tokens` / `cache_creation_tokens`(写) / `cache_read_tokens`(读)。
  ⚠️ 实现时确认列名：schema 用 `cache_creation_tokens`，`spec-observability-panel.md` 写作 `cache_write_tokens`，以代码实际为准。

### 1.2 模型分两档（粗粒度）

按模型名归档，不按角色槽内部值，而是用**当时设置里的角色槽名**反查：

- 命中 **router 槽模型名** → **快档**（`tierWeight = FAST_WEIGHT`）
- 命中 **主模型 / subagent 槽模型名** → **推理档**（`tierWeight = 1.0`，基准）
- **对不上任何槽 / 未知模型 → 推理档（贵档兜底）**
- 同一模型填多个槽 → 归推理档（偏保守）

`agent_traces.model_usage_json` 按模型名存了每模型 token 明细，逐模型套上式求和。

> 常量 `FAST_WEIGHT` 与下方上限一起写死在代码配置；以推理档 input 价为单位 1.0 归一化。

---

## 2. 窗口：固定重置 + 首次使用懒锚定

两个独立窗口，各存一个 `window_start`：

- **重置语义**：从"重置后首次发请求"那刻起算；`now >= window_start + 时长` 时整体清零，下一个周期在之后首个请求时懒开。
- **5h 窗口** = `window_start_5h + 5h`；**周窗口** = `window_start_week + 7d`。
- **用量现算**，不另存"已消耗"：

```sql
SELECT ... FROM agent_traces WHERE started_at >= :window_start
```

- **重置时刻** = `window_start + 时长`，周期内固定，供浮层显示"Resets X 点 / X 日"与倒计时。
- **升级上线性质**：首次运行 `window_start` 懒锚定为"当下"，历史 trace（`started_at < window_start`）不被回溯计入，无人一升级就被拍停。

---

## 3. 限额（写死、默认开、不可调）

| 窗口 | 上限（计费 token） | 撞墙行为 |
|------|------|------|
| 5 小时 | **1000 万** | 硬锁到重置（最长 5h） |
| 一周 | **5000 万** | 硬锁到重置（最长 7 天） |

- 默认开、用户**不可调高/调低/关闭**，常量写在代码配置。
- **任一窗口超限即拦**（哪个先满哪个拦）。
- 初值先按此起步，后续直接改常量调。

---

## 4. 数据库

新建一行状态表，仅存两个窗口起点（运行时状态，**不放 settings JSON**）：

```sql
CREATE TABLE IF NOT EXISTS usage_windows (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行
  window_start_5h   TEXT,                   -- ISO；NULL = 尚未开窗
  window_start_week TEXT
);
```

窗口推进与用量 SUM 在同一事务内完成。

---

## 5. 拦截链路

**关卡点**：`app/api/agent/query/route.ts` **跑 `runRouter` 之前**（约 line 107）。

1. 请求进来 → 算 5h%、week%、`blocked`、`resetAt`。
2. `blocked` → **直接短路返回拦截事件，不跑 router、不跑 agent**（被拦用户不再花那次分类 token）。
3. 否则照常。

**配套行为**：
- **不打断在跑的任务**（砍了断路器）；正在跑的回合跑完，可能小幅冲过线——已知接受。
- **cheap / router 路径漏算**：该路径 `result` 无 `modelUsage`，token 不进 `agent_traces`、不计入配额。漏的是最便宜流量、方向偏安全（偏向不那么早拦人），**接受不补**。

---

## 6. UI

### 6.1 输入框进度环
- 输入框旁一个**圆形进度环**，显示**更吃紧那个窗口**的 %（`max(5h%, week%)`，clamp 100）。
- 颜色兼做事前预警（**不另发预警消息**）：`<80%` 蓝 / `80–95%` 橙 / `≥95%` 红（满格锁定态）。

### 6.2 点击浮层（Plan-usage 式）
- 点环弹浮层，两条比例条：
  - `5 小时额度 · Resets {时刻} · {NN}%`
  - `每周额度 · Resets {日期} · {NN}%`
- 只显示百分比与重置时间，**不显示绝对 token 数与上限**。
- **heatmap 不做**。

### 6.5 设置·用量页
- 设置中心新增「用量」标签页（`app/config/usage/usage-settings.tsx`），复用进度环的 `UsageDetail`（5h/周两条比例条 + 重置时刻）+ 一句说明。
- 与输入框浮层共用同一 `useUsage` + `UsageDetail`，不重复维护。

### 6.3 撞墙提示
- **渲染在回答正文区、红色字体、不弹窗**。
- 文案示例：`本周期用量已达上限，将于 {重置时刻} 恢复，可稍后再试。`

### 6.4 数据源
- 新增只读 API（如 `GET /api/usage`）返回 `{ fivehour: {pct, resetAt}, week: {pct, resetAt}, blocked }`。
- 前端挂载时取一次、每个回合结束后刷新。

---

## 7. 测试（红线五：先写失败测试）

**策略：纯函数承载算账 + 可注入时钟，把网络/SDK 全挡在测试外。**

1. **可注入时钟**：窗口计算函数接收 `now` 参数，不内部调 `Date.now()`。
2. **配额纯函数**：输入 `{rows[], now, window_start_5h, window_start_week}` → 输出 `{fivehourPct, weekPct, blocked, resetAt}`。种子数据断言：
   - 成本加权比例（output 5× / cache写 1.25× / cache读 0.1×）
   - 未知模型落推理（贵）档
   - 快档权重生效
   - 懒重置边界（刚好到点清零 / 跨周期 / 倒计时余量）
   - 任一窗口超限即 `blocked`
3. **端到端（`FINANCE_AGENT_MOCK_AGENT=1`）**：构造已超限状态 → 发请求 → 断言短路、回红色拦截、**不进 router/agent**。

> 本地跑绿沿用：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true` + venv。

---

## 9. 实现落地差异（v1.0 实现 vs 本 spec 初稿）

| 初稿 | 实际 | 原因 |
|-----|------|------|
| 新建 `usage_windows` 表 | 复用已有 `app_settings` KV（`usage.window_start_5h` / `usage.window_start_week`） | 已有 KV 够用，免建表（红线三/八） |
| 自定义 `blocked` SSE 事件 | 流式只发 `meta`+`done`（携已落库会话）；拦截提示作为 assistant 消息 + `usage_blocked` 事件落库 | `done` 后 `mergeFinalMessages` 重建即带出事件，无需新协议 |
| 进度环颜色 token 未定 | 正常 `--primary` / ≥80% `--tone-warn` / ≥95% `--tone-alarm`；对话红字用 `--tone-alarm` | 对齐 `globals.css` 既有语义色 |
| 开关未提 | 加 `USAGE_LIMIT_ENABLED`（默认开）于 `lib/runtime/flags.ts` | 灰度/急停开关，默认开符合"默认启用" |

**关键文件**：`lib/usage/quota.ts`（纯计算+常量）、`lib/usage/store.ts`（IO 编排）、`app/api/usage/route.ts`（取数）、`app/api/agent/query/route.ts`（router 前拦截）、`app/chat/use-usage.ts` + `app/chat/usage-ring.tsx`（进度环）、`app/chat/chat-page.tsx`（红字渲染 + 接环）。测试：`tests/usage-quota.test.ts`、`tests/usage-store.test.ts`。

## 8. 残留风险（已与需求方确认接受）

1. **挡不住单任务失控**——配额只防累计，不防单任务在预算内瞬间烧穿（即最初的核心诉求未被本期覆盖）。
2. **硬锁无逃生口**——周额度烧穿最长锁死 7 天，撞报税 deadline 会很痛，可能导致卸载。
3. **最后一个任务可冲过线**；**cheap/router 路径漏算**。
