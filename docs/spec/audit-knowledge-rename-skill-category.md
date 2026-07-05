# Audit: knowledge-rename-skill-category

## Files changed

| 文件 | 动作 |
|---|---|
| `tests/shortcuts.test.ts` | 修改 |
| `tests/skills-category.test.ts` | 新增 |
| `tests/all.test.ts` | 修改 |
| `e2e/mock/pages.spec.ts` | 修改 |
| `lib/agent/skills-store.ts` | 修改 |
| `app/skills/skills-shared.tsx` | 修改 |
| `app/skills/file-tree.ts` | 修改 |
| `app/shared/shortcuts.ts` | 修改 |
| `app/shared/global-shortcuts.tsx` | 修改 |
| `app/config/shortcuts/shortcuts-settings.tsx` | 修改 |
| `app/skills/skills-manager.tsx` | 修改 |
| `app/shared/app-nav.tsx` | 修改 |
| `app/shared/resource-tabs.tsx` | 修改 |
| `app/files/page.tsx` | 修改 |
| `agent-skills/skills/xlsx/SKILL.md` | 修改 |
| `agent-skills/skills/pdf/SKILL.md` | 修改 |
| `agent-skills/skills/docx/SKILL.md` | 修改 |
| `agent-skills/skills/pptx/SKILL.md` | 修改 |
| `agent-skills/skills/payroll-calc/SKILL.md` | 修改 |
| `agent-skills/skills/reimbursement-check/SKILL.md` | 修改 |
| `agent-skills/skills/kingdee-draft/SKILL.md` | 修改 |
| `agent-skills/skills/finance-analysis/SKILL.md` | 修改 |
| `agent-skills/skills/business-analysis/SKILL.md` | 修改 |
| `agent-skills/skills/contract-extract/SKILL.md` | 修改 |
| `agent-skills/skills/tax-incentive/SKILL.md` | 修改 |
| `agent-skills/skills/rnd-deduction-check/SKILL.md` | 修改 |

## 每个文件改了什么

**tests/shortcuts.test.ts**
- AC6 碰撞 key 从 `${s.scope === "composer" ? "composer" : "active"}:${s.combo}` 改成 `${s.scope}:${s.combo}`，使 chat:mod+f / config:mod+f / skills:mod+f 各自独立
- 数量上限 `<= 12` 改为 `<= 14`
- 新增 AC7：验证 scope="skills"+mod+f 命中 search-skills；scope=undefined 时返回 null；scope="chat" 时命中 find-in-chat 不串

**tests/skills-category.test.ts**（新增）
- 纯逻辑测试 `filterByCategory`（all/file-tool/finance/user 四种分支）
- 数据测试：读 12 个内置 SKILL.md，断言各含正确 `category:` 行

**tests/all.test.ts**
- 在 shortcuts-wiring 后注册 `skillsCategoryTestPromise`

**e2e/mock/pages.spec.ts**
- L11 导航断言 `name: "资料"` → `name: "知识库"`

**lib/agent/skills-store.ts**
- `ParsedSkill` 类型加 `category: string`
- `parseSkillMd` 兜底 return 加 `category: ""`
- `parseSkillMd` 循环加 `else if (key === "category") category = decodeScalar(val);`；正常 return 带上 `category`
- `SkillSummary` 类型在 description 后加 `category: string`（带注释）
- `toSummary` 映射加 `category: s.category`

**app/skills/skills-shared.tsx**
- 前端 `SkillSummary` 类型加 `category: string`（带注释）

**app/skills/file-tree.ts**
- 新增 `filterByCategory<T>` 纯函数：all=全部，user=source==="user"，其余按 category 精确匹配

**app/shared/shortcuts.ts**
- `ShortcutScope` 加 `"skills"`
- `SHORTCUTS` 末尾加 `search-skills`（mod+f, scope skills, allowInInput, webLimited）
- `resolveShortcut` options.scope 类型加 `| "skills"`
- scope-skip 判断加 `|| shortcut.scope === "skills"`

**app/shared/global-shortcuts.tsx**
- pathname→scope 三元加 `/skills`→"skills"
- `GROUPS` 类型与"全局与面板"scopes 数组加 `"skills"`

**app/config/shortcuts/shortcuts-settings.tsx**
- 同 global-shortcuts：`GROUPS` 类型与"全局与面板"scopes 数组加 `"skills"`

**app/skills/skills-manager.tsx**
- import 加 `useRef`、`filterByCategory`、`useShortcutEvent`
- `type Category` 改为 `"all" | "finance" | "file-tool" | "user"`
- 组件内加 `searchInputRef = useRef<HTMLInputElement>(null)` 和 `useShortcutEvent("search-skills", ...)`
- `<input>` 加 `ref={searchInputRef}`
- 过滤改用 `filterByCategory(filterSkills(skills, query), category)`
- chips 改为 全部/财务/文件工具/个人

**app/shared/app-nav.tsx**
- L261 `href="/files"` → `href="/knowledge"`；`<span>资料</span>` → `<span>知识库</span>`

**app/shared/resource-tabs.tsx**
- 换位：知识库(/knowledge) 在前，对话文件(/files) 在后

**app/files/page.tsx**
- L658 `title="资料预览"` → `title="文件预览"`

**12 个 SKILL.md**
- xlsx/pdf/docx/pptx：各在 `requires:` 后加 `category: file-tool`
- payroll-calc/reimbursement-check/kingdee-draft/finance-analysis/business-analysis/contract-extract/tax-incentive/rnd-deduction-check：各在 `starter:` 后加 `category: finance`

## 与计划的偏差

无偏差。所有变更严格按 spec 阶段 1-5 执行，Files touched 完全覆盖。

## 测试结果

### TDD 红→绿证据

**阶段 1（红）**：
```
node --import tsx tests/shortcuts.test.ts
# → AssertionError: AC7 FAIL: skills 页 mod+f 应命中 search-skills（search-skills 未注册）

node --import tsx tests/skills-category.test.ts
# → TypeError: filterByCategory is not a function
```

**阶段 2-3（绿）**：
```
node --import tsx tests/skills-category.test.ts
# → skills-category checks passed ✓

node --import tsx tests/shortcuts.test.ts
# → shortcuts: all 6 checks passed ✓
```

### TypeScript 检查
```
npx tsc --noEmit 2>&1 | grep -v "^tests/" | grep -v "^\.next/" | grep "error TS"
# → (空，无输出)
```

### 全量回归
```
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/all.test.ts
# shortcuts: all 6 checks passed ✓
# shortcuts-wiring: all 4 checks passed ✓
# skills-category checks passed ✓
# TAP: 9 pass, 0 fail
```

全量 exit code 为 1，原因是 `settings-refactor.test.ts` 的 "F5-2 FAIL: model 页应用 SettingsRow/SettingsField" unhandledRejection，这是**本任务范围外的既有失败**，在 git stash 前后均存在，与本任务无关。

## 开放风险

1. **settings-refactor 既有失败**：`tests/settings-refactor.test.ts` F5-2 断言在 git stash（回到无改动状态）后仍失败，是上一任务遗留问题，需单独修复。
2. **`/skills/[name]` 详情页**：pathname 满足 `startsWith("/skills")`，scope 也推到 "skills"，但详情页没有 `useShortcutEvent("search-skills")`，按 mod+f 时 dispatch 出去无人接收——可接受，spec 已明确不做。
3. **e2e 未实际跑**：e2e 需起 mock server，主循环统一验证；pages.spec.ts L11 断言已按 spec 改为"知识库"。
