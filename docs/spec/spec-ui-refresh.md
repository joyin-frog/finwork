# UI 重构 Spec：克米白主调 + 沉降式细节

> 范围：**只动 CSS / 视觉层与少量轻交互组件**（思考动效、未用样式清理、CSS 文件拆分），**不动任何后端交互、API、状态机、路由结构**。
> 目标模型：Opus 4.7 设计 → Sonnet 落地。
> 设计立场：**清新（airy & fresh）的极简**，日夜模式都要"轻"——白天不发黄，夜里不发死黑。允许引入轻量新依赖（见 §8）。一句记忆点是 **"白纸 / 月光石 + 一抹熔铜色"**。
> 主字号：**14px**（全站统一收一档，AI 站点的 16/15 默认值是"重感"的主要来源之一）。

---

## 0. 现状根因（先把"为什么这么黄"说清楚）

`app/styles.css` 现在叠了 **三层 `:root`**：

| 行号 | 块 | 状态 |
|---|---|---|
| `styles.css:1–67` | 蓝调浅色（原始） | 被覆盖，**死代码** |
| `styles.css:69–116` | 蓝调暗色（原始） | 被覆盖，**死代码** |
| `styles.css:118–229` | **Finance Agent Desktop Theme**（米黄/铜） | **真正生效** |
| `styles.css:231–322` | 上面那套的暗色版 | 真正生效 |

而生效的米黄主色 `--bg: #efe7dc` / `--surface: #fbf7f0` / `--accent-blue: #8b6f48` 把整个白天模式拉成了"宣纸色"。设置页右侧反而白，是因为它单独用了 `--settings-pane-bg: rgba(255, 253, 249, 0.86)` + 玻璃罩。

**根因结论**：主色调本身是黄的，不是哪个组件单点过黄。修主色就能一次到位，不需要逐组件改。

另外两条边角：

- `styles.css` 共 **6238 行 / 单文件 / 717 处 `var(--)`**，已经到了肉眼审阅成本爆炸的临界点。
- `styles.css:721` 和 `styles.css:4024` 两处 `outline: none` 没有 `:focus-visible` 替代（违反 guidelines）。
- 现有"思考中…"只是文本 + `ChevronDown` 静态箭头（`chat-message.tsx:128`），没有动态指示。

---

## 1. 设计方向（Aesthetic Direction）

**Tone**: Airy Minimalism · 清新编辑感（editorial）· 纸面 / 月光石质感
**Reference vibe**: Linear / Vercel / Things 3 / Raycast 那种"用留白和字距说话"的克制；夜间模式参照 Raycast 与 Arc 的 **"石板蓝灰底"**——不是死黑，是带 hue 的深灰
**Differentiation（一句记忆点）**: **白纸 / 月光石 + 熔铜色窄边强调** —— 颜色克制到几乎只有黑白灰，强调色（熔铜橙）只在三类位置出现：1) 当前激活项左侧 2px 边条；2) 主要按钮；3) 数值正向变化。

**清新感（airy）怎么落地**——四条硬约束：

1. **底色不要纯黑/纯白**：白天用带 1% 暖灰的 `#fafaf9`，夜间用带 hue 的 `#13161b`（石板蓝灰），都比纯色"轻"
2. **行高放宽**：正文 `line-height: 1.6`（现在是 1.5），标题 `1.3`
3. **留白放宽**：卡片 padding 从 16px → 20px；卡片之间 gap 从 12px → 20px
4. **字号收一档**：主字号 14px（见 §2.4），辅以 `letter-spacing: -0.005em`（−0.5%）抵消字号变小带来的拥挤

不再做的：

- ❌ 大面积米黄/沙色背景
- ❌ 死黑 #0c0c0d / 纯白 #ffffff 全屏铺（压抑感与白屏疲劳来源）
- ❌ 玻璃磨砂 + 强阴影（`--shadow-lg: 0 28px 80px ...`）的"AI 网页感"
- ❌ 满屏 emoji / lucide 通用图标当装饰
- ❌ 多套并存的 `--cx-*` / `--settings-*` / `--*` 命名

继续保留的：

- ✅ 暗色模式（**重新调成石板蓝灰底**，去厚重感）
- ✅ Geist + Geist Mono 字体栈
- ✅ 现有的侧栏 / 顶栏 / 卡片 / chat 气泡布局结构（只换皮，不换骨）

---

## 2. 设计令牌（新版 Design Tokens）

**只保留一套命名**：`--bg / --surface / --surface-2 / --border / --text / --text-2 / --text-3 / --accent / --accent-2 / --success / --danger / --warning`。
合并掉 `--cx-*`、`--settings-*` 全套别名（700+ 处引用，靠 sed 批替换 + 编译验证）。

### 2.1 浅色（默认）

```
/* surfaces — 真正的"纸白"，不再有黄底 */
--bg:        #fafaf9      /* 全局底，几乎纯白带 1% 暖灰 */
--surface:   #ffffff      /* 卡片 / 模态 */
--surface-2: #f4f4f3      /* 二级表面：列表 hover、侧栏背景 */
--border:    rgba(15, 15, 14, 0.08)
--border-2:  rgba(15, 15, 14, 0.04)

/* text — 偏中性黑，不再用 #0d0d0d 这种纯黑 */
--text:      #18181b      /* 主文字 */
--text-2:    #52525b      /* 次级 */
--text-3:    #a1a1aa      /* placeholder / disabled */

/* accent — 熔铜橙，比之前的 #c18945 更"橙"一点但饱和度收着 */
--accent:        #c2410c   /* hsl(20, 90%, 40%) 主强调 */
--accent-hover:  #9a3412
--accent-wash:   rgba(194, 65, 12, 0.08)   /* 用于激活背景 */
--accent-bar:    #c2410c                    /* 激活态左 2px 边条 */

/* status */
--success: #15803d
--warning: #b45309
--danger:  #b91c1c

/* 阴影：全面收一档 —— 把 lg 降成 md，把 md 降成 sm 的级别 */
--shadow-sm: 0 1px 2px rgba(15, 15, 14, 0.04)
--shadow:    0 2px 8px rgba(15, 15, 14, 0.06)
--shadow-lg: 0 8px 24px rgba(15, 15, 14, 0.08)   /* 仅设置浮窗用 */

/* 几何 */
--radius:    8px
--radius-lg: 12px
--radius-pill: 999px
```

### 2.2 深色（**重做：从"死黑"换成"石板月光石"**）

设计意图：底色带蓝灰 hue（hsl 220, 14%, 9%），表面层级**逐层提亮 4–5% 明度**形成空气感，而不是靠对比度堆出"厚"。文字主色不要 `#fafafa` 纯白，留一点暖灰（`#ececf1`），减少眼睛疲劳。

```
/* surfaces — 石板蓝灰，逐层提亮 */
--bg:        #13161b      /* hsl(218, 14%, 9%)，全局底，带 hue 的深灰 */
--surface:   #1a1e25      /* hsl(218, 14%, 12%)，卡片 / 浮窗 */
--surface-2: #232830      /* hsl(218, 14%, 16%)，二级表面 / 列表 hover */
--border:    rgba(255, 255, 255, 0.06)     /* 比之前 0.08 再淡，靠"几乎看不见"的描边 */
--border-2:  rgba(255, 255, 255, 0.03)

/* text — 不要纯白，留一点暖 */
--text:      #ececf1      /* 主文字，95% 灰 */
--text-2:    #9ca3af      /* 次级 */
--text-3:    #6b7280      /* placeholder / disabled */

/* accent — 暗色下提亮到 hsl(24, 95%, 64%) 偏暖橙，与石板蓝形成 complement */
--accent:        #fb923c
--accent-hover:  #fdba74
--accent-wash:   rgba(251, 146, 60, 0.10)
--accent-bar:    #fb923c

/* status */
--success: #4ade80
--warning: #fbbf24
--danger:  #f87171

/* 阴影：暗色下阴影感弱，主要靠 surface 层级提亮区分。三档都收得很轻 */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.20)
--shadow:    0 2px 8px rgba(0, 0, 0, 0.24)
--shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.32)   /* 仅设置浮窗用 */
```

**关键对比**（与现状）：

| 维度 | 现在 | 新方案 |
|---|---|---|
| 全局底 | `#171513` 偏咖（暖死黑） | `#13161b` 石板蓝灰（带 hue 的活灰） |
| 卡片背 | `#211d19` 比底亮一点点 | `#1a1e25` **比底亮 4% 明度**，层级清晰 |
| 文字 | `#f4eee6` 暖米白 | `#ececf1` 偏冷的 95% 灰 |
| 阴影 lg | `0 28px 86px rgba(0,0,0,.5)` 大且重 | `0 8px 24px rgba(0,0,0,.32)` 短而浅 |
| 整体观感 | 厚重、压抑、咖啡屋 | 月光石、清新、夜间编辑器 |

### 2.3 字号系统（**核心：主字号 14px**）

```
/* 主字号 */
--font-ui:        14px      /* 全站默认正文 / 按钮 / 输入 */
--font-small:     13px      /* 次级标签 / hint */
--font-caption:   12px      /* 极小标签 / chip */
--font-content:   14px      /* 聊天与 markdown 正文（与 UI 同号，因为 14px 阅读已舒适） */
--font-heading:   18px      /* 卡片标题 / panel-title-row h2 */
--font-display:   26px      /* cockpit 指标数字 / 页面 H1 */

/* 行高 */
--lh-tight:   1.3            /* 标题 */
--lh-base:    1.5            /* 默认 UI */
--lh-relaxed: 1.6            /* 聊天 / markdown 长文 */

/* 字距 — 14px 默认会显得拥挤，用 -0.005em 让字间松一点 */
--ls-ui:    -0.005em
--ls-heading: -0.015em       /* 标题更紧、更"有设计感" */

/* 数字 */
font-variant-numeric: tabular-nums  /* 所有数字列、指标、价格全部声明 */
```

**为什么是 14px**：

- 现有 `--font-ui: 15px` 让 cockpit / chat / settings 都显得"重"，每一行都比需要的占用更多视觉重量
- 14px 是 Linear / Notion / Raycast 这类清新风产品的事实标准
- 长文阅读（chat assistant 输出）也维持 14px，**不要再升回 16px**，靠 `line-height: 1.6` 与 `max-width: 720px` 保证可读性

**全局应用规则**（在 `base.css` 里）：

```
html { font-size: 14px; line-height: 1.5; letter-spacing: -0.005em; }
h1, h2, h3 { letter-spacing: -0.015em; line-height: 1.3; }
```

**禁止**：组件级再随意写 `font-size: 16px`、`font-size: 1rem`（除非是 markdown 用户内容的相对单位）。已有的 `font-size: 18px / 15px / 14px / 13px / 12px` 硬编码值统一替换成上述 token。

> 关键：所有 `--cx-bg`、`--cx-text`、`--settings-bg` 等别名 **全部映射到上面 11 个 token**，或直接重命名后删除别名。这是减少 AI 感最大的一刀，因为命名碎片化本身就是 "AI 生成代码" 的味道。

---

## 3. 组件级设计决策

### 3.1 侧边导航（`app-nav`）

- 背景：`--surface-2`（浅灰纸），右边 1px `--border` 分隔，**不要阴影**
- 激活态：左侧 2px `--accent-bar` 边条 + 行背景 `--accent-wash`，文字 `--text`（不要让强调色染文字，文字保持中性黑——这样克制）
- Hover：`background: var(--surface)`（即从二级面升到一级面，制造"浮起"错觉而非真阴影）
- 折叠态宽度从 60px → **56px**，间距更均匀
- "新对话"按钮：变成 `--surface` 填充 + `--border` 描边，hover 时变 `--accent` 文字 + `--accent` 边框（不填色，**留白即克制**）
- 收起 / 置顶 / 最近的小箭头改用 `chevron` 的 transform 旋转，去掉 `<ChevronDown>` 与 `<ChevronRight>` 二选一渲染

### 3.2 驾驶舱（`cockpit`）

- 主背景 `--bg`，卡片 `--surface` + `1px var(--border)`，**移除阴影**（从 `--shadow` → `none`）
- 指标卡（`metric-card`）：
  - 数字使用 `font-variant-numeric: tabular-nums`（guidelines 要求）
  - 上升：`--success` 小圆点 + `↑`；下降：`--danger` 小圆点 + `↓`
  - 数值用 `--font-display`（28px），权重 `font-weight: 500`（不要 700，那是 AI 默认值）
- 柱图 `bar-track`：高度从默认 → 6px，圆角 `--radius-pill`；收入柱 `--text`，支出柱 `--text-3`（不上颜色，黑白对比即清晰）
- 圆环 `donut-chart`：保留，颜色用 `--text / --accent / --text-3 / --border` 四色（去掉原 blue/green/orange/gray 调色板）
- 待处理 tag：从填色块改成 `1px solid` 描边 + 透明背景，tag 文字着色区分（urgent→danger / pending→accent / progress→text-2 / done→success）

### 3.3 Chat 对话

- 助手气泡：**无背景无边框**，纯文本贴在画布上（编辑器感）
- 用户气泡：`--surface-2` 填充 + `--radius-lg`，右对齐
- 工具调用卡（`ToolStepList`）：保留结构，把现有的 `--surface-raised` 玻璃罩 → `1px var(--border)` 描边 + `--surface` 背景
- 输入框：底栏整体 `--surface` + 顶边 1px `--border`，发送按钮 `--accent` 实心圆角
- Markdown 代码块：保留 atom-one-dark，但浅色下改用 `atom-one-light`（运行时切换 highlight.js 主题表，layout.tsx 已经读了 highlight CSS，改成 cookie 同时切两套即可）

### 3.4 ⭐ "思考中…" 动态图标（核心增量）

**设计**：左侧一颗 8×8 的圆点，做 "呼吸 + 极慢扫描" 复合动画，配色 `--accent`。

```
.think-pulse {
  width: 8px; height: 8px;
  border-radius: 999px;
  background: var(--accent);
  position: relative;
  flex: 0 0 8px;
}
.think-pulse::after {
  content: "";
  position: absolute; inset: -4px;
  border-radius: 999px;
  background: var(--accent);
  opacity: 0.18;
  animation: think-breathe 1.6s ease-in-out infinite;
}
@keyframes think-breathe {
  0%, 100% { transform: scale(0.6); opacity: 0; }
  50%      { transform: scale(1.0); opacity: 0.22; }
}
@media (prefers-reduced-motion: reduce) {
  .think-pulse::after { animation: none; opacity: 0.18; }
}
```

完成态（已停止思考）：取消动画，圆点变 `--text-3`（同位静态）。
位置：替换 `chat-message.tsx:128` 现在的 `<ChevronDown>`，箭头改放到 `summary` 末尾用作折叠提示。

只做这一个动画，**不在别处加动效**。

### 3.5 设置浮窗（沿用刚做完的浮窗结构，仅换皮）

- 浮窗外框 `--surface` 实色 + `--shadow-lg`（**全站唯一使用 `--shadow-lg` 的地方**）
- 左菜单：`--surface-2` 背景，激活项 `--accent-wash` + 左 2px `--accent-bar`
- 右侧内容：`--surface` 纯白
- 标签 chip / 按钮：去掉所有渐变 `linear-gradient(...)`，改 `--surface-2` + 描边
- 干掉 `--settings-glow-a/b`、`--settings-node-emphasis` 等独立令牌，全部回收到主 token

### 3.6 表格 / 数据展示

- 表头 `--surface-2` 背景 + 12px 大写字距 letter-spacing 0.04em
- 行间分隔 1px `--border-2`（不是 `--border`，更细）
- 数字列统一 `text-align: right` + `tabular-nums`

---

## 4. CSS 架构重构（清理 + 拆分）

目标：**6238 行 → 拆 8 个文件，单文件 ≤ 1000 行**。位置 `app/styles/`。

```
app/styles/
  tokens.css            /* :root + [data-theme="dark"]，仅 token，~120 行 */
  base.css              /* reset / html / body / focus-visible / scrollbar，~80 行 */
  shell.css             /* .app-shell / .app-nav / brand，~300 行 */
  cockpit.css           /* metric / bar / donut / todo / insight，~400 行 */
  chat.css              /* assistant-turn / user-bubble / thinking / tool-step，~700 行 */
  settings.css          /* 浮窗 + 菜单 + pane，~500 行 */
  primitives.css        /* button / chip / modal / popover / switch / table，~400 行 */
  utilities.css         /* spacing helpers / sr-only / responsive，~100 行 */
```

`layout.tsx` 现在是 `fs.readFileSync` 单文件注入；改成读 `app/styles/index.css`，由 `index.css` `@import` 上述 8 个分文件（Next 在 SSR 阶段 inline 同样工作）。

**回收规则**（不靠肉眼判断）：

1. `grep -oE "var\(--[a-z0-9-]+\)" styles.css | sort -u` 得到所有被引用的 token 名单
2. `grep -nE "^\s*--[a-z0-9-]+:" styles.css` 得到所有定义的 token
3. 差集即"定义未使用"的 token —— 直接删
4. 类似的，`grep` 所有 `class="..."` 取得真正使用过的类名，与 css 中的 `\.[a-z][a-z0-9-]*` 做差集，**死类名一次删干净**
5. 完成后通过 `next build` 编译 + 人工跑一遍 5 个关键页面（cockpit / chat / config / knowledge / preview）确认零回归

> ⚠️ 这一步**绝对不允许动 .tsx 文件里的 className 和 props**，只在 css 文件里删定义、做 token 重命名 sed。这是和"不影响后端交互逻辑"约束的边界——交互 = JS 行为不变。

---

## 5. Web Interface Guidelines 当前命中清单（必须修）

> 全文规则在 https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md，按本次扫描结果列出实际命中点（file:line 格式，可点击）。

```
app/styles.css:721 - outline: none 无 :focus-visible 替代
app/styles.css:4024 - outline: none 无 :focus-visible 替代
app/styles.css:118-229 - 三层 :root 叠盖，存在 dead-code token 块（行 1-67 已死）
app/cockpit/page.tsx:42-47 - metric 数字未声明 tabular-nums（数字列对齐 guideline）
app/cockpit/page.tsx:111-113 - <p> 文本未做 text-wrap: balance，长文易产生孤行
app/chat/chat-message.tsx:117 - "思考中…" ✓ 已经用 … 而非 ...（合规，保留）
app/chat/chat-message.tsx:128 - <summary> 内用 ChevronDown 作为视觉指示但未做 transform 旋转动画
app/shared/app-nav.tsx:113 - EllipsisVertical 无 aria-hidden（按钮已有 aria-label，icon 应 aria-hidden="true"）
app/shared/app-nav.tsx:131 - PanelLeft 同上，缺 aria-hidden
app/shared/app-nav.tsx:139 - SquarePen 同上
app/shared/app-nav.tsx:148/167/185/202 - lucide 图标统一缺 aria-hidden="true"
app/styles.css:118+ - --shadow-lg: 0 28px 80px 阴影过强（AI 感来源之一），按 token 表收一档
app/styles.css 全文 - transition: background var(--transition) 等已显式列属性 ✓
app/styles.css 全文 - 未发现 transition: all ✓
app/styles.css 全文 - 未发现 user-scalable=no ✓（next.config 也未禁缩放）
```

非命中但建议加：

- `body { color-scheme: light dark; }` 让原生控件（select / scrollbar）跟主题
- 主输入框补 `enterkeyhint="send"`、聊天输入 `<textarea>` 加 `spellCheck` 按场景设
- cockpit 顶部 H1 加 `text-wrap: balance`

---

## 6. 执行步骤（5 个 phase，每个独立可验收，可中途停下）

### Phase 0 — 依赖与字体落地（无视觉变化，可秒回滚）

**做什么**

1. `npm i motion next-themes geist`
2. `layout.tsx`：用 `geist/font` 替换现在 `font-family: Geist, ...` 的字符串栈
3. `layout.tsx`：用 `<ThemeProvider attribute="data-theme" defaultTheme="system">` 包住 children；移除手写 `themeScript`（行为等价：`theme` cookie 改读 localStorage，刷新一次旧数据）
4. `base.css`：`html { font-size: 14px; line-height: 1.5; letter-spacing: -0.005em; }`

**Phase 0 验收**

- [ ] 任意页面打开 DevTools，`document.documentElement` 字号显示 14px
- [ ] 主题切换三态（浅/深/system）行为不变
- [ ] 字体回退失败时（断网）仍可阅读（Geist 已本地）
- [ ] `git diff` 包内文件 ≤ 3 个

### Phase 1 — Token 收敛与主色调切换（视觉变化最大，代码变化最少）

**做什么**

1. 在 `styles.css` 顶部新增第 4 套 `:root`（暂时叠在最下面），写入 §2.1/2.2 的 11 个新 token
2. 把 `--bg / --surface / --text / --accent` 等改成新值
3. 别名层：`--cx-bg: var(--bg)` 这种映射先保留，让旧 class 立刻继承新色
4. 全局阴影变量按表降档
5. 不删任何东西

**Phase 1 验收**

- [ ] 浏览器看 cockpit / chat / settings / knowledge 四个页面：**整体不再发黄，主色调为偏暖白（#fafaf9）**
- [ ] **切到暗色模式**：底色是石板蓝灰（带 hue 的活灰），不是"咖啡黑"；卡片明显比底亮一档（不靠阴影靠明度区分）；主观感觉"清新、不压抑"
- [ ] 当前激活的导航项 / 设置 tab：有可见的 **熔铜色 2px 左边条**（日夜模式都看得见）
- [ ] 所有按钮、输入、文字大小一致**变小一档**（14px 生效）
- [ ] 现有按钮 hover、点击行为无回归
- [ ] `git diff` 只动 `styles.css` 头部 token 区，不动其他

### Phase 2 — 思考动效 + 微交互细节

**做什么**

1. `chat-message.tsx:128` 替换为 `<span class="think-pulse" aria-hidden="true" />` + 文字 + 末尾箭头
2. `chat.css` 加入 §3.4 的关键帧
3. 给所有 lucide 装饰图标统一加 `aria-hidden="true"`（按 §5 清单）
4. 修 `outline: none` 两处，补 `:focus-visible` 替代
5. cockpit 指标数字加 `tabular-nums`

**Phase 2 验收**

- [ ] 发送一条新消息：看到 **熔铜色圆点呼吸**，停止时圆点变灰静态
- [ ] `prefers-reduced-motion` 开启时圆点静止
- [ ] 用 Tab 键遍历侧栏 / 主操作按钮，所有可聚焦元素都有 **可见 focus 环**
- [ ] cockpit 指标数字三列对齐（数字宽度一致）
- [ ] axe DevTools 扫 cockpit / chat / settings，无新增 a11y critical

### Phase 3 — CSS 拆分 + 死代码清理（机械活，零视觉变化）

**做什么**

1. 按 §4 拆 `app/styles/` 8 个文件，建 `index.css`
2. `layout.tsx` 从读 `styles.css` 改读 `app/styles/index.css`
3. 跑 §4 的 grep diff 流程，删除"定义未使用 token"和"未使用 class"
4. 别名 `--cx-* / --settings-*` sed 替换为主 token 名，删除别名定义

**Phase 3 验收**

- [ ] 单文件均 ≤ 1000 行
- [ ] 全站视觉**像素级无变化**（拿 Phase 2 末尾的浏览器截图逐页比对）
- [ ] `npm run build` 通过，无新增 warning
- [ ] `grep -r --include="*.tsx" "cx-\|settings-glow\|settings-node" app/` 应为空
- [ ] 现有测试 `npm test` 全绿（不存在 UI 测试也可，重点是后端不回归）

### Phase 4 — 组件级精修（refined minimalism 落地）

**做什么**

1. 按 §3.1–3.6 调整 cockpit 卡片 / chat 气泡 / 设置浮窗 的 padding、border、字重
2. 替换 cockpit 圆环和 todo tag 的多色调色板为四色克制版
3. Markdown 代码块浅色切 atom-one-light
4. cockpit 标题 `text-wrap: balance`

**Phase 4 验收**

- [ ] 与 Phase 1 末尾相比，**视觉差异明显但不"花"**——有人评价"更像产品，更不像 demo"
- [ ] 阴影只在浮窗一处出现，其他面靠 border 区分
- [ ] 强调色（铜橙）在任意一屏出现的位置 **不超过 3 处**
- [ ] 用户主观反馈：不再发黄、不再 AI 感

---

## 7. 新依赖（允许引入，但严格控制）

允许，但**必须满足**：①体积 ≤ 30KB gzip；②被两处以上使用；③不和现有依赖功能重复。

**计划引入**：

| 包 | 作用 | 体积 | 用在哪 |
|---|---|---|---|
| `motion`（即 `framer-motion` v11+，已改名） | 思考动效 + 浮窗进出 + tab 切换 fade | ~25KB gzip | §3.4 think-pulse、§3.5 设置浮窗、cockpit 数字 count-up（可选） |
| `next-themes` | 系统主题跟随 + SSR 闪烁修复 | ~3KB gzip | layout.tsx 的内联 themeScript 替换为标准方案 |
| `geist`（官方 next/font 包装） | Geist 字体真正本地化 + `font-display: swap` | 0（系统字体回退） | layout.tsx + base.css |

**明确不引入**：

- ❌ Tailwind / shadcn / Radix（与现有手写 CSS 体系冲突，迁移成本爆炸）
- ❌ daisyUI / Mantine / Chakra（同上，体积大）
- ❌ Lottie / Rive（思考动效用 CSS + motion 就够，不值得加几十 KB 资产管线）

依赖落地放在 **Phase 0**（执行 Phase 1 前的准备步），单独提一个 commit `chore(deps): add motion + next-themes + geist`，无视觉变化，方便回滚。

---

## 8. 不在本次范围内（防止 scope creep）

- ❌ 不动任何 `/api/*` 路由、`lib/agent/*`、`lib/knowledge/*`、`lib/db/*`
- ❌ 不动 `chat-page.tsx` 的状态机、SSE 流式逻辑
- ❌ 不重做任何组件的 React 结构（除 §3.4 一行替换 + §7 的 `next-themes` Provider 包装）
- ❌ 不改路由 / 不改 cookie 业务字段（`theme` cookie 由 next-themes 接管，行为等价）
- ❌ 不改 i18n
- ❌ 不重做 settings 浮窗布局（刚做完，沿用）
- ❌ 不引入 design system 文档站
- ❌ Tailwind / shadcn 类大型重构（见 §7）

---

## 8. 落地建议

- 用 Sonnet agent 跑 Phase 1 + Phase 2（小、可验收、视觉收益最高）
- Phase 3 是机械重构，开 worktree 隔离做，做完再合主分支
- Phase 4 视 Phase 1–3 体感再判断是否进，可能 Phase 1–2 完成后用户已经满意

每个 Phase 完成后，跑一遍：cockpit → /chat/new 发一条消息 → /config 看四个 tab → /knowledge 看文档列表 → 暗色模式切回浅色，**5 分钟人肉冒烟**。无回归再进下一 Phase。
