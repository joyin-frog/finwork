# UI 风格底座（WP8a：Surface 原语 + 护栏 + 试点收敛）Spec

> 版本 v1.1 / 2026-07-06（v1.0 经 reviewer 裁决 fix first，B1-B6 与 N1-N4 全部修订；限定范围复审**批准**）
> 状态：**已实施并通过审查（ship）**。实施审查 fix first（B1 缺 3 条变体断言、B2 护栏测试内联配置副本从未红过）→修复轮（改读真实 eslint.config.mjs + 红态自证 + N1/N2/N4）→限定范围重审 ship。
> 实施注意（reviewer 复审附带）：`--radius-chip` 只需声明在 `:root`，Surface 用 `rounded-[var(--radius-chip)]` 任意值语法消费即可，**不需要**加进 `@theme inline`（与现有 `shadow-[var(--elevation-*)]` 同一机制）。
> 依赖：无（ROADMAP-improve.md WP8 第一刀；WP9 chat-page 拆解、WP8b+ 全量收敛批次踩在本 spec 之上）
> 架构事实：Tailwind 4，token 全部走 `app/globals.css` 的 `@theme` / `@theme inline`（`tailwind.config.ts` 的 `theme.extend` 为空壳，不要往里加东西）。颜色 oklch；圆角由单旋钮 `--radius: 0.7rem` 经 calc 推导出 `--radius-sm..4xl`；阴影走 `--elevation-*` 三档+inset；tone 系统 14 色带 `fa-toned/fa-tone-*` 工具类。暗色 = next-themes 在 `<html>` 切 `.dark` 类 + `@custom-variant dark`。组件库 `components/ui/`（shadcn 族 53 个，其中 12 个已用 cva），业务组件 `app/components/`（8 个，均未用 cva）。**测试运行器是手动维护的顺序 import 列表 `tests/all.test.ts`，不做目录扫描——新测试文件必须显式加进去才会执行。** `app/knowledge/doc-card.tsx` 是死代码（页面实际用 `app/shared/resource-card.tsx`），但被 `tests/knowledge-ui.test.ts` T2/T4 守护，本期**不碰它**。

## 0. 目标与非目标

**目标**：让"风格"与"结构"解耦——页面代码不再直接写外观类（rounded/shadow/border 族），全部经由 Surface 原语 + 语义 token 获得外观。交付：① Surface 原语组件（cva variants）；② ESLint 护栏（增量禁止新增散落，含模板字符串路径）；③ 风格切换挂载点（`html[data-style]` 机制，只留机制不做第二套风格）；④ 三个试点文件完成收敛证明原语覆盖真实形态。**视觉零变化**（决策 D5：保持现风格）。

**非目标（本期不做，已知并接受）**：
- 不做任何第二套风格 token 包（卡片浮窗/直边分栏/同色连体后置，另起 spec）；
- 不给用户暴露风格切换 UI（appearance-settings 不动）；
- 不拆 chat-page（WP9），不动 `components/ui/` 里 shadcn 组件的内部实现（它们是原语的下层，豁免护栏）；
- 不动 `app/knowledge/doc-card.tsx`（死代码但有测试守护；清理它是独立任务，不混入本 diff）；
- 不做 47 个散落文件的全量收敛——只做 3 个试点，其余按附录 A 清单在 WP8b+ 批次进行。
- **WP9 衔接契约**：WP9 开工时必须先读本 spec 的 Surface API，chat-page 的散落按相同 variant 体系收敛，不得另起一套。

## 1. 成功标准

- [ ] `components/ui/surface.tsx` 存在，导出 `Surface` 与 `surfaceVariants`（cva）；变体组合的 class 输出有单元测试锁定（先写测试看红，再实现）。
- [ ] `tests/ui/eslint-appearance-guard.test.ts`：以 ESLint Linter API 对内联 fixture 跑规则，断言六条路径——① `app/**` 字符串字面量 className 含 `rounded-*`/裸 `rounded` 触发；② 模板字符串 `` className={`rounded ...`} `` 触发；③ `shadow-md` 触发而 `shadow-[var(--elevation-1)]` **不**触发；④ 裸 `border`/`border-2` 触发而 `border-t`/`border-border` 不触发；⑤ `components/ui/**` 豁免；⑥ `app/dev/theme/**` 豁免。先红后绿。
- [ ] **两个新测试文件已加入 `tests/all.test.ts` 的 import 列表**（否则 `npm test` 根本不会执行它们）。
- [ ] `html` 上有 `data-style="default"`；`globals.css` 有风格覆盖挂载区注释块，**并给出暗色组合选择器示例 `html.dark[data-style='x']`**（防止 WP8b 只写 `[data-style='x']` 把暗色 token 盖掉）；默认风格零覆盖，渲染逐像素一致。
- [ ] 三个试点文件（`app/knowledge/page.tsx`、`app/shared/resource-card.tsx`、`app/agents/agent-detail-drawer.tsx`）收敛后按 §4 的三条 rg 验收检查归零（标注豁免行除外），页面视觉与行为不变——现有 e2e（mock 模式）+ `tests/knowledge-ui.test.ts` 跑绿 + 人工对照截图。
- [ ] `app/dev/theme/theme-playground.tsx` 增加 Surface 变体全组合展示区（唯一允许直写外观类做对照的页面，行内 eslint 豁免并注明原因）。
- [ ] `npm run lint`、`npm run typecheck`、`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test` 全绿。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `components/ui/surface.tsx` | 新增 | Surface 原语（cva variants，见 §3） |
| `tests/ui/surface-variants.test.ts` | 新增 | 变体→class 映射单元测试 |
| `tests/ui/eslint-appearance-guard.test.ts` | 新增 | 护栏六路径行为测试 |
| `tests/all.test.ts` | 修改 | 追加两行 `await import(...)` 挂入新测试 |
| `eslint.config.mjs` | 修改 | 追加 `no-restricted-syntax` 规则块（字符串字面量 + TemplateElement 两个 selector），scope `app/**`，warn 级 |
| `app/layout.tsx` | 修改 | `<html>` 加 `data-style="default"` |
| `app/globals.css` | 修改 | `--radius-chip: 0.25rem` 语义 token + 风格覆盖挂载区注释块（含暗色组合选择器示例） |
| `app/knowledge/page.tsx` | 修改 | 试点收敛 |
| `app/shared/resource-card.tsx` | 修改 | 试点收敛（knowledge 页实际在用的卡片） |
| `app/agents/agent-detail-drawer.tsx` | 修改 | 试点收敛 |
| `app/dev/theme/theme-playground.tsx` | 修改 | 加 Surface 展示区 |

实施中发现需要动列表外文件（例如试点页引用的其他子组件也有散落），停止并报告，不要顺手改——那属于 WP8b 批次。

## 3. 实施步骤

1. **先写红测试**：`tests/ui/surface-variants.test.ts`（Surface 尚不存在即红）与 `tests/ui/eslint-appearance-guard.test.ts`（规则未加即红），同步把两个文件挂进 `tests/all.test.ts`。
2. **Surface 原语**（`components/ui/surface.tsx`）：参照既有 cva 模式（`components/ui/badge.tsx`、`components/ui/button.tsx`），className 合并用 `cn()`（`lib/utils.ts`）。API：
   ```tsx
   <Surface level="card" edge="hairline" shape="panel" inset={false} className?>
   ```
   - `level`: `page | panel | card | overlay` → 背景+elevation（`--color-background/--color-card/--color-popover` × `--elevation-1/2/3`）；
   - `edge`: `none | hairline | strong` → 边框（`--color-border`；strong 取试点现状写法）;
   - `shape`: `none | chip | control | card | panel | overlay | pill` → 圆角：
     - `chip` → `rounded-[var(--radius-chip)]`（新语义 token `--radius-chip: 0.25rem`，承接试点里 8 处裸 `rounded`，像素不变）；
     - `control` → `rounded-md`（试点 19 处）；
     - `card` → `rounded-lg`（resource-card 卡片本体等）；
     - `panel` → `rounded-xl`；`overlay` → `rounded-2xl`；`pill` → `rounded-full`（5 处）。
   变体默认值取试点最高频组合（level=card, edge=hairline, shape=card）。**不要发明新视觉**——每个 variant 的 class 值必须来自试点文件现状。
3. **ESLint 护栏**：`eslint.config.mjs` 追加 files-scoped 块（`files: ["app/**/*.tsx"]`，`ignores: ["app/dev/theme/**"]`），`no-restricted-syntax` 两个 selector：
   - 字符串字面量：`JSXAttribute[name.name="className"] Literal[value=/\brounded(\b|-)|\bshadow-(?!none|\[var)|(^|\s)border(-[0-9])?(\s|$)/]`；
   - 模板字符串：`JSXAttribute[name.name="className"] TemplateElement[value.raw=/\brounded(\b|-)|\bshadow-(?!none|\[var)|(^|\s)border(-[0-9])?(\s|$)/]`（agent-detail-drawer.tsx:166 正是模板写法，必须盖住）。
   两条 message 一致："外观类请改用 Surface 原语或语义 token（见 docs/spec/spec-ui-foundation.md）"。**warn 级**（44 个存量文件未收敛，CI 不能红；WP8 全批次完成后升 error）。`cn()` 参数是字符串字面量，第一条 selector 天然覆盖。
4. **风格挂载点**：`app/layout.tsx` html 加 `data-style="default"`；`globals.css` 末尾注释块写明：新风格 = `[data-style='x'] { --token 覆盖 }` + 暗色须用组合选择器 `html.dark[data-style='x'] { ... }`（特异性 [0,2,0] 高于单独 `.dark`，不会被吃掉）+（如需）Surface variant 映射调整。不写任何实际覆盖。
5. **试点收敛**：逐文件把直写外观类替换为 `<Surface>` 或语义 token 类，对照运行页面逐块核对视觉。原语盖不住的形态：优先补 variant 档位（回步骤 2 补测试），不留散落。注意 `resource-card.tsx` 若被 `tests/knowledge-ui.test.ts` 或其他测试断言文本/props，只改 className 不动结构。
6. **playground 展示区**：Surface 全变体组合网格，标注每档对应 token。

## 4. 测试与验证方式

```bash
# 单测（运行器 = tests/all.test.ts 手动列表，务必确认新文件已挂入）
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

npm run lint && npm run typecheck

# e2e（mock 模式，两个终端）
npm run test:e2e:serve   # 终端 1
npm run test:e2e:fast    # 终端 2

# 试点文件散落归零验收（三条分开查，rg 语义明确；标注了行内豁免的行除外）
rg -n '\brounded(\b|-)' <试点文件>                     # 应零命中
rg -n 'shadow-' <试点文件> | grep -v 'shadow-\[var'    # 应零命中
rg -n '(^|[^-[:alnum:]])border([^-[:alnum:]]|$)|border-[0-9]' <试点文件>   # 应零命中

# 视觉核对（人工）：npm run dev 对照 /knowledge、/agents 抽屉改造前后截图
```

- 新增测试：surface 变体映射（每 variant 至少一条 + 默认组合一条）；eslint 护栏六路径（§1 第 2 条）。
- 相关既有测试必须确认不回归：`tests/knowledge-ui.test.ts`（守护 knowledge 域文件的存在性与文本断言）。
- 不需要跑：golden eval、`test:e2e:real`。

## 5. 风险与开放问题

- **视觉回归风险**：试点文件同类部位圆角档位可能杂乱，规则：保持各处现状档位，用最贴近 variant 表达；确需统一时统一到多数档并在 audit 逐处列出（reviewer 重点看）。
- **护栏已知漏检（有意接受）**：className 经变量间接传入（`className={styles}`）或在非 className 属性中拼接的场景检测不到——护栏定位是"挡住最常见写法+新人提示"，剩余靠 code review；两个 selector（Literal + TemplateElement）已覆盖仓库现存的全部直写形态。
- **`border` 正则边界**：`border-t/-border/-input` 等定向/颜色类合法不拦；裸 `border` 与 `border-<数字>` 拦。以 fixture 测试为准。
- 被否决的备选：① `eslint-plugin-tailwindcss`（引依赖只为一条规则）；② 一次性全量收敛 47 文件（diff 审不完，违反 D1）；③ React Context 传风格（CSS 变量天然级联，多余抽象）；④ 把裸 `rounded` 就近归并到 `--radius-sm`（≈0.35rem，像素会变，违反视觉零变化——改为新增 `--radius-chip: 0.25rem` 语义 token）；⑤ 用死代码 `doc-card.tsx` 当试点（页面根本不渲染它，视觉验证无从谈起——换成实际在用的 `resource-card.tsx`）。

> 计划审查记录：2026-07-06 reviewer 裁决 fix first。B1 新测试未挂 all.test.ts（已修：进 Files touched）；B2 doc-card 死代码有测试守护（已修：移出试点、列入非目标，试点换 resource-card）；B3 shape 缺 rounded-lg/裸 rounded 档（已修：补 card 档 + chip 档带新 token）；B4 验收 grep 假阴性（已修：三条 rg 分查）；B5 模板字符串漏检（已修：补 TemplateElement selector + fixture）；B6 shadow-[var 误伤（已修：负向断言 + fixture）；N1 暗色×风格组合选择器写进骨架注释（已采纳）；N2 knowledge-ui.test.ts 写进验证章节（已采纳）；N3 统计修正 53/12（已采纳）；N4 WP9 衔接契约写进非目标（已采纳）。

## 附录 A：WP8b+ 收敛批次清单（全量枚举，防漏改）

rounded 族 47 文件 141+8 处、border 33 文件 73 处、shadow 12 文件 16 处（2026-07-06 统计；含 8 处裸 `rounded`）。试点 3 文件之外的重灾区（rounded/border）：`app/dev/theme/theme-playground.tsx`(10/11，永久豁免)、`app/shared/app-nav.tsx`(8/-)、`app/shared/chat-float.tsx`(6/-)、`app/shared/file-preview-page.tsx`(6/-)、`app/files/page.tsx`(6/-)、`app/components/ask-user-panel.tsx`(5/3)、`app/chat/chat-page.tsx`(5/-，**并入 WP9，按本 spec Surface API 收敛**)、`app/components/tool-cards.tsx`(-/3)、`app/knowledge/doc-card.tsx`(5/-，**死代码，等待独立清理任务，不收敛**)。其余长尾由各批次开工时以 `rg -ln '\brounded(\b|-)|shadow-' app/ -g '*.tsx'` 重新枚举，批次按目录：shared/ → components/ → files+knowledge 长尾 → agents+cockpit 长尾。
