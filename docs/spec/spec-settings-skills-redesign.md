# 设置页技能目录与导航收敛 Spec

> 版本 v1.0 / 2026-07-03
> 状态：已批准
> 依赖：F1 技能 frontmatter `title/summary`、F2 内置技能恒启用（均已进入 main）
> 架构事实：技能元数据由 `lib/agent/skills-store.ts` 解析并通过 `/api/skills` 提供；聊天已有 `referencedSkills → skillNames → /api/agent/query → injectSkillHint` 链路。

## 0. 目标与非目标

**目标**：分两个堆叠 PR 完成设置页第二批重构。PR-1 将技能设置改为财务能力目录，并把卡片入口接到既有聊天技能引用链；PR-2 将设置标签从 8 个收敛为 5 个。

**非目标（本期不做，已知并接受)**：

- 不在技能卡片增加表单、向导或参数配置，卡片终点始终是对话。
- 不改 `SkillsManager`，不改变 `/skills` 的新建和文件管理能力。
- 不做频次统计、推荐或“本月该干什么”。
- 不新建技能发送机制或遥测环境配置项。

## 1. 成功标准

- [ ] 技能 tab 展示 8 张财务能力卡，按算薪窗口、报税期、结账出数、随时可用排序；文件处理技能折叠为一行说明。
- [ ] 12 个内置技能具备 `requires`，能力技能可选 `starter`；目录通过现有技能 API 读取元数据。
- [ ] “开始”进入新聊天，技能已引用、输入框聚焦，可选开场白已预填；发送后请求携带技能并注入 skill hint。
- [ ] 技能 tab 仅保留底部“高级：技能文件管理 ↗”，画像页删除税务/研发咒语文案。
- [ ] 设置标签为常规、模型连接、技能、小财的了解、关于；旧 key 显式重定向到对应新 key。
- [ ] 常规合并主题和“展示工作过程”；模型页删除连接路径图，三个模型 ID 收进高级折叠。
- [ ] 小财的了解同页展示画像和记忆；关于合并用量；遥测调试区仅开发环境渲染。
- [ ] 侧栏搜索框删除，相关 e2e 深链更新。
- [ ] 指定单元测试、类型检查、构建和相关 e2e 在 mock 环境通过。

## 2. Files touched

### PR-1（F3 + F4）

| 文件 | 动作 | 改什么 |
|---|---|---|
| `agent-skills/skills/*/SKILL.md`（12 个） | 修改 | 增加 `requires`，能力技能按需增加 `starter` |
| `lib/agent/skills-store.ts` | 修改 | 解析并暴露新展示字段 |
| `app/config/skill-catalog.tsx` | 新增 | 财务能力目录 |
| `app/config/skill-center.tsx` | 修改 | 用目录替换内嵌管理器 |
| `app/config/profile/profile-settings.tsx` | 修改 | 删除咒语文案 |
| `app/chat/new/page.tsx` | 修改 | 读取技能 URL 参数并传给聊天页 |
| `app/chat/chat-page.tsx` | 修改 | 初始化既有技能引用状态并聚焦 |
| `tests/skills-store.test.ts` | 修改 | 覆盖新 frontmatter 字段 |
| `tests/settings-skills-redesign.test.ts` | 新增 | 覆盖目录、URL 到发送链和 hint 注入契约 |
| `tests/all.test.ts` | 修改 | 接入新增测试 |
| `e2e/mock/chat.spec.ts` | 修改 | 覆盖技能预钉和发送 |
| `docs/spec/audit-settings-skills-redesign-pr1.md` | 新增 | PR-1 实施审计 |

### PR-2（F7）

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/config/tabs.ts` | 修改 | 5 tab 单一源与旧 key 映射 |
| `app/config/page.tsx` | 修改 | 旧 key 显式 URL 重定向 |
| `app/config/skill-center.tsx` | 修改 | 删除搜索并组合新页面 |
| `app/config/general/general-settings.tsx` | 修改 | 合并主题和工作过程开关 |
| `app/config/model/model-settings.tsx` | 修改 | 删除装饰图、模型 ID 进高级折叠 |
| `app/config/understanding/understanding-settings.tsx` | 新增 | 同页组合画像与记忆 |
| `app/config/about/about-settings.tsx` | 修改 | 合并用量与隐私内容 |
| `app/config/environment/telemetry-settings.tsx` | 修改 | 调试区仅 dev 渲染 |
| `e2e/mock/profile-onboarding.spec.ts` | 修改 | 更新画像深链 |
| `e2e/mock/pages.spec.ts` | 修改 | 更新记忆深链并覆盖旧 key 重定向 |
| `e2e/mock/telemetry.spec.ts` | 修改 | 覆盖非 dev 隐藏调试区 |
| `tests/settings-skills-redesign.test.ts` | 修改 | 覆盖 5 tab 与映射契约 |
| `tests/nav-v3.test.ts` | 修改 | 更新技能高级入口的既有导航契约 |
| `docs/spec/audit-settings-skills-redesign-pr2.md` | 新增 | PR-2 实施审计 |

## 3. 实施步骤

1. PR-1 扩展 `skills-store` 的现有逐行 frontmatter 解析器与 `SkillSummary`，不引入 YAML 依赖。
2. 新目录从 `/api/skills` 读取内置技能，按显式财务节奏配置分组；开始按钮跳 `/chat/new?skill=<name>`。
3. 新聊天服务端页校验技能 slug 后把初始技能和 starter 传给 `ChatPage`；客户端复用 `referencedSkills`、正文 `/skill` token 与现有发送函数。
4. PR-1 验证通过后提交、推送并开 PR。
5. PR-2 以 `tabs.ts` 同时导出新标签与旧 key 映射；服务端对旧 key redirect，未知 key 保持显式回到常规。
6. 复用现有设置组件做组合，主题与 roleMode props 上移到常规；模型高级区用原生 `details`。
7. 关于页直接组合 `UsageSettings`；遥测用现有 `process.env.NODE_ENV` 判断开发环境。
8. 更新 e2e 深链与契约测试，完成验证后提交、推送并以 PR-1 分支为 base 开堆叠 PR。

## 4. 测试与验证方式

```bash
source .venv/bin/activate
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run build
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm run test:e2e -- e2e/mock/chat.spec.ts e2e/mock/pages.spec.ts e2e/mock/profile-onboarding.spec.ts e2e/mock/telemetry.spec.ts
```

- 新增测试：卡片开始到聊天技能引用并随请求注入；旧 tab 深链重定向；生产环境不渲染遥测调试区。
- e2e 遵循仓库现有 mock fixture / mock agent，不连接真实 LLM。

## 5. 风险与开放问题

- 两个 PR 都修改 `skill-center.tsx`，因此 PR-2 采用堆叠 PR；PR-1 合并后需把 PR-2 base 改回 main 或 rebase。
- starter 与技能 token 共存时必须保留 token，否则现有 draft 同步 effect 会移除技能引用。
- 未知 tab key 与旧 tab key 不同：旧 key 必须显式 redirect；未知值可回到常规。
