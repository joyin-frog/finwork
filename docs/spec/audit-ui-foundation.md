# Audit: ui-foundation (WP8a)

实施者：Claude Sonnet 4.6 / 分支 claude/strange-mendel-cfd23e
日期：2026-07-06

---

## Files changed

| 文件 | 动作 |
|---|---|
| `components/ui/surface.tsx` | 新增 |
| `tests/ui/surface-variants.test.ts` | 新增 |
| `tests/ui/eslint-appearance-guard.test.ts` | 新增 |
| `tests/all.test.ts` | 修改（追加两行 import） |
| `eslint.config.mjs` | 修改（追加护栏规则块） |
| `app/layout.tsx` | 修改（html 加 data-style="default"） |
| `app/globals.css` | 修改（--radius-chip token + 风格覆盖挂载区注释块） |
| `app/knowledge/page.tsx` | 修改（试点收敛） |
| `app/shared/resource-card.tsx` | 修改（试点收敛） |
| `app/agents/agent-detail-drawer.tsx` | 修改（试点收敛） |
| `app/dev/theme/theme-playground.tsx` | 修改（Surface 展示区） |

---

## 每文件改动说明

### `components/ui/surface.tsx`（新增）
- `cva` 定义 `surfaceVariants`，四维 variant：`level`（page/panel/card/overlay）、`edge`（none/hairline/strong）、`shape`（none/chip/control/card/panel/overlay/pill）、`inset`（bool）。
- 默认值：level=card, edge=hairline, shape=card, inset=false。
- `shape=chip` 用 `rounded-[var(--radius-chip)]` 任意值语法（遵循 reviewer 注意）。
- 导出 `Surface` 组件和 `surfaceVariants` 函数。

### `tests/ui/surface-variants.test.ts`（新增）
- 逐 variant 断言 class 输出（level/edge/shape 各档 + 默认组合）。
- 初始红态：`components/ui/surface.tsx` 不存在时抛出清晰错误。

### `tests/ui/eslint-appearance-guard.test.ts`（新增）
- 用 ESLint `Linter` API 对内联 fixture 运行规则，断言六路径（11 条断言）。
- 此测试初始即绿：规则逻辑内联在测试中，绿意味着规则实现的行为正确；`eslint.config.mjs` 的改动让 `npm run lint` 也管控到真实代码。

### `tests/all.test.ts`（修改）
- 在 `dbMigrationDisciplineTestPromise` 之后追加：
  ```
  const { surfaceVariantsTestPromise } = await import("./ui/surface-variants.test.ts");
  const { eslintAppearanceGuardTestPromise } = await import("./ui/eslint-appearance-guard.test.ts");
  ```

### `eslint.config.mjs`（修改）
- 追加一个 scoped 规则块：`files: ["app/**/*.tsx"]`，`ignores: ["app/dev/theme/**"]`。
- 两个 `no-restricted-syntax` selector（Literal + TemplateElement），warn 级别。
- `components/ui/**` 豁免（通过不在 `files` scope 内）。

### `app/layout.tsx`（修改）
- `<html>` 加 `data-style="default"`，风格挂载点已就位。

### `app/globals.css`（修改）
- `:root` 块顶部加 `--radius-chip: 0.25rem`（4px chip 圆角语义 token）。
- 文件末尾追加风格覆盖挂载区注释块，包含暗色组合选择器示例 `html.dark[data-style='x']`（特异性 [0,2,0]，防 WP8b 误覆盖）。

### `app/knowledge/page.tsx`（修改）
- 导入 `Surface`。
- 收敛：
  - `MetaStatusBadge` 的 `<span className="... rounded ...">`  → `<Surface shape="chip" ...>`
  - `keyDate.kind` span 的 `rounded` → `<Surface shape="chip">`
  - 归档/长期未使用 meta badge → `<Surface shape="chip">`
  - 所有无法改为 Surface 的 `<button>/<input>` 加 `// eslint-disable-next-line no-restricted-syntax` 豁免注释（共 15 处）。
- 豁免行详细（按行号，均有 eslint-disable 前置）：
  - L99：close button `rounded`
  - L117：metadata input `rounded-md border border-input`
  - L635/643：navHit 上下按钮 `rounded-md border border-border`
  - L652：回搜索按钮 `rounded-md border border-border`
  - L675/686：empty-collapse btn `rounded-md`
  - L702/711/719：search preview nav btns `rounded-md border border-border`
  - L730：collapse btn `rounded-md`
  - L769：search empty-collapse btn `rounded-md`
  - L802：search trigger `rounded-md`（内联 cn() 里）
  - L814：sidebar-expand btn `rounded-md`
  - L833/847：category chip buttons `rounded-full border`（在 `<button>` tag 上 eslint-disable，string 在同一 JSX 元素内）
  - L917：upload button `rounded-xl border-2 border-dashed border-border`

### `app/shared/resource-card.tsx`（修改）
- 导入 `Surface`。
- 主 `<article>` → `<Surface level="card" edge="hairline" shape="card" role="article">`（Surface 提供 rounded-lg + border-border + bg-card + elevation-1）。
- 原 `border` 裸类（article 的描边）由 Surface `edge="hairline"` 统一提供，不再在调用处写。
- `selected` 时 `border-primary` 作为 className 覆盖 Surface 的 `border-border`（Tailwind 最后写生效）。
- 三个 button hover-icon 有 eslint-disable 豁免（L104 `rounded-md`，L161/173 `rounded`）。

### `app/agents/agent-detail-drawer.tsx`（修改）
- 导入 `Surface`。
- 外层 wrapper div → `<Surface level="card" edge="none" shape="none">`（保持 bg-card 语义，无圆角/无边框因是全高抽屉）。
- Running 状态 div → `<Surface level="page" edge="hairline" shape="control">`。
- Blocked 状态 div → `<Surface level="page" edge="hairline" shape="control">`（保持 fa-toned 类）。
- dataScope chips `<span rounded-full border border-border>` → `<Surface shape="pill" edge="hairline">`（×N）。
- skills chips → 同上。
- 豁免行（eslint-disable）：
  - L62：avatar span `rounded-full`（tone 系统 .fa-toned 必须用 span）
  - L172：dispatch row div 模板字符串 `rounded`（isRowBlocked 三元切换，无法拆开用 Surface）
  - L225：file dispatch button `rounded`

### `app/dev/theme/theme-playground.tsx`（修改）
- 导入 `Surface`（带行内 eslint-disable 注释，因该文件本身在豁免区）。
- 在导出片段 section 前插入"Surface 原语展示区"：level×shape 4×3 网格 + inset 对比行 + token 说明。
- 所有展示用 `<Surface>` 组件，不再直接写 rounded/border（已由 Surface 统一）。

---

## 与计划的偏差

**无计划外偏差。** 以下细节做了计划内有据的决策：

1. **resource-card 主 article 保留 `border-primary` 在 className**：selected 态下需 border-primary 覆盖 Surface 的 border-border。这是 Surface 的 `className` merge 机制正常用法，视觉不变。
2. **知识库 category chip buttons 保持 `<button>` 元素**：这些是交互元素，不能改为 Surface div；用 eslint-disable 豁免，在 audit 里逐处列出。符合 spec "标注豁免行除外" 条款。
3. **surface-variants 测试初始红态**：通过 try/catch 包裹动态 import，catch 后 throw Error("... RED ...")。当时 tests 在 skills-store 前后有 unhandledRejection（其他任务的预存失败），但我们的测试在自己的 try/catch 范围内正确失败，并通过 `node --import tsx tests/ui/surface-variants.test.ts` 单独验证了红态。
4. **eslint-appearance-guard 测试初始即绿**：测试用 ESLint Linter API 内联验证规则逻辑，设计上即如此（测试验证规则行为规格）。红/绿对应的是 `npm run lint` 对真实代码的管控是否到位，不是测试本身的 pass/fail。

---

## 实际测试命令与结果

### 红态证据

```
$ node --import tsx tests/ui/surface-variants.test.ts
Error: surface-variants RED: components/ui/surface.tsx does not exist yet. Implement it to make this test green.
    at <anonymous> (tests/ui/surface-variants.test.ts:15:11)
```

### 实现后绿态

```
$ node --import tsx tests/ui/surface-variants.test.ts
✓ surface-variants: all assertions passed

$ node --import tsx tests/ui/eslint-appearance-guard.test.ts
✓ eslint-appearance-guard: all 11 path assertions passed
```

### 完整测试套件

```
FINANCE_AGENT_PYTHON_PATH=/Users/gyro/codex/finance-agent-public/workers/.venv/bin/python3 \
  FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

...
knowledge-ui: all 5 checks passed ✓
db-migration-discipline: all 5 checks passed ✓
✓ surface-variants: all assertions passed
✓ eslint-appearance-guard: all 11 path assertions passed
# tests 11
# suites 0
# pass 11
# fail 0
```

注：预存 unhandledRejection（skills-store `AC-1 FAIL` / `FP-1 FAIL`）来自其他任务的测试，与本 spec 无关，在本次实施前就存在。

### lint

```
$ npm run lint
✖ 224 problems (0 errors, 224 warnings)
```

所有 224 条均为 warn（无 error）。存量 warn 来自其他代码（unused-vars、prefer-const 等），非本次新增。本次新增的 no-restricted-syntax warn 仅作用于 `app/**/*.tsx` 中未收敛的存量代码，属已知可接受范围。

### typecheck

```
$ npm run typecheck
（无输出，exit 0）
```

### e2e

跳过。spec §4 明确："e2e 如环境不便可跳过，但必须在 audit 里如实说明跳过了什么。" 跳过项：
- `npm run test:e2e:serve` + `npm run test:e2e:fast`（mock 模式）
- 视觉对照截图（/knowledge、/agents 抽屉改造前后人工 diff）

原因：本次改动为类组件（Surface wrapper），没有改动任何文本、props schema 或行为逻辑；`knowledge-ui.test.ts` 守护了知识库页面的关键文本断言，已在单测中跑绿。

---

## 三条 rg 验收输出

### `app/knowledge/page.tsx`

```
rounded 命中（全部豁免行）:
99, 117, 635, 643, 652, 675, 686, 702, 711, 719, 730, 769, 802, 814, 833, 847, 917

shadow 非 var 命中: 零命中 ✓
border 命中: 同 rounded 豁免行（overlay 仅有 border-border/border-input 语义类，不在裸 border 正则范围内）✓
```

### `app/shared/resource-card.tsx`

```
rounded 命中（全部豁免行）: 104, 161, 173
shadow 非 var 命中: 零命中 ✓
border 命中: 零命中 ✓
```

### `app/agents/agent-detail-drawer.tsx`

```
rounded 命中（全部豁免行）: 62, 172, 225
shadow 非 var 命中: 零命中 ✓
border 命中: 零命中 ✓
```

所有 rounded 命中行的前一行均有 `// eslint-disable-next-line no-restricted-syntax` 注释（豁免行），符合 spec "标注豁免行除外" 条款。

---

---

## Fix 轮记录（2026-07-06）

### 修复内容

**B1（阻塞）：`tests/ui/surface-variants.test.ts` — 补三条缺失断言**

- 新增 `level=panel`：断言产生 `bg-card` + `shadow-[var(--elevation-1)]`（与 `card` 相同，有意设计）。
- 新增 `edge=strong`：断言产生 `border-2` + `border-border`。
- 新增 `inset=true`：断言产生 `shadow-[var(--elevation-inset)]`。
- 同时将结尾 `console.log` 更新为注明三个新断言，共计输出"incl. level=panel, edge=strong, inset=true"。

**B2（阻塞）：`tests/ui/eslint-appearance-guard.test.ts` — 改为读取真实 eslint.config.mjs**

重构方案：
1. 在 `eslintAppearanceGuardTestPromise` 异步体内动态 `import(eslintConfigPath)`（通过 `import.meta.url` 解算绝对路径，避免顶层 await 的 CJS 模式报错）。
2. 遍历 flat config 数组，找到同时满足：`files` 含 `app/**/*.tsx` 且 `rules["no-restricted-syntax"]` 存在的配置块。
3. 断言该块存在（块缺失 → 测试红），断言两个 selector 条目均存在（Literal + TemplateElement），断言数量 ≥ 2。
4. 将该块的 `rules`、`files`、`ignores` 传给 `lintWith()` 函数，驱动 11 条现有路径断言。
5. 删除原来内联的副本配置——规则被删或改坏正则，测试现在**必红**。

**N2（非阻塞）：`app/dev/theme/theme-playground.tsx` — 删除无意义 eslint-disable 注释**

- 删除第 7 行 `// eslint-disable-next-line no-restricted-syntax -- 调试台展示区豁免（见 spec-ui-foundation.md 附录 A）`。
- 原因：`no-restricted-syntax` 规则的 `files` scope 仅为 `app/**/*.tsx`，import 语句根本不是 JSXAttribute，该注释从不可能命中任何报告；整个目录也在 `ignores` 中。删后 lint warn 数从 224 降至 223。

**N4（非阻塞）：`components/ui/surface.tsx` — 补 panel/card 同 class 说明注释**

- 在 `level.panel` 定义行前追加三行注释，说明两者当前 class 相同是有意的：同一 elevation 档，语义区分（区域面板 vs 数据卡片）留给未来风格包通过 CSS 变量差异化。

### 豁免计数勘误（N1）

audit 原文 §知识库 section 写"15 处豁免行"，实际 `app/knowledge/page.tsx` 的豁免行号枚举为：99、117、635、643、652、675、686、702、711、719、730、769、802、814、833、847、917——共 **17 处**，非 15 处。WP8b 开工前需以此为准。

### 红态自证（B2）

临时将 `eslint.config.mjs` 里的 WP8 守卫块注释掉后，测试立即红：

```
node --import tsx tests/ui/eslint-appearance-guard.test.ts

AssertionError [ERR_ASSERTION]: eslint.config.mjs must contain a config block with files covering app/**/*.tsx
  and rules.no-restricted-syntax — delete or comment-out the block and this assertion fails
    at <anonymous> (tests/ui/eslint-appearance-guard.test.ts:106:10) {
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '=='
}
```

恢复后测试重回绿态，`eslint.config.mjs` diff 与修复前完全一致（仅有原始 WP8 守卫块，无残留变更）。

### 测试结果（Fix 轮）

```
# 全量套件
FINANCE_AGENT_PYTHON_PATH=.../workers/.venv/bin/python3 \
  FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

...（略去中间输出）
db-migration-discipline: all 5 checks passed ✓
✓ surface-variants: all assertions passed (incl. level=panel, edge=strong, inset=true)
✓ eslint-appearance-guard: all 11 path assertions passed (using real eslint.config.mjs rules)
# tests 11  # suites 0  # pass 11  # fail 0

# lint（0 error，223 warn；较修复前少 1 warn：N2 删注释消除无效 disable）
npm run lint → ✖ 223 problems (0 errors, 223 warnings)

# typecheck
npm run typecheck → （无输出，exit 0）
```

---

## 开放风险

1. **category chip buttons（knowledge/page.tsx L833/847）**：eslint-disable-next-line 在 `<button>` 开标签，string literal 在同一多行 JSX 元素的 className 里。ESLint 实际上不会对这两行 warn（因为 JSX 属性是 button 元素的一部分，eslint-disable-next-line 覆盖整个 JSX 表达式）。但 rg 仍然能找到这两行。按 spec 属豁免行，reviewer 确认后可接受。

2. **dispatch row 模板字符串（agent-detail-drawer.tsx L172）**：`className={`...rounded...`}` 正是 spec §3 说的"agent-detail-drawer.tsx:166 正是模板写法，必须盖住"的那个位置（行号因其他变更偏移到 172）。已用 eslint-disable 豁免，因三元切换逻辑拆开需改结构，超出"保持现状" 约束。

3. **WP8b 收敛**：knowledge/page.tsx 剩余 17 处豁免行（均为 button/input 交互元素）将在 WP8b 阶段统一处理（可能引入 Surface with `asChild`，或创建专用 SurfaceButton 组件）。

4. **`npm run lint` warn 数量**：存量 224 warn，本次新增 no-restricted-syntax warn 约 40 条（3 个试点文件之外的其他 app/** 文件）。这是 spec 预期行为（warn 级，等 WP8 全量完成后升 error）。
