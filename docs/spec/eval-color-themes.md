# 颜色主题评估（只评估不实现）— 海蓝 / 抹茶绿 / 纸张黄 / Claude 橙 × 现代/经典 × 明暗

> 2026-07-09 / 状态：评估稿，不实现。回应"点9"。
> 背景：现有两风格「现代(linear)」「经典(default)」是**布局风格**（骨架/密度/浮起卡）；明暗是 next-themes 的 .dark。颜色主题是**第三个正交维度**。本文评估四个新配色如何接入，给推荐设计。

## 0. 结论先行

**颜色主题应是独立于"风格"和"明暗"的第三维**，用 `data-theme` 属性挂 `<html>`（与 `data-style`、`.dark` 三者正交，2风格 × 2明暗 × N配色 = 4N 组合，但代码量不是 4N——因为三者各自只覆盖自己那一层 token）。

**每个配色只需定义 1 个"种子色"+ 至多 1 个"中性染色量"**，其余全部从种子用 oklch 派生，不手写多套值。这样加一个配色 ≈ 加两行，且自动适配现代/经典/明暗。

## 1. 一个配色到底该改哪些 token？分三层

把 token 按"该不该被配色影响"分三层：

| 层 | token | 配色是否改 | 说明 |
|---|---|---|---|
| **A 品牌层** | `--primary` `--primary-foreground` `--ring` | **一定改** | 这是配色的核心。选中态、发送键、焦点环、链接强调都跟随 |
| **B 氛围层（中性染色）** | `--background` `--card` `--shell-canvas` `--sidebar` `--muted` `--accent` `--border` | **可选、极轻** | 让"纸张黄/抹茶绿"有氛围：给中性色掺入种子 hue 的极低彩度（chroma 0.004~0.012）。Claude 橙这类偏 accent 的可以完全不染 |
| **C 功能层** | `--tone-*`（红报警/绿正常…）`--destructive` `--chart-*` `--elevation-*` | **绝不改** | 状态语义色是功能不是装饰；报警红在任何配色下都必须是红。已独立于 --primary，架构正确 |

**四个配色按"要不要染中性"分两类**：
- **纯 accent 型**：Claude 橙、海蓝——只改 A 层品牌色，中性保持灰。克制、专业（Linear/Vercel 都这路子）。
- **氛围型**：纸张黄、抹茶绿——改 A 层 + B 层轻染（背景/纸面掺暖黄/柔绿的极低彩度）。名字本身承诺了"氛围"，只改主色会名不副实。

## 2. 推荐机制：种子色派生

每个配色定义为一个 `data-theme` 覆盖块，只写种子 + 派生：

```
[data-theme='ocean']  { --seed-h: 235; --seed-c: 0.14; --tint: 0; }      /* 海蓝, 纯accent不染 */
[data-theme='matcha'] { --seed-h: 150; --seed-c: 0.11; --tint: 0.008; }  /* 抹茶绿, 轻染 */
[data-theme='paper']  { --seed-h: 85;  --seed-c: 0.10; --tint: 0.010; }  /* 纸张黄, 轻染 */
[data-theme='claude'] { --seed-h: 55;  --seed-c: 0.15; --tint: 0; }      /* Claude橙, 纯accent */
```
然后 :root/.dark 里用种子派生（示意，实现时校准 L 值）：
```
--primary: oklch(0.55 var(--seed-c) var(--seed-h));           /* 亮 */
--primary-foreground: oklch(0.98 0 0);
--ring: oklch(0.55 calc(var(--seed-c) * 0.95) var(--seed-h));
/* B 层氛围染(仅 --tint>0 生效,几乎不可见的暖/冷) */
--background: oklch(1 var(--tint) var(--seed-h));
```
加第五个配色 = 再加一行种子。这是"改一处换全站"的终态。

## 3. 现代 vs 经典：配色落点不同（关键）

两风格的中性结构不同，配色的 B 层要分别落：

| | 经典(default) | 现代(linear) |
|---|---|---|
| 侧栏 | `--sidebar`（半透明灰蓝） | `transparent`（透出 `--shell-canvas`） |
| 背板 | 无（侧栏是浮起卡，主区平铺） | `--shell-canvas`（灰背板） |
| 主色落点 | 选中导航 bg-primary/10、发送键 | 同左 |

**推论**：
- **品牌层（A）**：两风格完全一致——都是 `--primary`，配色改一处两风格都跟随。**无需分风格。**
- **氛围层（B）**：落点不同——经典染 `--sidebar`（侧栏氛围）；现代染 `--shell-canvas`（背板氛围）。但因为两者本就是不同 token，配色块只要同时给这两个 token 掺 tint，各风格自动取用对的那个。**仍无需 `data-theme` 里区分风格**，只要 B 层把 --sidebar 和 --shell-canvas 都染即可。

结论：**配色维度不需要感知风格**。种子派生同时覆盖 --primary（两风格共用）和 --sidebar/--shell-canvas（两风格各取），一套配色块通吃现代+经典+明暗。这是三维正交能成立的前提，也说明当前 token 分层是对的。

## 4. 每个配色的具体建议

- **海蓝 ocean**：hue≈235，纯 accent。主色海蓝，中性保持灰。最接近现有默认蓝(262.9)，稳妥。
- **Claude 橙 claude**：hue≈55、chroma 高一点(0.15)显暖橙，纯 accent。注意橙色 L 要压低保证白字对比（primary 上放白字时 AA）。不染中性——橙染背景易显脏。
- **抹茶绿 matcha**：hue≈150，主色柔绿 + 背景/纸面掺极低彩度绿(tint 0.008)。暗色下 tint 减半（暗背景染色更易脏）。
- **纸张黄 paper**：hue≈85，主色芥末黄偏暗（黄色高 L 时白字对比差，primary 的 L 要压到 0.5 以下或改用深字），背景掺暖(tint 0.010)营造"纸感"。这是四个里最需要小心对比度的。

## 5. 落地时的护栏（真做时才管）
- 主色上的前景（--primary-foreground）要随种子 L 自动选黑/白：可用 `oklch(from var(--primary) …)` 判定，或每配色手定。黄/绿等高 L 主色配白字会挂 AA。
- tone/chart/destructive 绝不进配色块（§1 C 层）。
- 配色是第三维：设置页要嵌套（先选风格→再选明暗→再选配色），或三个独立分段控件。UI 上建议配色用色板圆点(swatch)而非文字按钮。
- `data-theme` 也要进 no-flash 脚本（和 data-style 一起 paint 前写）。

## 6. 工作量预估（供排期）
- 机制（种子派生 + data-theme 挂载 + no-flash + 设置 UI）：中等，一次性。
- 每个配色：小（种子块 + 校准 L/对比度）。
- 前置依赖：先清"最后一公里"硬编码色（见 audit-style-abstraction.md），否则配色换不干净。
