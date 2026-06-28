# Spec — UX 批次(4 项)

面向单机财务工作台的一批对话/可发现性体验修复。四项相互独立(文件集基本不相交),可分派并行。

代码基线:本地 main HEAD(含 thinking 全链路下线)。所有改动**遵守 CLAUDE.md 八条红线**;改完跑 `npm run typecheck` + 相关单测 + `npm run lint`(0 error)。

---

## 第 1 项 — WebSearch 引用网址变可点击绿色链接(我自己做,chat-page UI)

**现状**:`app/chat/chat-page.tsx` 的 `MarkdownMessage` 里 `a:` 渲染器(~1235–1261):非 finance-file 链接一律 `return <span>{children}</span>`(注释「avoid dead external links in a desktop app」),导致 WebSearch 的 `Sources:` 网址不可点。

**改**:`a:` 渲染器对 `http(s)` 外链渲染真实可点 `<a>`:
- `href` 以 `http://`/`https://` 开头 → 渲染 `<a href target="_blank" rel="noopener noreferrer">`,点击在系统浏览器打开(Tauri 桌面壳:走默认外链/opener,确保不在 webview 内导航)。
- 颜色用**系统语义绿**(项目里的绿色 token / `text-emerald-600` 类语义色,与 file-link 的 `text-primary` 区分),hover 反馈。
- finance-file 链接保持现有预览按钮逻辑不变;非 http 非 file 的仍回退 `<span>`。

**验收**:WebSearch 答案里的 `Sources` 条目可点、绿色、点击跳原址;file 链接预览不回归;`chat-features.test.ts` 关于「不可预览链接不渲染成 anchor」的断言需同步更新为「外部 http 链接可点、内部非预览链接仍 span」。

---

## 第 4 项 — ask_user 问答改为吸附输入框上方的浮层(我自己做,chat-page UI)

**现状**:`app/components/ask-user-card.tsx` 内联渲染在时间线(chat-page ~1063)。丑、打断阅读。

**改**(用户已选「吸附输入框上方的浮层」):
- **待答(active 且未答)的 ask_user** → 渲染成一个**浮层面板,吸附在输入框正上方**(输入区容器内、composer 之上),复用 shadcn `Card`/`Button` 风格 + motion 动效;多个待答则展示最新一个(其余排队)。
- **已答 / 已超时** → 不再用大卡片,改在时间线留一行紧凑摘要:`✓ {header} · 已选:{answer}`(或「未确认(已超时)」)。
- 应答仍走 `POST /api/agent/answer`(机制信号,不变)。
- ask-user-card.tsx 重构为浮层内容组件(或新增 `ask-user-bar.tsx`);时间线侧新增紧凑「已答摘要」渲染。

**验收**:agent 提问时问题浮现在输入框正上方;点选项即提交并收起;时间线显示紧凑已答摘要;历史会话只读展示;无待答时输入框位置不被占。

---

## 第 2 项 — 快捷操作调整 + 新建 business-analysis 技能(分派 Sonnet 子 Agent)

**现状**:`app/cockpit/quick-actions-card.tsx` 的 `quickActions` 数组 5 条:报销校验 / 薪税计算 / **导出金蝶草稿** / 财务分析 / **生成老板月报**。技能从 `agent-skills/skills/` 自动加载(`skill-plugin.ts` skills:"all",**无需注册表**,加一个目录即生效)。

**改**:
1. quick-actions-card.tsx:**删除**「导出金蝶草稿」「生成老板月报」两条;**新增**「经营分析」一条:
   `{ icon: ChartIncreaseIcon 或合适图标, title: "经营分析", desc: "资产负债表→比率与经营分析表", tone: "var(--tone-skill)", href: "/chat/new?prompt=请根据资产负债表和利润表生成经营分析表" }`。
2. **新建技能** `agent-skills/skills/business-analysis/SKILL.md`(参照 finance-analysis 的 frontmatter 格式):
   - `name: business-analysis`
   - `description`:覆盖「经营分析表 / 资产负债表+利润表 → 确定性比率(资产负债率、流动比率、毛利率、净利率、环比)/ 数据信任链脚注 / 经营概况」等触发词。
   - 正文:**何时用**(用户要经营分析表/根据三表出经营概况)→ **调 `generate_business_analysis` 工具**(确定性比率,不心算)→ 可套 `report_templates`(save/list/套用)→ 输出带**数据截止日+结算状态**脚注 → **不替用户拍经营决策**(红线 6)。强调比率走死公式工具、分母≤0 返回「不可算」(红线 2/4)。

**红线**:技能正文不得诱导模型心算比率(红线 2);经营分析只给依据不拍板(红线 6);带数据信任链口径(红线 3)。

**验收**:cockpit 快捷操作不再有金蝶草稿/老板月报、出现「经营分析」点击进 /chat/new 带 prompt;新技能被 SDK listing 收录(typecheck 过即可,技能是纯文件);若有 golden/skill 名单测试(如 `skill-plugin.test.ts`)需同步。

---

## 第 3 项 — 对话标题改为便宜模型异步生成 ≤12 字总结(分派 Sonnet 子 Agent)

**现状**:`app/api/agent/query/route.ts`:
- 创建时 `generateShortTitle(lastUserContent)` 截用户首句(≤18)。
- 收尾 `maybeImproveTitle(conversationId, content)`:在第 2 条消息时,从**答案**里挑一行(4–30 字)覆盖标题 → 即用户说的「截取了回答」。
便宜模型调用范式见 `lib/agent/router.ts`(~160 行,raw Anthropic fetch + settings 里的 key/模型)。

**改**(用户已选「便宜模型异步生成」):
1. 新增 `lib/agent/conversation-title.ts`:`generateConversationTitle(firstUserMsg: string, firstAnswer: string): Promise<string | null>`
   - 复用 router 的便宜模型调用方式(同一 key/网关,cheap 档模型),prompt:「为这段财务对话起一个**≤12 字**的中文总结标题,只输出标题,不要标点/引号/前后缀」。
   - 截断/净化到 ≤12 字;失败或空 → 返回 `null`(不编造,红线 4)。
2. route.ts:**替换** `maybeImproveTitle` 的「从答案挑行」为:**异步 fire-and-forget** 调 `generateConversationTitle(firstUserMsg, firstAnswer)`,成功则 `updateChatConversationTitle`;**不阻塞**回合响应;失败回退保留 `generateShortTitle` 的初始标题(不覆盖成空)。仍只在首个完整回合(2 条消息)触发一次。
   - 注意 fire-and-forget 不能抛进响应路径;catch 内吞 + 记日志。

**验收**:首轮结束后标题异步变成 ≤12 字的总结(非答案截取);模型不可用时回退初始标题、不报错不变空;新增 `tests/conversation-title.test.ts` 覆盖净化/截断/失败回退(纯函数部分,模型调用可 mock/SKIP_LLM)。

---

## 集成与验收(我来收口)

合并三组改动后统一跑:`npm run typecheck` + `npm test`(相关子测试)+ `npm run lint`(0 error)。逐项对照上面「验收」。分项提交,ff 合回本地 main。
