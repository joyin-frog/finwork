# Linear 外观风格（一期：外壳布局反转 + token 覆盖 + 风格切换）Spec

> 版本 v1.1 / 2026-07-08（v1.0 经计划审查修订：typecheck 命令、标题栏纳入范围、暗色 ring、四周均匀缝、radius 走 token、layer 机制说明）
> 状态：已批准（计划审查通过，阻塞项已修订）
> 依赖：无（使用 WP8 预埋的 `data-style` 挂载区与 Surface 底座）
> 架构事实（写给全新上下文的子代理）：
> - Next.js App Router + Tailwind v4。全部设计 token 在 `app/globals.css` 的 `:root` / `.dark` 中以 oklch 定义，`@theme inline` 映射为 Tailwind 工具类。
> - 明暗主题由 next-themes 管理（`attribute="class"`，即 `<html>` 上加/去 `.dark`），见 `app/shared/theme-provider.tsx`。
> - 多风格挂载机制已预埋：`app/layout.tsx:55` 的 `<html data-style="default">` + `app/globals.css` 文件末尾的「风格覆盖挂载区」注释块（内含书写规则，务必先读）。目前只有 default 一种风格、零覆盖。
> - 应用外壳：`app/shared/app-shell.tsx` 最外层 `div.bg-background` 竖排 WindowTitleBar（仅 Windows 渲染）+ 一行（侧栏 AppNav + `<main class="... bg-background">`）。**当前布局是"侧栏浮起卡、主区平铺全出血"**：侧栏展开态在 `app/shared/app-nav.tsx:220` 用 `surfaceVariants({ level:"panel", edge:"hairline", shape:"panel" }) + "bg-sidebar m-1"` 做成浮起圆角卡。
> - `--elevation-inset` token（globals.css:154/180）与 `components/ui/surface.tsx` 的 `inset` 变体是休眠基建，注释明确写着"主内容大卡片浮在侧栏背板上"——正是本任务要实现的布局，目前仅 `app/dev/theme/theme-playground.tsx` 演示引用。
> - 外观设置 UI 在 `app/config/appearance/appearance-settings.tsx`（目前只有明暗三按钮）。
> - `<html>` 已带 `suppressHydrationWarning`（next-themes 需要），data-style 的首帧脚本可复用这一豁免。

## 0. 目标与非目标

**目标**：新增第二套外观风格「Linear」，用户可在设置中切换并持久化。Linear 风格 = 布局反转（侧栏变平铺透明 chrome、主内容变四周留缝的浮起圆角卡）+ 色彩/圆角 token 覆盖（灰/近黑背板、薰衣草蓝主色、发丝线描边）。默认风格像素零变化。

**非目标（本期不做，已知并接受）**：
- 顶部标签页导航——用户已拍板不做（2026-07-08），顶部只留背板缝隙即可。
- 状态 token 阶梯（hover/active 步进）——现有 `hover:bg-accent` 等语义类会自动跟随 `--accent` 覆盖，够用。
- 动效 token / 图表 token——由先行的「设计缺口修复批」落地（同轮另一工作包），本 spec 不重复动；Linear 式加深负字距不做。
- tone 状态色系统不动（财务语义色是功能，不随风格砍）。
- 移动端/响应式适配不动。

## 1. 成功标准

- [ ] **默认风格像素零变化**：不切风格时，cockpit / chat / agents 三页在亮、暗两模式下与改动前视觉一致（用 preview 工具截图对比；token 层面 `--shell-canvas` 默认值 = `var(--background)`，语义类只加不改样式）。
- [ ] **Linear 亮色**：`<html data-style="linear">` 无 `.dark` 时——窗口背板为浅灰；侧栏透明平铺无边框无阴影无圆角；`<main>` 为白色浮起卡，四周 8px 均匀缝隙、圆角 14px（`--radius-xl`）、1px 发丝描边；主色为薰衣草蓝 #5e6ad2（选中导航项、发送按钮等自动跟随）。截图验证。
- [ ] **Linear 暗色**：`html.dark[data-style="linear"]`——背板近黑 #010102，主卡 #0f1011，发丝线 #23252a，文字 #f7f8f8/#8a8f98。截图验证。
- [ ] **切换与持久化**：设置→外观新增「界面风格」两按钮（默认/Linear），点击立即生效；刷新页面后风格保持（localStorage）；首帧无风格闪烁（head 内联脚本在 paint 前写好 dataset）。
- [ ] **明暗 × 风格正交**：2×2 四个组合均可用，互切不串。
- [ ] 控制台无 hydration 报错（`suppressHydrationWarning` 已在 html 上）。
- [ ] 既有测试套件跑绿（命令见 §4）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/globals.css` | 修改 | 新增 `--shell-canvas` token；风格挂载区内追加 `[data-style='linear']` 与 `html.dark[data-style='linear']` 覆盖块（token + `.app-side`/`.app-main` 布局规则） |
| `app/shared/app-shell.tsx` | 修改 | 最外层容器 `bg-background` → `bg-[var(--shell-canvas)]`；`<main>` 追加语义类 `app-main`（保留现有全部类） |
| `app/shared/app-nav.tsx` | 修改 | 侧栏根容器追加语义类 `app-side`（保留现有全部类，含 collapsed 分支） |
| `app/shared/window-controls.tsx` | 修改 | WindowTitleBar 根元素（:113，带 `bg-background border-b`）追加语义类 `app-titlebar`，linear 下改走背板色 |
| `app/layout.tsx` | 修改 | `<head>` 加 no-flash 内联脚本：paint 前读 localStorage `app-style` 写 `documentElement.dataset.style`；SSR 属性保持 `data-style="default"` |
| `app/config/appearance/appearance-settings.tsx` | 修改 | 新增「界面风格」SettingsSection：默认/Linear 两按钮，写 localStorage + 即时更新 dataset |
| `docs/spec/audit-linear-style.md` | 新增 | implementer 产出 |

## 3. 实施步骤

1. **`--shell-canvas` token**（globals.css `:root` Surface 语义区，约 :103 附近）：
   ```css
   --shell-canvas: var(--background); /* 窗口背板色;默认风格与页面底同色(不可见),linear 风格下变灰/近黑背板 */
   ```
   不需要 `.dark` 覆盖（var 引用自动跟随）。不需要进 `@theme inline`（仅两处消费，用任意值语法）。

2. **外壳挂语义类**：
   - `app-shell.tsx:113` `bg-background` → `bg-[var(--shell-canvas)]`。
   - `app-shell.tsx:126` `<main>` className 追加 `app-main`。
   - `app-nav.tsx` 侧栏根容器（:219-220 那个 cn 所在元素）className 追加 `app-side`（放在 cn 首参，展开/收起两态都带）。
   - 语义类本体在默认风格下**不定义任何样式**（零覆盖原则，与挂载区注释一致）。

3. **globals.css 风格挂载区追加覆盖块**（严格按挂载区注释规则：暗色用 `html.dark[data-style='linear']` 组合选择器；注释内禁止出现 CSS 注释结束序列）：

   ```css
   /* ── Linear 风格（亮）── 布局反转:侧栏平铺、主内容浮起卡 */
   [data-style='linear'] {
     --shell-canvas: oklch(0.962 0.003 260);      /* 浅灰背板 */
     --primary: oklch(0.545 0.145 277);           /* 薰衣草蓝 ≈ #5e6ad2 */
     --primary-foreground: oklch(0.985 0 0);
     --ring: oklch(0.54 0.14 277);                /* ≈ #5e69d1 */
     --sidebar: transparent;                       /* 侧栏融入背板 */
     --radius: 0.625rem;                           /* 派生 md=8px(按钮)/xl=14px,贴近 Linear 8/12 谱 */
     --border: oklch(0.90 0.004 260);              /* 发丝线略实,浮起卡靠描边而非阴影 */
   }
   [data-style='linear'] .app-side {
     background: transparent;
     border-color: transparent;
     box-shadow: none;
     border-radius: 0;
     margin: 0;
   }
   [data-style='linear'] .app-main {
     margin: 0.5rem;                    /* 四周均匀留缝:侧栏与卡之间也有 8px 缝(贴近 Linear 实物),且侧栏收起时左缘不产生不对称缺口 */
     border-radius: var(--radius-xl);   /* 0.625rem × 1.4 = 14px,走 token 不写死 */
     border: 1px solid var(--border);
     background: var(--background);
     box-shadow: var(--elevation-1);    /* 有意不用 --elevation-inset:侧栏已透明,无"左墙"可投;inset 留给默认风格的休眠语义 */
   }
   [data-style='linear'] .app-titlebar {
     background: var(--shell-canvas);   /* Windows 标题栏落背板层;默认风格不受影响 */
   }
   /* ── Linear 风格（暗）── 必须组合选择器压过 .dark */
   html.dark[data-style='linear'] {
     --shell-canvas: oklch(0.13 0.003 260);        /* ≈ #010102 近黑背板(oklch 换算值实施时以肉眼校准为准) */
     --background: oklch(0.178 0.002 260);         /* ≈ #0f1011 主卡面 */
     --card: oklch(0.205 0.002 260);               /* ≈ #141516 内部卡片抬一档 */
     --popover: oklch(0.225 0.002 260);            /* ≈ #18191a */
     --foreground: oklch(0.975 0.001 260);         /* ≈ #f7f8f8 */
     --muted-foreground: oklch(0.635 0.005 260);   /* ≈ #8a8f98 */
     --border: oklch(0.26 0.003 260);              /* ≈ #23252a hairline */
     --input: oklch(0.26 0.003 260);
     --primary: oklch(0.62 0.15 277);              /* 暗色主色略提亮 */
     --ring: oklch(0.60 0.14 277);                 /* 焦点环跟随薰衣草蓝;不覆盖会漏成 .dark 的灰环 */
     --sidebar: transparent;
     /* 暗色深度弃投影、靠描边:elevation 大幅减弱 */
     --elevation-1: 0 0 0 1px oklch(1 0 0 / 4%);
     --elevation-2: 0 4px 12px -4px oklch(0 0 0 / 50%);
     --elevation-3: 0 12px 32px -8px oklch(0 0 0 / 60%);
   }
   html.dark[data-style='linear'] .app-main {
     box-shadow: none;                              /* 暗色只靠 1px 描边分层 */
   }
   ```
   以上 oklch 数值是**起点**，implementer 须启动 dev server 用 preview 工具肉眼校准（尤其近黑背板与主卡的层差、亮色灰背板的浓度），校准后的最终值即为交付值——像素级微调是预期内偏差，不算脱离计划。

4. **layout.tsx no-flash 脚本**（放 `<head>` 内、highlight style 注入之后）：
   ```tsx
   <script
     dangerouslySetInnerHTML={{
       __html: `try{var s=localStorage.getItem("app-style");if(s==="linear")document.documentElement.dataset.style=s}catch(e){}`,
     }}
   />
   ```
   白名单校验（只认 "linear"），SSR 属性保持 `data-style="default"` 不动。

5. **设置 UI**（appearance-settings.tsx）：仿照现有 THEMES 三按钮的既有模式，新增：
   ```tsx
   const STYLES = [
     { value: "default", label: "默认" },
     { value: "linear", label: "Linear" },
   ] as const;
   ```
   独立 `SettingsSection`（title="界面风格"，description 说明与明暗模式相互独立）。当前值：`useState` + `useEffect` 挂载后读 `document.documentElement.dataset.style ?? "default"`（避免 SSR 读 document）。点击：写 `localStorage.setItem("app-style", v)` + 更新 `document.documentElement.dataset.style`；选 "default" 时 `localStorage.removeItem` 并把 dataset 复位为 "default"。

6. **自查四象限**：preview 工具起 dev server，2 风格 × 2 明暗 截图 cockpit、chat 两页，确认成功标准逐条成立；特别检查：滚动条在圆角主卡内的形态、侧栏 collapsed 态在 linear 下不出怪相、`:root[data-platform="windows"]` 顶栏规则不受影响（代码审视即可，mac 上无法实跑 Windows）。

## 4. 测试与验证方式

```bash
# 单测/集成（本仓库标准跑绿姿势）：
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

# 类型与 lint（package.json 实际脚本）
npm run lint
npm run typecheck
```

- 视觉验证用 Claude preview 工具（preview_start / preview_screenshot / preview_resize colorScheme dark），不要用 Bash 起 server。
- 需要新增的测试：无强制。若 e2e 套件中存在断言 app-shell 类名/截图基线的用例，先跑该文件确认不破。
- 明确不需要跑的部分：python 侧、金蝶/凭证相关 e2e 与本任务无关。

## 5. 风险与开放问题

- **hydration**：内联脚本在 hydration 前改 `data-style`，与 SSR 值不一致——`<html>` 已有 `suppressHydrationWarning`，预期无警告；实施后看控制台确认。
- **特异性**：`.app-side` 覆盖压过 `surfaceVariants` 生成的工具类的真正机制是 **layer**——Tailwind v4 工具类都在 `@layer utilities`，风格挂载区的规则是无 layer 的普通 CSS，按 CSS 规范无 layer 规则无条件胜过任意 `@layer` 规则（与特异性无关）。因此覆盖非常稳；唯一能反杀的是工具类带 `!important`（相关属性上没有）。实施时目视确认即可。
- **主卡内 `bg-background` 页面**（7 处，chat/knowledge/preview 等）：linear 暗色下 `--background` 被重定义为主卡面色，这些用法会与主卡同色——正是期望行为；但需抽查 chat 页无「白块/黑块」违和。
- **WindowTitleBar（Windows）**：其根元素显式带 `bg-background`（window-controls.tsx:113），linear 下不处理会比背板亮一截——已纳入改动（`app-titlebar` 类 + 覆盖规则）。mac 上无法实跑 Windows 分支，实施后代码走查确认，遗留观感问题记入 audit。
- **`--background` 连锁**：暗色 linear 把 `--background` 重定义为主卡面色后，`body.bg-background`（layout.tsx，视觉上被外壳全盖住）与 skip-link 的 `focus:bg-background`（app-shell.tsx:119，获得焦点时呈卡面色，可读性无碍）会跟随——已知且接受，不另做处理。
- **`--radius` 全局变小**（0.7→0.625rem）会让 linear 风格下所有控件圆角略收紧——这是有意的风格差异，不是回归。
- 亮色 Linear 的 `--border` 加实与 `--muted`/`--accent` 未覆盖的组合是否和谐，靠肉眼校准环节兜底。
