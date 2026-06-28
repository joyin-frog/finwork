# 总览页重设计 Spec：色彩语义化、布局反转、卡片活力升级

**版本**: v1.0
**日期**: 2026-06-07
**作者**: UI/UX review
**状态**: 待执行
**前置**: 与 `spec-ui-polish.md`（按钮/token 收口）、`spec-ui-motion.md`（入场动效）配合
**范围**: `app/cockpit/page.tsx` + `app/styles/overview.css` + `app/styles/cockpit.css` 相关段

---

## 0. 用户反馈与根因分析

| 反馈 | 根因 | 文件:行 |
|---|---|---|
| "已完成/已启用的圆点是黑色，不够明显" | `.metric-card em::before { background: currentColor }`，但 JSX `<em>{delta}</em>` 没有加 `metric-up/metric-neutral` 类。死代码 + 默认继承 `--text` 黑色 | `cockpit.css:120-138`、`cockpit/page.tsx:76` |
| "快捷操作、最近活动都是黑色，颜色单一" | 全页只有 quick action 的左侧 lucide 图标用了 `var(--accent)`，其余文字/卡片/标签全是 `--text` 黑 + `--surface` 白 | `overview.css:30-132`、`cockpit.css:88-138` |
| "卡片很丑" | 通用 `border: 1px var(--border) + background: var(--surface) + radius: 8px`，无层级、无识别、无身份 | `cockpit.css:80-86` |
| "最近活动占比太大，放右侧" | `grid-template-columns: 1.6fr 1fr`，主左副右 | `overview.css:8-12` |
| "更活泼点" | 当前是"冷淡 dashboard"风格，metric card 数字大字 + 灰小字，缺少色彩节奏与情感锚点 | 整体 |

---

## 1. 设计原则

1. **色彩有语义**：每张 metric / quick action / 状态标签都被赋予明确的语义色（蓝=系统/工具、绿=完成/健康、紫=知识、橙=活跃/技能、红=错误）。不是为了花哨。
2. **布局反转**：主区（左 + 中）= 快捷操作 + 资金/系统/知识三栏概览。右侧细窄列 = 最近对话（次要信息，可滚动）。
3. **卡片有身份**：每个模块的卡片自带"色带"或"图标徽章"，一眼可分辨用途，而不是 4 张一模一样的白板。
4. **数字是主角**：metric 大数字保持 26px display，但加入"小图标 + 色块徽章"，让首屏 4 张卡有色彩节奏。
5. **暗色等价**：所有 wash/accent 色在暗色下用低饱和度变体；不是直接用透明度叠加。
6. **不喧宾夺主**：色彩点缀，主体内容文本仍用 `--text`/`--text-2`，避免彩虹页。

---

## 2. 新布局

```
┌─ codex-content ─────────────────────────────────────────────────────────┐
│ ┌─ codex-topbar ───────────────────────────────────────────────────────┐│
│ │  总览                                              今天 6月7日   [刷新]││
│ └──────────────────────────────────────────────────────────────────────┘│
│ ┌─ overview-body ──────────────────────────────────────────────────────┐│
│ │ ┌─ metric-strip (4 cards) ───────────────────────────────────────┐  ││
│ │ │ [🔧 工具] [💬 对话] [📚 知识库] [⚡ 技能]                       │  ││
│ │ │  蓝 wash    绿 wash    紫 wash      橙 wash                      │  ││
│ │ └────────────────────────────────────────────────────────────────┘  ││
│ │                                                                      ││
│ │ ┌─ overview-grid (3-col: 主+主+副) ─────────────────────────────┐  ││
│ │ │ ┌─ main-col (1fr) ────┐ ┌─ main-col (1fr) ──┐ ┌─ side (0.7) ┐ │  ││
│ │ │ │  快捷操作            │ │ 系统状态           │ │ 最近对话    │ │  ││
│ │ │ │  ──────              │ │ ──────             │ │ ──────      │ │  ││
│ │ │ │ [报销校验 ⓘ]         │ │ • 平均轮次 3.2      │ │ ▸ 报销-3条  │ │  ││
│ │ │ │ [薪税计算 ⓘ]         │ │ • 最常用工具       │ │ ▸ 薪税-5条  │ │  ││
│ │ │ │ [导出金蝶 ⓘ]         │ │   - run_python (8) │ │ ▸ 分析-2条  │ │  ││
│ │ │ │ [财务分析 ⓘ]         │ │   - knowledge (5)  │ │ …           │ │  ││
│ │ │ │                      │ │                    │ │             │ │  ││
│ │ │ │                      │ │ 知识库            │ │             │ │  ││
│ │ │ │                      │ │ ──────             │ │             │ │  ││
│ │ │ │                      │ │ 24 文档 · 132 块   │ │             │ │  ││
│ │ │ │                      │ │ 最近: 制度.pdf     │ │             │ │  ││
│ │ │ │                      │ │ [管理 →]           │ │             │ │  ││
│ │ │ └──────────────────────┘ └────────────────────┘ └─────────────┘ │  ││
│ │ └──────────────────────────────────────────────────────────────────┘ ││
│ └──────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

CSS：

```css
.overview-grid {
  display: grid;
  grid-template-columns:
    minmax(280px, 1fr)    /* 快捷操作 */
    minmax(280px, 1fr)    /* 系统状态 + 知识库（堆叠） */
    minmax(240px, 0.7fr); /* 最近对话（细列） */
  gap: 20px;
  align-items: start;
}

/* 窄屏 (< 1100px) → 两栏，最近对话沉到底部 */
@media (max-width: 1100px) {
  .overview-grid {
    grid-template-columns: 1fr 1fr;
  }
  .overview-side-recent {
    grid-column: 1 / -1;
    max-height: 320px;
    overflow: auto;
  }
}

/* 极窄 (< 720px) → 单栏 */
@media (max-width: 720px) {
  .overview-grid { grid-template-columns: 1fr; }
}
```

"最近对话"栏内**最多展示 8 行**，超过滚动；高度上限 `max-height: 540px`，避免占满视口。

---

## 3. Metric Card：4 种语义色身份

### 3.1 新增 token

`app/styles/tokens.css` 加：

```css
:root {
  /* metric 语义色（4 张卡专用，与全局 success/warning 分开） */
  --metric-blue: #3183d8;
  --metric-blue-wash: rgba(49, 131, 216, 0.10);
  --metric-blue-soft: rgba(49, 131, 216, 0.18);

  --metric-green: #16a34a;
  --metric-green-wash: rgba(22, 163, 74, 0.10);
  --metric-green-soft: rgba(22, 163, 74, 0.18);

  --metric-purple: #7c6adf;
  --metric-purple-wash: rgba(124, 106, 223, 0.10);
  --metric-purple-soft: rgba(124, 106, 223, 0.18);

  --metric-orange: #d97706;
  --metric-orange-wash: rgba(217, 119, 6, 0.10);
  --metric-orange-soft: rgba(217, 119, 6, 0.18);
}

[data-theme="dark"] {
  --metric-blue: #6aa9eb;
  --metric-blue-wash: rgba(106, 169, 235, 0.14);
  --metric-blue-soft: rgba(106, 169, 235, 0.24);

  --metric-green: #4ade80;
  --metric-green-wash: rgba(74, 222, 128, 0.12);
  --metric-green-soft: rgba(74, 222, 128, 0.22);

  --metric-purple: #a896f0;
  --metric-purple-wash: rgba(168, 150, 240, 0.14);
  --metric-purple-soft: rgba(168, 150, 240, 0.24);

  --metric-orange: #fbbf24;
  --metric-orange-wash: rgba(251, 191, 36, 0.12);
  --metric-orange-soft: rgba(251, 191, 36, 0.22);
}
```

### 3.2 Metric card 视觉重做

```css
.metric-card {
  position: relative;
  display: grid;
  gap: 10px;
  min-height: 124px;
  padding: 18px 20px;
  border-radius: var(--radius-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
  /* 不再用通用 .metric-card,.cockpit-panel,.settings-card 共享样式块 */
}

/* 左侧 3px 色条 — 一眼分辨身份 */
.metric-card::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  background: var(--metric-accent, var(--metric-blue));
  border-radius: var(--radius-lg) 0 0 var(--radius-lg);
}

/* 图标徽章 */
.metric-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}

.metric-card-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--metric-wash, var(--metric-blue-wash));
  color: var(--metric-accent, var(--metric-blue));
}

.metric-card-value {
  font-size: var(--font-display);
  font-weight: 600;
  color: var(--text);
  line-height: 1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.metric-card-delta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--metric-accent, var(--metric-blue));
  background: var(--metric-wash, var(--metric-blue-wash));
  padding: 3px 10px;
  border-radius: 999px;
  width: fit-content;
}

.metric-card-delta::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--metric-accent, var(--metric-blue));
  box-shadow: 0 0 0 3px var(--metric-soft, var(--metric-blue-soft));
}

/* 4 种身份变体 */
.metric-card[data-variant="tools"]   { --metric-accent: var(--metric-blue);   --metric-wash: var(--metric-blue-wash);   --metric-soft: var(--metric-blue-soft); }
.metric-card[data-variant="chat"]    { --metric-accent: var(--metric-green);  --metric-wash: var(--metric-green-wash);  --metric-soft: var(--metric-green-soft); }
.metric-card[data-variant="kb"]      { --metric-accent: var(--metric-purple); --metric-wash: var(--metric-purple-wash); --metric-soft: var(--metric-purple-soft); }
.metric-card[data-variant="skills"]  { --metric-accent: var(--metric-orange); --metric-wash: var(--metric-orange-wash); --metric-soft: var(--metric-orange-soft); }
```

### 3.3 MetricCard 组件改造

```tsx
function MetricCard({
  icon: Icon, label, value, delta, variant,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null | undefined;
  delta: string;
  variant: "tools" | "chat" | "kb" | "skills";
}) {
  return (
    <article className="metric-card" data-variant={variant}>
      <div className="metric-card-header">
        <span className="metric-card-badge"><Icon size={16} aria-hidden="true" /></span>
        <span>{label}</span>
      </div>
      <strong className="metric-card-value">
        {value != null ? <AnimatedNumber value={value} /> : "--"}
      </strong>
      <em className="metric-card-delta">{delta}</em>
    </article>
  );
}
```

调用：

```tsx
<MetricCard icon={Wrench}         label="工具执行"     value={...} delta="今日"     variant="tools" />
<MetricCard icon={MessageSquare}  label="今日对话"     value={...} delta="已完成"   variant="chat" />
<MetricCard icon={BookOpen}       label="知识库文档"   value={...} delta={`${chunks} 个分块`} variant="kb" />
<MetricCard icon={Boxes}          label="活跃技能"     value={...} delta="已启用"   variant="skills" />
```

效果：
- 4 张卡左侧 3px 色条蓝/绿/紫/橙
- 顶部一个 28×28 的彩色图标徽章（wash 背景 + accent 描边色）
- 底部 delta 文字变成 pill chip，圆点用语义色 + 外发光圈（解决"圆点黑色"问题）

---

## 4. 快捷操作：从灰按钮变彩色 tile

### 4.1 视觉重做

```css
.quick-action-list {
  display: grid;
  gap: 10px;
}

.quick-action-tile {
  position: relative;
  display: grid;
  grid-template-columns: 40px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
  transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
}

.quick-action-tile:hover {
  transform: translateY(-1px);
  border-color: var(--metric-accent, var(--metric-blue));
  box-shadow: 0 4px 16px var(--metric-wash, var(--metric-blue-wash));
}

.quick-action-tile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--metric-accent);
}

.quick-action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--metric-wash, var(--metric-blue-wash));
  color: var(--metric-accent, var(--metric-blue));
  flex-shrink: 0;
}

.quick-action-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.quick-action-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.quick-action-desc {
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-action-chevron {
  color: var(--text-3);
  transition: transform 150ms ease, color 150ms ease;
}

.quick-action-tile:hover .quick-action-chevron {
  color: var(--metric-accent);
  transform: translateX(2px);
}

/* 4 种身份变体（与 metric 对齐） */
.quick-action-tile[data-variant="reimburse"] { --metric-accent: var(--metric-blue);   --metric-wash: var(--metric-blue-wash); }
.quick-action-tile[data-variant="payroll"]   { --metric-accent: var(--metric-green);  --metric-wash: var(--metric-green-wash); }
.quick-action-tile[data-variant="kingdee"]   { --metric-accent: var(--metric-purple); --metric-wash: var(--metric-purple-wash); }
.quick-action-tile[data-variant="analysis"]  { --metric-accent: var(--metric-orange); --metric-wash: var(--metric-orange-wash); }
```

### 4.2 JSX

```tsx
const quickActions = [
  { variant: "reimburse", icon: ClipboardList, title: "报销校验", desc: "票据合规、金额核对", href: "/chat/new?skill=reimbursement-check&prompt=..." },
  { variant: "payroll",   icon: Calculator,    title: "薪税计算", desc: "工资、个税、社保", href: "/chat/new?skill=payroll-calc&prompt=..." },
  { variant: "kingdee",   icon: Upload,        title: "导出金蝶草稿", desc: "凭证生成、借贷校验", href: "/chat/new?skill=kingdee-draft&prompt=..." },
  { variant: "analysis",  icon: TrendingUp,    title: "财务分析", desc: "趋势、对比、归因", href: "/chat/new?skill=finance-analysis&prompt=..." },
] as const;

<article className="cockpit-panel">
  <h2 className="overview-section-title">快捷操作</h2>
  <div className="quick-action-list">
    {quickActions.map((a) => (
      <Link key={a.variant} href={a.href} className="quick-action-tile" data-variant={a.variant}>
        <span className="quick-action-icon"><a.icon size={20} aria-hidden="true" /></span>
        <span className="quick-action-body">
          <span className="quick-action-title">{a.title}</span>
          <span className="quick-action-desc">{a.desc}</span>
        </span>
        <ChevronRight size={16} className="quick-action-chevron" aria-hidden="true" />
      </Link>
    ))}
  </div>
</article>
```

效果：
- 40×40 彩色图标徽章
- 标题 + 描述两行（"报销校验 / 票据合规、金额核对"）—— 补足当前 1 行的信息密度不足
- hover 抬升 + 同色光晕 + chevron 右移
- 4 个 tile 蓝/绿/紫/橙呼应顶部 metric

---

## 5. 中栏：系统状态 + 知识库（堆叠）

把当前散落的"资金概览"（其实是工具调用统计）改名为「系统状态」，与"知识库"卡上下堆叠在中栏。

### 5.1 系统状态卡

```tsx
<article className="cockpit-panel cockpit-panel-system">
  <header className="cockpit-panel-head">
    <span className="cockpit-panel-icon" data-variant="tools">
      <Activity size={16} aria-hidden="true" />
    </span>
    <h2 className="cockpit-panel-title">系统状态</h2>
  </header>

  <dl className="stat-list">
    <div className="stat-row">
      <dt>平均轮次</dt>
      <dd><strong>{data?.treasury.avgTurns.toFixed(1) ?? "--"}</strong> 轮 / 对话</dd>
    </div>
    <div className="stat-row">
      <dt>累计对话</dt>
      <dd><strong>{data?.treasury.totalConversations ?? "--"}</strong> 个</dd>
    </div>
  </dl>

  <div className="stat-divider" />

  <h3 className="stat-subtitle">最常用工具</h3>
  <ul className="tool-rank-list">
    {topTools3.map((t, i) => (
      <li key={t.toolName} className="tool-rank-row">
        <span className="tool-rank-index">{i + 1}</span>
        <code className="tool-rank-name">{t.toolName}</code>
        <span className="tool-rank-bar">
          <span className="tool-rank-fill" style={{ width: `${(t.callCount / topTools3[0].callCount) * 100}%` }} />
        </span>
        <span className="tool-rank-count">{t.callCount}</span>
      </li>
    ))}
  </ul>
</article>
```

CSS 关键：

```css
.cockpit-panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.cockpit-panel-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--metric-wash, var(--metric-blue-wash));
  color: var(--metric-accent, var(--metric-blue));
}

.cockpit-panel-icon[data-variant="tools"]   { --metric-accent: var(--metric-blue);   --metric-wash: var(--metric-blue-wash); }
.cockpit-panel-icon[data-variant="kb"]      { --metric-accent: var(--metric-purple); --metric-wash: var(--metric-purple-wash); }

.cockpit-panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  text-transform: none;        /* 替代当前 uppercase 12px 灰色 */
  letter-spacing: -0.005em;
}

.stat-list { display: grid; gap: 8px; margin: 0; }
.stat-row {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 13px;
}
.stat-row dt { color: var(--text-2); }
.stat-row dd { margin: 0; color: var(--text); }
.stat-row strong { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }

.stat-divider { height: 1px; background: var(--border); margin: 14px 0; }

.stat-subtitle {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.tool-rank-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.tool-rank-row {
  display: grid;
  grid-template-columns: 18px 1fr 60px 28px;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.tool-rank-index {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px;
  border-radius: 999px;
  background: var(--metric-blue-wash);
  color: var(--metric-blue);
  font-weight: 700;
  font-size: 10px;
}
.tool-rank-name {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-rank-bar {
  display: block;
  height: 6px;
  background: var(--surface-2);
  border-radius: 999px;
  overflow: hidden;
}
.tool-rank-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--metric-blue), var(--metric-purple));
  border-radius: 999px;
  transition: width 600ms cubic-bezier(0.16, 1, 0.3, 1);
}
.tool-rank-count {
  font-size: 11px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
```

效果：把当前丑陋的 `tool-badge` 灰色 chip 换成"排名 + 工具名 + 比例条 + 调用数"4 列结构。比例条用蓝→紫渐变，活泼且直观。

### 5.2 知识库卡

紫色身份：

```tsx
<article className="cockpit-panel">
  <header className="cockpit-panel-head">
    <span className="cockpit-panel-icon" data-variant="kb"><BookOpen size={16} /></span>
    <h2 className="cockpit-panel-title">知识库</h2>
  </header>
  <div className="kb-summary">
    <span className="kb-stat">
      <strong>{data?.knowledge.totalDocs ?? "--"}</strong>
      <em>文档</em>
    </span>
    <span className="kb-divider" />
    <span className="kb-stat">
      <strong>{data?.knowledge.totalChunks ?? "--"}</strong>
      <em>分块</em>
    </span>
  </div>
  {data?.knowledge.latestIngestion && (
    <p className="kb-latest">
      <span className="kb-latest-dot" />
      最近: <strong>{data.knowledge.latestIngestion.title}</strong>
      <span className="kb-latest-time">{timeAgo(new Date(data.knowledge.latestIngestion.ingestedAt).getTime())}</span>
    </p>
  )}
  <Link href="/knowledge" className="cockpit-panel-link">管理知识库 <ChevronRight size={14} /></Link>
</article>
```

CSS 关键：

```css
.kb-summary {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 12px;
}
.kb-stat { display: inline-flex; align-items: baseline; gap: 6px; }
.kb-stat strong {
  font-size: 22px;
  font-weight: 600;
  color: var(--metric-purple);
  font-variant-numeric: tabular-nums;
}
.kb-stat em { font-style: normal; font-size: 12px; color: var(--text-2); }
.kb-divider {
  width: 1px; height: 16px;
  background: var(--border);
}

.kb-latest {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-2);
}
.kb-latest strong {
  color: var(--text);
  font-weight: 500;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-latest-dot {
  width: 6px; height: 6px;
  border-radius: 999px;
  background: var(--metric-purple);
  box-shadow: 0 0 0 3px var(--metric-purple-soft);
  flex-shrink: 0;
}
.kb-latest-time {
  margin-left: auto;
  color: var(--text-3);
  font-size: 11px;
}

.cockpit-panel-link {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 13px; font-weight: 500;
  color: var(--metric-purple);
  text-decoration: none;
}
.cockpit-panel-link:hover { color: var(--metric-purple); text-decoration: underline; }
```

---

## 6. 最近对话：从主区降为右侧细列

### 6.1 视觉重做

```css
.overview-side-recent {
  border-radius: var(--radius-lg);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 18px 16px;
  max-height: 540px;
  display: flex;
  flex-direction: column;
}

.overview-side-recent .cockpit-panel-head {
  margin-bottom: 12px;
}

.activity-feed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  flex: 1;
  margin: 0 -4px;
  padding: 0 4px;
}

.activity-row {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: transparent;
  border: none;
  border-left: none;
  text-decoration: none;
  color: inherit;
  transition: background 120ms ease;
  min-height: auto;
}

.activity-row::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--metric-accent, var(--metric-blue));
  box-shadow: 0 0 0 3px var(--metric-wash, var(--metric-blue-wash));
}

.activity-row:hover {
  background: var(--surface-2);
  border-color: transparent;
}

.activity-row-left {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.activity-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-meta {
  font-size: 11px;
  color: var(--text-3);
}

.activity-meta code {
  font-family: var(--font-mono);
  font-size: 10px;
  background: transparent;
  padding: 0;
  color: var(--text-2);
}

.activity-time {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
```

### 6.2 按"最近用过的工具"分配身份色

```tsx
function activityVariant(toolName: string | null): "tools" | "chat" | "kb" | "skills" {
  if (!toolName) return "chat";
  if (toolName.includes("knowledge")) return "kb";
  if (toolName.includes("python") || toolName.includes("kingdee")) return "tools";
  if (toolName.includes("memory") || toolName.includes("skill")) return "skills";
  return "chat";
}

<Link
  href={`/chat/recent?id=${entry.conversationId}`}
  className="activity-row"
  data-variant={activityVariant(entry.lastToolName)}
  style={{
    "--metric-accent": `var(--metric-${activityVariant(entry.lastToolName) === "kb" ? "purple" : activityVariant(entry.lastToolName) === "skills" ? "orange" : activityVariant(entry.lastToolName) === "tools" ? "blue" : "green"})`,
    "--metric-wash": `var(--metric-${...}-wash)`,
  } as React.CSSProperties}
>
```

更干净的做法：把 4 个 `data-variant` 选择器直接写到 CSS：

```css
.activity-row[data-variant="tools"]   { --metric-accent: var(--metric-blue);   --metric-wash: var(--metric-blue-wash); }
.activity-row[data-variant="chat"]    { --metric-accent: var(--metric-green);  --metric-wash: var(--metric-green-wash); }
.activity-row[data-variant="kb"]      { --metric-accent: var(--metric-purple); --metric-wash: var(--metric-purple-wash); }
.activity-row[data-variant="skills"]  { --metric-accent: var(--metric-orange); --metric-wash: var(--metric-orange-wash); }
```

效果：右侧每行前缀一个彩色"光晕点"，颜色与对话最后用到的工具呼应（蓝=python/kingdee、紫=knowledge、绿=普通对话、橙=skill/memory）。即使没数据也有节奏。

---

## 7. 动效（接 `spec-ui-motion.md`）

| 元素 | 动效 | 备注 |
|---|---|---|
| 4 张 metric card | `slideUpIn` + stagger 50ms | 接 WP-M4 listContainer |
| metric value 数字 | `<AnimatedNumber>` count-up 900ms | 接 WP-M7 |
| 4 个 quick action tile | `slideUpIn` + stagger 35ms | 接 WP-M4 |
| 系统状态卡 + 知识库卡 | `fadeIn` 180ms | 简单淡入 |
| 最近对话每行 | `slideUpIn` + stagger 25ms | 短间隔，密集列表 |
| tool-rank 比例条 | width 0 → 实际 600ms ease-out | 视觉锚点 |
| 刷新按钮 | `RotateCw` 旋转中（已有 `.spin`） | 改用 `<AnimatedIcon as={RotateCw} preset="spin">` |

所有动效尊重 `useReducedMotion()`。

---

## 8. 暗色模式 checklist

每张卡 + 每个 chip 在暗色下要单独看一遍：

- [ ] metric card 左侧 3px 色条暗色下仍清晰（用 `--metric-*` 而不是透明叠加）
- [ ] metric badge 28×28 wash 背景不褪成与卡片同色
- [ ] delta chip 圆点外发光圈在暗色下不变成白雾（用 `--metric-*-soft` 而不是固定 rgba）
- [ ] quick action tile hover 阴影在暗色下可辨（用 `box-shadow: 0 4px 16px var(--metric-wash)` 而不是黑色阴影）
- [ ] tool-rank 比例条渐变在暗色下不变成"灰对灰"（已用 `--metric-blue` → `--metric-purple` token）
- [ ] activity-row 光晕点在暗色下视觉权重一致

新增自动化测试（接 `spec-ui-polish.md` WP3 的 `tests/contrast.test.ts`）：
- 4 组 `--metric-*` 与 `--text` 配对 ≥ 4.5:1
- 4 组 `--metric-*` 与 `--surface` 配对 ≥ 3:1（非文字图形）

---

## 9. 实现步骤

| 阶段 | 任务 | 估时 |
|---|---|---|
| **1** | tokens.css 加 `--metric-*` 12 个变量（light + dark） | 30 min |
| **2** | overview.css 重写：`overview-grid` 反转布局；删除当前 `.activity-row` 和 `.quick-action-btn` 旧样式 | 1 h |
| **3** | cockpit.css 重写 `.metric-card`（加 `::before`、`-header`、`-badge`、`-value`、`-delta` 元素） | 1 h |
| **4** | 新增 `.quick-action-tile` 样式与 4 个 variant | 30 min |
| **5** | 新增 `.cockpit-panel-head/-icon/-title`，删 `.overview-section-title` uppercase 灰冷淡风 | 30 min |
| **6** | 新增 `.tool-rank-*` 列表 + 比例条 | 1 h |
| **7** | 新增 `.kb-summary/-stat/-latest-dot` 等知识库卡子结构 | 30 min |
| **8** | `app/cockpit/page.tsx` 重构：MetricCard 加 variant prop；quickActions 数组化；系统状态 + 知识库 JSX 重写；activity-row 加 `data-variant` 与 `activityVariant()` 函数 | 1.5 h |
| **9** | 动效接入（依赖 `spec-ui-motion.md` 完成 `motion-presets.ts` 与 `AnimatedNumber`） | 1 h |
| **10** | 暗色逐张检查 + contrast 测试 | 30 min |

总计 ~7 h。

---

## 10. 不做（明确划界）

- 不引入图表库（chart.js / recharts）——4 张指标 + 一个比例条已经够"信息密度"
- 不做"今日金额/收入/支出"等假数据可视化（项目本身不是 BI）
- 不引入 illustration 插画/吉祥物——保持专业财务工具调性
- 不做 hero 大图/渐变 banner——dashboard 不需要 landing page 元素
- 不做"问候语"（"早上好，gaoyang34"）——重复信息（topbar 已有日期），且无单用户场景的价值
- 不引入彩色边框/七彩色调——只用 4 种语义色（蓝/绿/紫/橙）+ 暗色对偶版本
- 不重构 `/api/cockpit/summary` 数据结构——现有字段够用
