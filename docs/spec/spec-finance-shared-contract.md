# Spec: 财务三功能 · 共享契约(P1/P2/P3 并行地基)

> 状态：待审阅
> 日期：2026-06-21
> 范围：P1 合同归纳 / P2 经营分析 / P3 税务筹划 三份 spec **并行实现**时共享的契约。三家照此各自追加，集成时只需机械合并。

---

## 0. 背景

三份功能 spec 由 3 个 subagent 并行实现。本文锁定三家**共享的卡点文件如何各自追加**、共用的**公司画像存储**、统一的**工具注册套路**、**红线护栏清单**与**验证口径**。读本文前先读对应的 P 级 spec。

## 1. 共享卡点文件（全部"追加"，勿改他人行）

5 个文件三家都会碰，但都是**往数组/文件末尾追加自己的条目**，互不占同一行。集成合并时**保留三方追加**即可。

| 文件 | 各家怎么追加 |
|---|---|
| `lib/agent/tools/registry.ts` | 往 `TOOL_REGISTRY` 数组末尾追加 `{ name: "mcp__finance_worker__<x>", category: "finance", riskLevel }` |
| `lib/agent/mcp-tools/index.ts` | `import { create<X>Tool }` + 在 `createFinanceMcpServer` 的 tools 数组追加 `create<X>Tool(sdk)` |
| `lib/agent/tools/renderers.ts` | 往 renderer map 追加 `<tool_short_name>: (i) => "…"` |
| `lib/agent/system-prompt.ts` | 往 B 段 guidance 数组追加一条（≤1 行，说清何时调该工具/skill） |
| `lib/db/schema.ts` | 追加 `CREATE TABLE IF NOT EXISTS …`（幂等，迁移安全）；列扩展用单独 ALTER 守卫 |

## 2. 公司画像存储（P2 / P3 共用契约）

不定制化的载体。**P3 负责实现，P2 只读（容空）。**

- 新建 `lib/profile/file-store.ts`，仿 `lib/memory/file-store.ts`：`profile.json` 存 app 数据目录。
- `getProfilePath()` 加进 `lib/runtime/paths.ts`（env override `FINANCE_AGENT_PROFILE_PATH`）。
- 读接口（P2 调）：`export async function readCompanyProfile(): Promise<CompanyProfile>`，**文件不存在返回 `{}`**。
- 形状（全字段可空、灵活）：
  ```ts
  type CompanyProfile = {
    region?: string;            // 上海市松江区
    zones?: string[];           // ["临港新片区"]
    taxpayerType?: "小规模" | "一般纳税人";
    isHighTech?: boolean;
    industry?: string;
    scaleRevenueWan?: number;   // 年营收(万)
    revenueDimensions?: string[]; // 收入拆分维度名，如 ["事业部"]——P2 下钻用
    extra?: Record<string, unknown>;
  };
  ```
- 注入：`claude-adapter.ts` 像读 memory 一样读 profile，拼进系统提示 C 段。
- 写：`/api/profile` PUT + `update_company_profile` 工具（medium，过确认门）。
- **P2 依赖说明**：P2 调 `readCompanyProfile()` 拿 `revenueDimensions`；P3 未合并时返回 `{}` → P2 回落"问用户"，**不硬依赖**。两边都按本节签名，集成不冲突。

## 3. 工具注册套路（统一，防止三家发明不同做法）

- 定义在 `lib/agent/mcp-tools/<x>.ts`：`sdk.tool(name, descLines.join("\n"), zodShape, handler)`。
- **写库工具**：`withIdempotency("<name>", handler, { riskLevel: "medium" | "high" })`（`lib/agent/tools/idempotency.ts`，自动落 `audit_logs` + 幂等）。
- **高风险写**（改账/批量/导出）：`riskLevel: "high"` → 自动过 `risk-confirm` 门；需"无条件确认"的（如写入用户数据）加进 `built-in.ts` 的 `ALWAYS_CONFIRM_TOOLS`。
- **纯读工具**：不挂确认。
- 工具返回 `{ content:[{type:"text",text}], structuredContent? , isError? }`；查不到数据返回明确空信号（`{ found:false }` / 空集 + 原因），**不编**（红线 4）。

## 4. 红线护栏自检清单（每个工具/skill 落地前过一遍）

1. **权限内嵌**：多用户后过滤落工具层（当前单用户暂缓）。
2. **数值正确性**：金额/比率/税走确定性函数，**禁止模型心算**；入参声明单位/精度。
3. **数据信任链**：对外数值带 `asOf` + 结算状态（草稿/已确认/已锁定），跨期跨状态先对齐口径再聚合。
4. **"我不知道"**：查不到返回明确空信号 + 原因，不用近似数填空。
5. **写操作审批**：高风险写过确认门，无交互通道 fail-closed。
6. **决策边界**：只给分析/依据/可选项，不替用户拍经营/税务决策；要拍板用 `AskUserQuestion`。
7. **合规驻留**：敏感数据（客户实名/身份证/银行卡/涉密立项报告等）不原样进模型上下文；确需入参先脱敏。
8. **审计落点**：数据访问/工具调用落 `audit_logs`（`insertAuditLog`，`lib/db/sqlite.ts`）。

## 5. 验证口径（每个 worktree 收尾必跑全绿）

```bash
# keyless：隔离数据目录 + mock agent（避开钥匙串真 key 让 smoke 走 live 报错）
export FINANCE_AGENT_APP_DATA_DIR=/tmp/fa-<slice> FINANCE_AGENT_MOCK_AGENT=1
npm run typecheck && npm test && npm run lint
```

## 6. 子 agent worktree 注意（写进每个 agent 指令）

- worktree 从 `origin/main` 起，**本地 main 领先 origin 55+ 提交** → 进去先 `git reset --hard main` 对齐。
- symlink `node_modules` + `workers/.venv`（指向主检出，同机同架构）：`ln -sfn <main>/node_modules node_modules; ln -sfn <main>/workers/.venv workers/.venv`。
- **别提交 `package-lock.json`**；并发安装 ≤4。
- 只动本 slice 相关行 + 第 1 节那 5 个卡点文件的"追加"；改完 typecheck/test/lint 全绿再交回。
