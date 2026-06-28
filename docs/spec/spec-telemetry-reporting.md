# Spec: 匿名遥测上报(纯指标)+ 接收端契约

状态:**v2(决策落定,可开工)** · 目标读者:finance-agent 上报侧实现者 + 独立接收端项目实现者
关联红线:**7 合规驻留**(不外发敏感数据)· **8 审计落点**(出网要落审计)

---

## 0. 一句话

finance-agent 在用户**显式开启**后,启动时把**纯运行指标**(token / 成本 / 时延 / 错误 / router 路径 / 工具调用统计)上报到用户自建的接收端,用于分析与优化。**绝不上报会话内容、财务数据、PII。**

本 spec 是发送端与接收端唯一的耦合点(契约)。两边各自照此实现与自测,最后只对接网络 / 鉴权 / endpoint 三根线。

---

## 1. 设计决策(已拍板)

| 决策 | 结论 |
|---|---|
| 数据档位 | **纯指标**。不含 `user_message` / `final_answer` / span 的 `input_summary` / `output_summary`。 |
| 开关默认 | **默认关**。关→开切换时弹明确说明,用户确认后才生效。 |
| 脱敏策略 | **白名单**。只上报本 spec 列出的字段,其余一律不传。新增字段默认不外泄。 |
| 耦合方式 | 版本化契约(`schemaVersion`),非 monorepo。接收端按版本兼容。 |
| 接收端 | 独立仓库 `../finance-agent-telemetry`,Node+TS+SQLite,Docker,**无登录**。 |
| 多客户端 | finance-agent 可能多公司/多人用 → 接收端按 `installId` 分客户端切片分析(对应红线"谁"维度)。 |
| 本仓库观测页 | 上报功能完成后**删观测页 UI + 其 API 路由**,但**保留 trace/span 数据采集层**(上报数据源)。见 §12。 |
| 错误/issue 工作流 | 接收端**自有 DB + 状态机**,不开 GitHub issue。见 §10。 |
| 节点形态 | **状态流转看板/列表**(非可视化节点图)。见 §10。 |
| AI 优化闭环 | **报告 + 半自动**:接收端出 MD 报告 + 可粘贴 Claude Code 提示词;人本地跑 Claude Code 优化;服务器不碰仓库凭证。见 §10。 |
| 自动更新 | **本轮完整打通** Tauri updater + 人工审核;**签名私钥由用户跑命令生成**,代码侧全就位。见 §13。 |
| 前端设计 | 按 https://vercel.com/design.md;缺组件引 shadcn skill。见 §14。 |

---

## 2. 契约:Payload 结构

### 2.1 顶层信封(envelope)

```jsonc
{
  "schemaVersion": 1,            // int,契约版本。字段语义变更 → +1
  "installId": "uuid-v4",        // 匿名安装 ID,随机生成,存本机设置,永不绑定真实身份
  "appVersion": "0.1.1",         // package.json version
  "platform": { "os": "darwin", "arch": "arm64" },
  "reportedAt": 1718841600000,   // 上报时刻 epoch ms
  "window": { "from": 1718236800000, "to": 1718841600000 }, // 本批覆盖的时间窗
  "traces": [ /* TraceMetric[] */ ]
}
```

### 2.2 TraceMetric(白名单 —— 仅以下字段可上传)

```jsonc
{
  "traceId": "uuid",            // 随机 UUID,无语义
  "conversationId": "uuid",     // 随机 UUID,无语义
  "startedAt": 1718800000000,
  "totalMs": 4231,
  "status": "ok",               // "ok" | "error" | ...(枚举,透传现有 status)
  "roleMode": "analyst",        // 枚举 / null
  "modelUsed": "claude-...",    // 模型 ID 字符串
  "routerPath": "fast",         // router 分级路径(枚举字符串)
  "numTurns": 3,
  "llmCallCount": 2,
  "toolCallCount": 5,
  "inputTokens": 1200,
  "outputTokens": 800,
  "cacheReadTokens": 0,
  "cacheCreationTokens": 0,
  "totalCostUsd": 0.0123,
  "errorMessage": null,         // ⚠️ 上传前必须过 redact() + 截断 200;无错为 null
  "modelUsageJson": "{...}",    // 纯数字统计串,透传
  "spans": [ /* SpanMetric[] */ ]
}
```

**永不出现的字段(发送端必须剔除,接收端必须拒绝/忽略):**
`userMessage` / `user_message` / `finalAnswer` / `final_answer` / `inputSummary` / `outputSummary` / 任何工具入参原文。

### 2.3 SpanMetric(白名单)

```jsonc
{
  "spanType": "tool_call",      // memory|llm_call|tool_call|stream|router|compact|hook
  "name": "reimbursement_check",// 工具/阶段名,枚举性质;截断 200
  "startedAt": 1718800001000,
  "durationMs": 320,
  "tokens": 150,
  "error": null                 // 已 redact;无错为 null
}
```

> 第一版**不含** span 的 `input_summary` / `output_summary`(即便已 redact+截断)。等指标不够用再走"脱敏文本档"另开 spec。

---

## 3. 契约:接口

### 3.1 `POST {endpoint}/api/ingest`

> `endpoint` 配接收端基址(如 `http://host:3000`),实际路由为 Next.js 的 `/api/ingest`。

- **Headers**:`Authorization: Bearer {token}`、`Content-Type: application/json`、`X-Schema-Version: 1`
- **Body**:§2 的 envelope
- **鉴权**:共享 token(发送端设置里配置,接收端校验)。token 不匹配 → `401`。
- **幂等键**:`(installId, traceId)`。重复上报同一 trace → 接收端去重,不报错(返回 200 + 标记 deduped)。
- **schemaVersion 不识别** → `400`,body 带 `{ error, supportedVersions }`。

**响应:**
```jsonc
// 200
{ "accepted": 12, "deduped": 3, "appErrorsAccepted": 4, "appErrorsDeduped": 1 }
// 400
{ "error": "unsupported schemaVersion", "supportedVersions": [1, 2] }
// 401
{ "error": "unauthorized" }
```

> **支持版本 `[1, 2]`**。v2 在 v1 基础上**加法新增** `appErrors[]`(见 §16),v1 envelope 仍合法。接收端按版本兼容,v1 无 appErrors 字段即可。

### 3.2 错误 / 重试语义(发送端)

- 任何非 2xx 或网络失败:**静默吞掉,不阻塞启动**(best-effort,同 `writeSpan`)。
- 不做激进重试;下次启动按时间窗补传未确认的 trace。
- 节流:每个 `installId` **每天最多上报一次**,只传上次成功上报之后的增量 trace。

### 3.3 仪表盘(接收端,非契约,自由实现)

`GET /dashboard`:错误率、P95/P50 时延、成本趋势、模型分布、工具失败 top N、routerPath 分布。

---

## 4. 发送端实现要点(finance-agent)

1. **设置**:`ClaudeSettings` 增 `telemetryEnabled:false`(默认)、`telemetryEndpoint`、`telemetryToken`、`telemetryInstallId`(首启随机生成)。`lib/settings/claude-settings.ts`。
2. **首开说明**:开关 关→开 弹确认框(传什么 / 不传什么 / 传到哪 / 可随时关),确认后才置 true。
3. **投影**:`lib/telemetry/projection.ts`,从现有 observability export 数据按 §2 白名单投影出 envelope;`errorMessage` 过 `redact()`+截断。
4. **上报器**:`lib/telemetry/reporter.ts`,启动触发,读开关→节流→POST→失败静默;出网动作落 `audit_logs`(红线 8)。
5. **透明**:**设置页**(非观测页,后者将删)显示"已上报至 {endpoint},最近一次 {time},本批 N 条"。

### 发送端自测(不需要真服务器)

- **防回归单测(最重要)**:对投影后的 envelope,断言**不存在** §2.2 黑名单字段(深度遍历对象,任何 key ∈ 黑名单即 fail)。以后谁加字段都会被这条测试拦住。
- 投影正确性:给定一组 mock traces/spans,投影出的字段值与白名单逐一对齐。
- `errorMessage` 含身份证/卡号样例 → 断言被 redact。
- 开关默认关:未配置时 reporter 不发请求(mock fetch 断言 0 调用)。
- mock e2e(按项目 e2e 约定,新 journey 配一条):开关默认关 + 开启后 payload 不含敏感字段;**不打真网络**。

---

## 5. 接收端实现要点(独立仓库)

栈:Node + TypeScript + SQLite(待定,见下)。Docker 部署。

1. `POST /ingest`:鉴权 → 校验 schemaVersion → 按 `(installId,traceId)` 幂等 upsert → 返回 `{accepted,deduped}`。
2. 存储:traces / spans 两张表(或一张 + JSON)。
3. `GET /dashboard`:§3.3 聚合视图。
4. AI 优化报告(后续):定时把 top 异常 / 慢路径导成结构化 Markdown 喂 LLM 出改进建议。
5. Dockerfile + README(部署 + token 配置说明)。

### 接收端自测(不需要真 app)

- 用 §6 golden fixture 打 `/ingest`:断言 `accepted` 正确入库。
- 重复打同一 fixture:断言第二次全部 `deduped`、库内不重复。
- 错 token → 401;错/缺 schemaVersion → 400。
- 仪表盘聚合数值对 golden fixture 的预期值。

---

## 6. Golden Fixture(两边自测的共同基准)

**规范文件**:`docs/spec/fixtures/telemetry-sample.v1.json`(本仓库内,见下方内容)。接收端仓库**复制一份字节相同的副本**到自己的 `fixtures/`。fixture 变更 = 契约变更 → 同步 `schemaVersion` 并通知两边。

含 3 条 trace(2 客户端 installId、含 1 条 error 状态、若干 span),用途:
- 发送端:投影器对 mock 数据的产出应"结构等价"于这份 fixture(字段集一致、无黑名单字段)。
- 接收端:驱动 ingest / dedup / dashboard / 多客户端切片 / issue 生成 测试。

```jsonc
{
  "schemaVersion": 1,
  "installId": "11111111-1111-4111-8111-111111111111",
  "appVersion": "0.1.1",
  "platform": { "os": "darwin", "arch": "arm64" },
  "reportedAt": 1718841600000,
  "window": { "from": 1718236800000, "to": 1718841600000 },
  "traces": [
    {
      "traceId": "aaaa1111-1111-4111-8111-111111111111",
      "conversationId": "cccc1111-1111-4111-8111-111111111111",
      "startedAt": 1718800000000, "totalMs": 4231, "status": "ok",
      "roleMode": "analyst", "modelUsed": "claude-sonnet-4-6", "routerPath": "fast",
      "numTurns": 3, "llmCallCount": 2, "toolCallCount": 5,
      "inputTokens": 1200, "outputTokens": 800, "cacheReadTokens": 0,
      "cacheCreationTokens": 256, "totalCostUsd": 0.0123,
      "errorMessage": null, "modelUsageJson": "{\"claude-sonnet-4-6\":{\"in\":1200,\"out\":800}}",
      "spans": [
        { "spanType": "router", "name": "route", "startedAt": 1718800000000, "durationMs": 12, "tokens": null, "error": null },
        { "spanType": "tool_call", "name": "reimbursement_check", "startedAt": 1718800001000, "durationMs": 320, "tokens": 150, "error": null }
      ]
    },
    {
      "traceId": "aaaa2222-2222-4222-8222-222222222222",
      "conversationId": "cccc2222-2222-4222-8222-222222222222",
      "startedAt": 1718805000000, "totalMs": 9120, "status": "error",
      "roleMode": "analyst", "modelUsed": "claude-opus-4-8", "routerPath": "deep",
      "numTurns": 2, "llmCallCount": 1, "toolCallCount": 2,
      "inputTokens": 3000, "outputTokens": 200, "cacheReadTokens": 512,
      "cacheCreationTokens": 0, "totalCostUsd": 0.087,
      "errorMessage": "payroll tool failed: column not found", "modelUsageJson": "{\"claude-opus-4-8\":{\"in\":3000,\"out\":200}}",
      "spans": [
        { "spanType": "tool_call", "name": "payroll_calc", "startedAt": 1718805001000, "durationMs": 5000, "tokens": null, "error": "column not found" }
      ]
    }
  ]
}
```

> 第二个 installId(代表另一客户端)用同结构、`installId` 为 `22222222-2222-4222-8222-222222222222` 的另一份 envelope,接收端测试里构造,验证多客户端切片。

---

## 7. 接收端架构(独立仓库 `../finance-agent-telemetry`)

栈:**Node + TypeScript + SQLite(better-sqlite3)+ Next.js(App Router,前端+API 同栈)**。Docker 单容器部署,无登录。

```
finance-agent-telemetry/
  app/                    # Next.js:dashboard + workflow 看板 + API routes
    api/ingest/route.ts   # POST /ingest(契约 §3)
    page.tsx              # 概览(多客户端切片)
    clients/[installId]/  # 单客户端 trace + span 详情
    issues/               # 错误工作流看板/列表 + 详情(节点流转)
  lib/
    db.ts                 # better-sqlite3 连接 + 迁移
    ingest.ts             # 幂等 upsert
    issues.ts             # 错误聚合成 issue + 状态机
    report.ts             # AI 优化报告(MD)+ Claude Code 提示词生成
  fixtures/telemetry-sample.v1.json   # 复制自本 spec §6
  tests/                  # ingest/dedup/issue/report 自测
  Dockerfile
  README.md
```

**存储表(建议)**:`traces`、`spans`、`issues`、`issue_events`(节点流转审计)。多客户端靠 `traces.install_id` 切片。

---

## 8. 多客户端分析(红线"谁"维度)

- 概览页:按 `installId` 列出各客户端(可起别名 `client_aliases` 表),每客户端给错误率 / 成本 / 调用量 / 活跃度。
- 客户端详情页:该 installId 的 trace 列表 + span 瀑布 + 错误聚合。
- 所有聚合查询都带 `installId` 维度,不混算不同客户端(类比红线 3 口径对齐)。

---

## 9. 错误 → issue 工作流(接收端自有 DB,状态流转看板)

**聚合规则**:把 `status="error"` 的 trace 或带 `error` 的 span,按"指纹"(`errorMessage` 归一化后 hash + 工具名 + routerPath)聚合成一个 `issue`,记 `count` / `firstSeen` / `lastSeen` / 受影响 `installId` 集合。同指纹复现只增计数,不新建。

**状态机(节点)**:`new → triaged → report_ready → optimizing → in_review → released → closed`(可 `wontfix`)。每次流转写 `issue_events`(谁/何时/从哪到哪/备注),即节点审计。

**UI**:看板(列=状态)或列表+状态标签;点进 issue 看:聚合详情、关联 trace、§11 生成的报告 MD、优化 diff 链接、review 结论。**不做可视化节点图**。

---

## 10. AI 优化报告 + 半自动闭环

接收端对一个 issue 一键"生成优化包",产出:

1. **根因报告(MD)**:该 issue 的指纹、复现频次、受影响客户端、关联 trace 指标(时延/成本/token)、错误模式、可能的代码位置线索。
2. **Claude Code 提示词**:一段可直接粘贴的提示,形如"分析最新 finance-agent 代码中 `<工具/模块>` 的 `<错误模式>`,给根因→优化方案→改动→review",并附报告 MD 作为上下文。

**人执行**:你在本地对**最新 finance-agent 代码**跑 Claude Code(代码不含财务数据,安全),走 分析→方案→优化→review。完成后回接收端把 issue 推进到 `in_review`/`released`。

**红线关卡(写进 report.ts)**:报告 MD 出网/落盘前再过一遍脱敏(`errorMessage` 等),**绝不把任一客户端的原始会话/财务数据写进报告**(本来也没上传)。报告只含聚合指标 + 已脱敏错误模式 + 代码位置线索。

---

## 12. 删除本仓库观测页(上报功能完成后)

- **删**:`app/observability/*`(page/trace-table/metric-cards/trace-detail/types/model-usage-card)、`app/api/observability/*`、`app/api/metrics/*`、导航入口(`app/shared/app-nav.tsx` / `app-shell.tsx` 里的观测项)。
- **保留**:`lib/observability/{spans,metrics,trace-write}.ts` 与 `agent_traces`/`agent_spans` 表 —— 它们是上报的数据源,**只是不再有本地 UI**。
- 删页面后清理对应测试(`tests/observability.test.ts` 等)中只测 UI 的部分,保留测数据层的部分。
- **次序**:先做完上报(§4)并确认上报器从数据层取数 OK,**再删 UI**,避免删早了断了数据源验证。

---

## 13. Tauri 自动更新(本轮完整打通 + 人工审核)

- **集成**:`@tauri-apps/plugin-updater` + `tauri.conf.json` 配 `updater`(endpoint 指向 GitHub Release 的 `latest.json` 或你的静态托管),前端加"检查更新/有新版本"UI + 人工确认后才下载安装(**人工审核门**)。
- **release workflow**:`.github/workflows/release.yml` 增产出 `latest.json`(含版本、各平台包 URL、签名)。
- **签名密钥(留给用户)**:`npm run tauri signer generate` 交互生成密钥对 → **公钥**填 `tauri.conf.json`,**私钥 + 密码**进 GitHub Actions secret(`TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD`)。**我不生成、不持有私钥**;代码与 workflow 全就位,留这一条命令 + 两个 secret 给你。
- README/spec 写清这条手动步骤与人工审核流程。

---

## 14. 接收端前端设计

- 基调按 **https://vercel.com/design.md**(Geist 风:克制、黑白灰 + 强对比、清晰层级、数据密度高的表格/卡片)。
- 缺组件**引 shadcn skill** 安装(table / card / badge / tabs / dialog / dropdown 等)。
- 关键视图:概览(多客户端卡片 + 趋势)、客户端详情(trace 列表 + span 瀑布)、issue 看板(状态列)、issue 详情(报告 MD 渲染 + 提示词复制按钮)。

---

## 15. 执行编排(workstreams)

并行两条线,契约(§2/§3)+ fixture(§6)为锚:

- **WS-A finance-agent 发送端**(本仓库,worktree 隔离):§4 设置/首开/投影/上报器/审计 + 防回归单测 + mock e2e;§13 updater;§12 删观测页(放在上报验证通过之后)。验证:`npm test` / `typecheck` / `lint` / `test:e2e` 绿。
- **WS-B 接收端**(`../finance-agent-telemetry`,新仓库):§7-§10、§14 全栈 + Dockerfile;自测:ingest/dedup/401/400/多客户端切片/issue 聚合/报告生成。

**对接(WS-C,orchestrator 收口)**:
1. 本地起接收端(`docker` 或 `npm run dev`),拿 endpoint + token。
2. 发送端设置填 endpoint + token,开开关。
3. 触发上报 → 接收端 `accepted > 0`;重触发 → `deduped`。
4. 仪表盘出现数据、多客户端可切片、error trace 聚合成 issue。
5. 验证 `audit_logs` 记了出网事件。
6. updater:本地构造一次"有新版本"走通人工审核 UI(签名密钥由用户就位后真打)。

---

## 16. App 级错误捕获 + 友好提示 + 上报(schemaVersion 2)

目标:把可观测从「只对话」扩到「整个 App」,主动发现并(经 issue→AI 报告闭环)解决用户遇到的问题。决策已定:**分级提示** + **随每日批次上报**。

### 16.1 捕获层(发送端,catch everything)
- `app/global-error.tsx`:根布局崩溃兜底页(友好、可重试)。
- `app/error.tsx`:段级崩溃兜底(友好、可重试,不露堆栈)。
- 客户端全局监听(挂在 `app/shared/app-shell.tsx`,已 "use client"):`window.addEventListener("error")` + `"unhandledrejection"` → `POST /api/errors`(fire-and-forget,失败静默)。
- API 路由统一 `withApiError` 包装:catch → 记录 → 结构化 500 `{ ok:false, error }`。
- 服务端:复用已有 `instrumentation.ts` 的 `onRequestError` → 记录(现仅落磁盘,需补一份进 DB 走脱敏)。

### 16.2 友好 UI(分级)
- **致命渲染崩溃** → 整页友好兜底页(中文、可重试、带短错误码,**不露堆栈**)。
- **用户操作失败**(API 报错) → 复用已挂的 Sonner toast 友好提示。
- **后台/非阻塞错误** → 静默,只记录 + 上报,不打扰用户。

### 16.3 本地记录(红线 7/8)
新表 `app_errors`:
```
id, ts(epoch ms), kind, source, message, stack, app_version, fingerprint, reported(0/1)
```
- **写入前 redact + 截断**(message≤300、stack≤1000;堆栈常含路径/值,红线 7)。
- 客户端错误经新 `POST /api/errors`(发送端内部接口,非上报契约)落库。
- `fingerprint = hash(kind + 归一化 message + source)`,供接收端聚合。
- `reported` 标志:随批次上报后置 1(增量上报,别重发)。

### 16.4 上报契约扩展(schemaVersion 2,加法兼容)
envelope **可选**新增 `appErrors[]`;含该字段时 `schemaVersion: 2`,否则仍可发 `1`。

`AppErrorMetric`(白名单,**永不含原始会话/财务数据**):
```jsonc
{
  "ts": 1718805000000,
  "kind": "render",          // render | rejection | unhandled | api | server(枚举)
  "source": "/chat",         // 路由/组件名,截断 200
  "message": "Cannot read x",// redact + 截断 300
  "stack": "at ...",         // redact + 截断 1000(可只留前若干帧)
  "appVersion": "0.1.1",
  "fingerprint": "ab12cd34",
  "count": 1                 // 本地预聚合次数;无则 1
}
```
- 同 trace 一样**随每日 opt-in 批次**上传(reporter 一并取未 reported 的 app_errors)。
- 黑名单约束沿用 §2.2(深度遍历断言无 user_message/final_answer/summary)。

### 16.5 接收端处理(支持 [1,2])
- `X-Schema-Version`/envelope.schemaVersion ∈ {1,2};2 时解析 `appErrors[]`,1 时无此字段。
- 新表 `app_errors`(带 `install_id`),按 `(installId, ts, fingerprint)` 幂等。
- **汇进已有 issue 状态机**:App 错误按 fingerprint 聚合成 issue(issue 增 `kind: agent|app` 区分),与 agent 错误同一套 new→…→released 流转 + AI 优化报告。
- dashboard:每客户端增「App 错误数/错误率」;issue 列表可按 kind 过滤。

### 16.6 自测
- 发送端:`withApiError` 包住 throw 返回 500 且落 app_errors;客户端 error/rejection → /api/errors 落库;**防回归**:app_errors 上报投影深度遍历无黑名单字段;stack 含身份证/卡号样例被 redact;mock e2e 触发一次客户端错误→toast 出现 + 不打真网络。
- 接收端:v2 envelope(含 appErrors)ingest → app_errors 入库 + 聚合成 issue;v1 envelope 仍正常;app_errors 幂等去重;dashboard 出 App 错误数。
- golden fixture 增一份 v2 样例(含 2 条 appErrors,1 render 1 api)。

---

## 17. 编译期内置配置 + 默认开(免用户填写)

决策:**endpoint+token 烧进二进制(不进客户端 JS)** + **默认开 + 首启告知(可关)**。前提:解包/逆向无法绝对防(原生二进制 strings 可抓),所以**安全靠服务端让泄露变廉价**,客户端只负责"不进 JS、抬高门槛"。

### 17.1 注入链路(发送端)
- **编译期**:Rust 用 `option_env!("TELEMETRY_ENDPOINT")` / `option_env!("TELEMETRY_TOKEN")` 读 build 时环境(CI secret),烧进原生二进制。
- **运行期**:`src-tauri/src/lib.rs` 拉 next-server 子进程时,顺现有 `.env(...)` 段注入 `TELEMETRY_ENDPOINT`/`TELEMETRY_TOKEN`(空则不注入)。
- **服务端读取**:`reporter.ts` 解析顺序 `process.env.TELEMETRY_ENDPOINT` → 退回 `settings.telemetryEndpoint`(dev 覆盖);token 同理。**绝不经 `NEXT_PUBLIC_`、绝不进客户端 JS**(reporter 本就纯服务端)。
- **设置 UI**:隐藏/降级 endpoint+token 输入(改为只读"上报目标已内置"状态);保留开关 + "已上报"状态。

### 17.2 默认开 + 首启告知
- `telemetryEnabled` 默认 **true**;但**仅当解析到 endpoint+token 才真正上报**(无内置配置的 dev 构建 = 自动 no-op,安全)。
- 移除原"关→开"阻塞式确认弹框;改为**首启一次性非阻塞告知**(banner/toast):「本应用上传匿名运行指标与错误日志以改进产品,**不含财务数据**,可在设置随时关闭」+ 去设置链接;记 `telemetry:disclosureShown` 防重复。
- 红线 7 仍在:上传内容不变(纯指标 + 已脱敏 App 错误),开关可随时关。

### 17.3 CI 发版
- `.github/workflows/release.yml`:把 `TELEMETRY_ENDPOINT`/`TELEMETRY_TOKEN`(GitHub secret)注入 Tauri build 环境,供 `option_env!` 烧入。文档写清。
- **轮换**:换 secret + 发新版本即换 token(对应接收端"泄露即可轮换")。

### 17.4 接收端:让泄露变廉价(安全的真正落点)
- `POST /api/ingest` 加**限流**(按 IP + installId 滑动窗/令牌桶,超限 429);**请求体大小上限**;非法 schema 直接丢弃(已具备)。
- token 仅"只写 ingest 凭证",单向、不回吐数据;配合轮换即可。
- (可选)文档建议反代/WAF、非默认路径。

### 17.5 验证
- 发送端:reporter 在有 env 时用 env 值、无 env 时退设置(单测);默认开但无 endpoint 时 no-op(单测);首启告知出现一次(e2e);设置不再暴露 token 输入。
- 接收端:超频请求得 429、超大 body 拒绝、正常请求不受影响(测试)。
- Rust 注入因需打包桌面端,本轮**代码就位 + cargo 可编译**即可,真打包烧值随发版验证(同签名密钥)。

---

## 18. 质量反馈信号(schemaVersion 3)

目标:把可观测从「错误」扩到「质量」——用户对回答的 👍/👎 上报为**匿名结构化信号**,接收端聚合满意率 / 质量回归。决策:**加法兼容**,只传结构化分数 + 枚举标签,**绝不传自由文本反馈**(红线 7)。

### 18.1 现状(发送端已具备,不新增采集 UI)
- 👍/👎 采集**已存在**:`app/api/chat/feedback/route.ts` → `upsertChatFeedback`(`lib/db/sqlite.ts`)→ `chat_feedback` 表:
  `id / message_id(唯一)/ conversation_id / trace_id / rating('up'|'down') / reason(自由文本)/ created_at / updated_at`,带 `idx_chat_feedback_updated(updated_at DESC)`。
- 本能力**不加采集 UI / 不加本地表**,只把已有 `chat_feedback` 投影上报。

### 18.2 上报契约扩展(schemaVersion 3,加法兼容)
envelope **可选**新增 `feedback[]`;含该字段时 `schemaVersion: 3`,否则仍发 1/2。

`FeedbackMetric`(白名单,**永不含自由文本**):
```jsonc
{
  "feedbackId": "fb-<message_id>", // 稳定幂等键(按 message 派生),无语义
  "ts": 1718805000000,             // chat_feedback.updated_at → epoch ms
  "signal": "user_rating",         // 信号族:user_rating | task_outcome | self_eval | retry | regenerate(本版本仅 user_rating)
  "traceId": "uuid|null",          // chat_feedback.trace_id(真实遥测 trace_id)
  "conversationId": null,          // 本版本不带(本地数字会话 id ≠ 遥测 UUID)
  "value": -1,                     // user_rating:+1(up)/ -1(down)
  "label": "thumbs_down",          // thumbs_up | thumbs_down
  "roleMode": null, "routerPath": null, "modelUsed": null, // 切片维度,可选(v1 留空)
  "appVersion": "0.1.2"
}
```

### 18.3 红线 7:禁止外发字段
`chat_feedback.reason` 是用户**自由文本**(可能含 PII / 财务),**绝不投影、绝不外发**。
§2.2 黑名单**新增**深度遍历拦截键:`reason / comment / feedbackText / feedback_text / note / correction`。投影只取结构化字段,`reason` 永不读出;防回归测试断言 envelope 不含这些键及任何自由文本。

### 18.4 发送端实现(`finance-agent`)
- `lib/telemetry/projection.ts`:加 `FeedbackMetric` 类型 + `schemaVersion: 3` envelope 变体 + `projectFeedback(row)`(只取结构化值、**丢 `reason`**)+ `buildEnvelope` 在有 feedback 时出 v3(可同载 appErrors);`BLACKLIST_KEYS` 加 §18.3 键。
- `lib/telemetry/reporter.ts`:增量取 `chat_feedback WHERE updated_at > lastReportedAt`(走 `idx_chat_feedback_updated`),纳入 `buildEnvelope`;随 `lastReportedAt` 水位线推进(无需额外 `reported` 标志);`runTelemetryTestReport` 同样取近 7 天 feedback。
- **防回归单测(最重要)**:投影后 envelope 深度遍历**无黑名单键、无 `reason`、无任何自由文本**;`reason` 含身份证/卡号样例时投影结果不含之;`value ∈ {-1,+1}`、`label ∈ {thumbs_up,thumbs_down}`。

### 18.5 接收端处理(支持 [1,2,3])
- `SUPPORTED_SCHEMA_VERSIONS=[1,2,3]`;解析 `feedback[]`;新表 `feedback`(带 `install_id`),幂等 `(install_id, feedbackId)`;`sanitizeFeedback` 深度剔黑名单(纵深防御)。
- 聚合:满意率 = Σ(+1)/Σ|rating|,按 install / 版本 / role / router 切片;(可选)质量回归 → issue(`kind: quality`)。
- 出口(若进告警/报告)照旧过 `redact()` + 黑名单断言。

### 18.6 Golden fixture
新增 `docs/spec/fixtures/telemetry-sample.v3.json`(v2 基础上加 `feedback[]`,含 1 `up`、1 `down`,各带 `feedbackId`);两仓逐字节同步(发送端 `docs/spec/fixtures/` + 接收端 `fixtures/`)。

### 18.7 边界 / 不做
- 本版本仅 `user_rating`(👍/👎);`task_outcome` / `self_eval` / `retry` 等信号族**留口**,后续按需加(加法,不再升大版本)。
- `rating` 变更:`feedbackId` 稳定 → 接收端 `(install_id,feedbackId)` 去重,**v1 以首次为准**(变更不重传聚合);需要时接收端改 upsert。
- `conversationId` v1 不带(本地数字 id);需要时由 `trace_id` 反查 `agent_traces.conversation_id`(UUID)富集。
