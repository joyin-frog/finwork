"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Oklch = { l: number; c: number; h: number; a: number };
type ColorKey = "background" | "foreground" | "primary" | "primary-foreground" | "ring" | "card" | "sidebar" | "muted" | "accent" | "border";
type Tier = { key: string; label: string; px: number; weight: number; lh: number; tracking: number };
type Mode = "light" | "dark";

const LS_KEY = "fa-theme-playground-v3";
// 顺序对齐 globals.css :root「可调」节,导出即与该节一致
const COLOR_KEYS: ColorKey[] = ["background", "foreground", "primary", "primary-foreground", "ring", "card", "sidebar", "muted", "accent", "border"];
const COLOR_LABEL: Record<ColorKey, string> = {
  background: "背景 background", foreground: "前景 foreground", primary: "主色 primary", "primary-foreground": "主色文字 primary-fg", ring: "焦点环 ring",
  card: "卡片 card", sidebar: "侧栏 sidebar", muted: "弱底 muted", accent: "悬停 accent", border: "描边 border",
};
const COLOR_GROUPS: { title: string; keys: ColorKey[] }[] = [
  { title: "主色", keys: ["background", "foreground", "primary", "primary-foreground"] },
  { title: "表面色", keys: ["card", "sidebar", "muted", "accent", "border", "ring"] },
];

// 默认值对齐 app/globals.css 的 :root(亮)与 .dark(暗)
const LIGHT: Record<ColorKey, Oklch> = {
  background: { l: 0.989, c: 0.002, h: 75, a: 1 }, foreground: { l: 0.145, c: 0, h: 0, a: 1 }, primary: { l: 0.52, c: 0.13, h: 152, a: 1 }, "primary-foreground": { l: 0.98, c: 0.02, h: 152, a: 1 }, ring: { l: 0.708, c: 0, h: 0, a: 1 },
  card: { l: 1, c: 0, h: 0, a: 1 }, sidebar: { l: 0.978, c: 0.0025, h: 75, a: 1 }, muted: { l: 0.97, c: 0, h: 0, a: 1 }, accent: { l: 0.97, c: 0, h: 0, a: 1 }, border: { l: 0.922, c: 0, h: 0, a: 1 },
};
const DARK: Record<ColorKey, Oklch> = {
  background: { l: 0.145, c: 0, h: 0, a: 1 }, foreground: { l: 0.985, c: 0, h: 0, a: 1 }, primary: { l: 0.68, c: 0.15, h: 152, a: 1 }, "primary-foreground": { l: 0.20, c: 0.04, h: 152, a: 1 }, ring: { l: 0.556, c: 0, h: 0, a: 1 },
  card: { l: 0.205, c: 0, h: 0, a: 1 }, sidebar: { l: 0.205, c: 0, h: 0, a: 1 }, muted: { l: 0.269, c: 0, h: 0, a: 1 }, accent: { l: 0.269, c: 0, h: 0, a: 1 }, border: { l: 1, c: 0, h: 0, a: 0.1 },
};

const DEFAULT_RADIUS = 0.875;
const DEFAULT_ROOT = 16;
const DEFAULT_LH = { tight: 1.4, snug: 1.55, body: 1.7 }; // .md-content 行距(标题/代码/正文),对应 globals 的 --lh-*
const DEFAULT_TIERS: Tier[] = [
  { key: "figure", label: "figure 大数/金额", px: 30, weight: 500, lh: 1.05, tracking: -0.01 },
  { key: "display", label: "display 主问句", px: 24, weight: 600, lh: 1.15, tracking: -0.015 },
  { key: "h1", label: "h1 主标题", px: 20, weight: 600, lh: 1.25, tracking: -0.01 },
  { key: "h2", label: "h2 次标题", px: 18, weight: 600, lh: 1.3, tracking: -0.005 },
  { key: "title", label: "title 卡片标题", px: 16, weight: 600, lh: 1.35, tracking: 0 },
  { key: "body", label: "body 正文", px: 14, weight: 400, lh: 1.6, tracking: 0 },
  { key: "small", label: "small 强调小字", px: 13, weight: 500, lh: 1.45, tracking: 0 },
  { key: "meta", label: "meta 次要", px: 12, weight: 400, lh: 1.45, tracking: 0 },
  { key: "caption", label: "caption 计数/时间", px: 11, weight: 500, lh: 1.4, tracking: 0.02 },
];
const FONT_OPTIONS: { id: string; label: string; sans: string | null; mono: string | null }[] = [
  { id: "default", label: "默认(Geist + 苹方)", sans: null, mono: null },
  { id: "inter", label: "Inter + JetBrains Mono", sans: 'var(--font-inter), -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif', mono: 'var(--font-jetbrains), "SF Mono", Consolas, monospace' },
  { id: "system", label: "系统 sans", sans: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', mono: null },
];
const DEFAULT_RING_ALPHA = 0.1;
// 卡片阴影预设(明暗各一版):flat=现状;finance=微距立体·蓝染(暗色改用更强黑,因蓝染在深底几乎不可见)
const SHADOW_PRESETS: { id: string; label: string; light: string; dark: string }[] = [
  { id: "flat", label: "当前(扁平 3%)", light: "0 1px 2px oklch(0 0 0 / 3%)", dark: "0 1px 2px oklch(0 0 0 / 22%)" },
  { id: "finance", label: "finance-card(微距立体·蓝染)", light: "0 1px 3px 0 oklch(0.16 0.018 253 / 4%), 0 1px 2px -1px oklch(0.16 0.018 253 / 6%)", dark: "0 1px 3px 0 oklch(0 0 0 / 30%), 0 1px 2px -1px oklch(0 0 0 / 50%)" },
];

const round = (n: number, p: number) => { const m = 10 ** p; return Math.round(n * m) / m; };
const oklchStr = (c: Oklch) => c.a < 1
  ? `oklch(${round(c.l, 3)} ${round(c.c, 3)} ${round(c.h, 1)} / ${round(c.a * 100, 1)}%)`
  : `oklch(${round(c.l, 3)} ${round(c.c, 3)} ${round(c.h, 1)})`;
const pxToRem = (px: number) => round(px / 16, 4);

function applyCss(text: string) {
  const r = document.documentElement;
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) r.style.setProperty(m[1], m[2].trim());
  const fs = text.match(/font-size\s*:\s*([\d.]+px)/);
  if (fs) r.style.fontSize = fs[1];
}

function buildExport(light: Record<ColorKey, Oklch>, dark: Record<ColorKey, Oklch>, radius: number, tiers: Tier[], root: number, fontId: string, cardShadow: string, ringAlpha: number, lh: typeof DEFAULT_LH): string {
  const shadow = SHADOW_PRESETS.find((s) => s.id === cardShadow) ?? SHADOW_PRESETS[0];
  const ringStr = (fg: Oklch) => `oklch(${round(fg.l, 3)} ${round(fg.c, 3)} ${round(fg.h, 1)} / ${round(ringAlpha * 100, 1)}%)`;
  const theme = tiers.map((t) =>
    [`  --text-${t.key}: ${pxToRem(t.px)}rem;`, `  --text-${t.key}--line-height: ${t.lh};`, `  --text-${t.key}--font-weight: ${t.weight};`, t.tracking ? `  --text-${t.key}--letter-spacing: ${t.tracking}em;` : null].filter(Boolean).join("\n")
  ).join("\n\n");
  const font = FONT_OPTIONS.find((f) => f.id === fontId);
  const lines = [
    "/* === 字阶:替换 @theme {} 内容(UI 按 px,导出 rem=px/16,明暗共用)=== */",
    "@theme {", theme, "}", "",
    "/* === 亮色:替换 :root 对应行 === */", ":root {",
    ...COLOR_KEYS.map((k) => `  --${k}: ${oklchStr(light[k])};`),
    `  --radius: ${radius}rem;`,
    ...((lh.tight !== DEFAULT_LH.tight || lh.snug !== DEFAULT_LH.snug || lh.body !== DEFAULT_LH.body) ? [`  /* .md-content 行距(可粘到 markdown 行距 :root 块) */`, `  --lh-tight: ${lh.tight};`, `  --lh-snug: ${lh.snug};`, `  --lh-body: ${lh.body};`] : []),
    ...(ringAlpha !== DEFAULT_RING_ALPHA ? [`  --card-ring: ${ringStr(light.foreground)};`] : []),
    ...(cardShadow !== "flat" ? [`  --card-lift: ${shadow.light};`] : []),
    ...(font?.sans ? [`  --font-sans: ${font.sans};`] : []),
    ...(font?.mono ? [`  --font-mono: ${font.mono};`] : []),
    "}", "",
    "/* === 暗色:替换 .dark 对应行 === */", ".dark {",
    ...COLOR_KEYS.map((k) => `  --${k}: ${oklchStr(dark[k])};`),
    ...(ringAlpha !== DEFAULT_RING_ALPHA ? [`  --card-ring: ${ringStr(dark.foreground)};`] : []),
    ...(cardShadow !== "flat" ? [`  --card-lift: ${shadow.dark};`] : []),
    "}",
  ];
  if (root !== DEFAULT_ROOT) lines.push("", "/* 全局缩放:根字号(默认16) */", `html { font-size: ${root}px; }`);
  return lines.join("\n") + "\n";
}

const tierStyle = (t: Tier): CSSProperties => ({
  fontSize: `var(--text-${t.key}, ${pxToRem(t.px)}rem)`,
  fontWeight: `var(--text-${t.key}--font-weight, ${t.weight})`,
  lineHeight: `var(--text-${t.key}--line-height, ${t.lh})`,
  letterSpacing: `var(--text-${t.key}--letter-spacing, ${t.tracking}em)`,
} as CSSProperties);

export function ThemePlayground() {
  const [light, setLight] = useState<Record<ColorKey, Oklch>>(LIGHT);
  const [dark, setDark] = useState<Record<ColorKey, Oklch>>(DARK);
  const [mode, setMode] = useState<Mode>("light");
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [root, setRoot] = useState(DEFAULT_ROOT);
  const [tiers, setTiers] = useState<Tier[]>(DEFAULT_TIERS);
  const [fontId, setFontId] = useState("default");
  const [cardShadow, setCardShadow] = useState("flat");
  const [ringAlpha, setRingAlpha] = useState(DEFAULT_RING_ALPHA);
  const [lh, setLh] = useState(DEFAULT_LH);
  const [snippet, setSnippet] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.light) setLight({ ...LIGHT, ...s.light });
        if (s.dark) setDark({ ...DARK, ...s.dark });
        if (s.mode) setMode(s.mode);
        if (typeof s.radius === "number") setRadius(s.radius);
        if (typeof s.root === "number") setRoot(s.root);
        if (Array.isArray(s.tiers)) setTiers(s.tiers);
        if (typeof s.fontId === "string") setFontId(s.fontId);
        if (typeof s.cardShadow === "string") setCardShadow(s.cardShadow);
        if (typeof s.ringAlpha === "number") setRingAlpha(s.ringAlpha);
        if (s.lh) setLh({ ...DEFAULT_LH, ...s.lh });
      } else {
        setMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const r = document.documentElement;
    r.classList.toggle("dark", mode === "dark");
    const active = mode === "dark" ? dark : light;
    for (const k of COLOR_KEYS) r.style.setProperty(`--${k}`, oklchStr(active[k]));
    r.style.setProperty("--radius", `${radius}rem`);
    r.style.fontSize = `${root}px`;
    for (const t of tiers) {
      r.style.setProperty(`--text-${t.key}`, `${pxToRem(t.px)}rem`);
      r.style.setProperty(`--text-${t.key}--line-height`, String(t.lh));
      r.style.setProperty(`--text-${t.key}--font-weight`, String(t.weight));
      r.style.setProperty(`--text-${t.key}--letter-spacing`, `${t.tracking}em`);
    }
    const font = FONT_OPTIONS.find((f) => f.id === fontId);
    if (font?.sans) r.style.setProperty("--font-sans", font.sans); else r.style.removeProperty("--font-sans");
    if (font?.mono) r.style.setProperty("--font-mono", font.mono); else r.style.removeProperty("--font-mono");
    const shadow = SHADOW_PRESETS.find((s) => s.id === cardShadow) ?? SHADOW_PRESETS[0];
    r.style.setProperty("--card-lift", mode === "dark" ? shadow.dark : shadow.light);
    const ringFg = mode === "dark" ? dark.foreground : light.foreground;
    r.style.setProperty("--card-ring", `oklch(${round(ringFg.l, 3)} ${round(ringFg.c, 3)} ${round(ringFg.h, 1)} / ${round(ringAlpha * 100, 1)}%)`);
    r.style.setProperty("--lh-tight", String(lh.tight));
    r.style.setProperty("--lh-snug", String(lh.snug));
    r.style.setProperty("--lh-body", String(lh.body));
    setSnippet(buildExport(light, dark, radius, tiers, root, fontId, cardShadow, ringAlpha, lh));
    try { localStorage.setItem(LS_KEY, JSON.stringify({ light, dark, mode, radius, root, tiers, fontId, cardShadow, ringAlpha, lh })); } catch { /* ignore */ }
  }, [light, dark, mode, radius, root, tiers, fontId, cardShadow, ringAlpha, lh, loaded]);

  const reset = () => {
    setLight(LIGHT); setDark(DARK); setRadius(DEFAULT_RADIUS); setRoot(DEFAULT_ROOT); setTiers(DEFAULT_TIERS); setFontId("default");
    setCardShadow("flat"); setRingAlpha(DEFAULT_RING_ALPHA); setLh(DEFAULT_LH);
    document.documentElement.style.fontSize = "";
    document.documentElement.style.removeProperty("--card-lift");
    document.documentElement.style.removeProperty("--card-ring");
    for (const k of ["--lh-tight", "--lh-snug", "--lh-body"]) document.documentElement.style.removeProperty(k);
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  };
  const active = mode === "dark" ? dark : light;
  const setActiveColor = (k: ColorKey, v: Oklch) => (mode === "dark" ? setDark : setLight)((p) => ({ ...p, [k]: v }));
  const setTier = (i: number, patch: Partial<Tier>) => setTiers((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3 shrink-0">
        <h1 className="text-h2">主题调试台</h1>
        <div className="flex overflow-hidden rounded-md border border-border text-meta">
          <button onClick={() => setMode("light")} className={mode === "light" ? "bg-primary px-3 py-1 text-primary-foreground" : "px-3 py-1 text-muted-foreground"}>亮</button>
          <button onClick={() => setMode("dark")} className={mode === "dark" ? "bg-primary px-3 py-1 text-primary-foreground" : "px-3 py-1 text-muted-foreground"}>暗</button>
        </div>
        <span className="text-meta text-muted-foreground">当前编辑「{mode === "dark" ? "暗色" : "亮色"}」调色板 · 字号/圆角/字体明暗共用</span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={reset}>重置</Button>
      </header>

      <div className="grid flex-1 grid-cols-[minmax(400px,460px)_1fr] overflow-hidden">
        <div className="flex flex-col gap-6 overflow-y-auto border-r border-border p-5">
          {COLOR_GROUPS.map((g) => (
            <section key={g.title} className="flex flex-col gap-3">
              <h2 className="text-title">{g.title}（{mode === "dark" ? "暗" : "亮"}）</h2>
              {g.keys.map((k) => (
                <ColorControl key={k} label={COLOR_LABEL[k]} value={active[k]} onChange={(v) => setActiveColor(k, v)} />
              ))}
            </section>
          ))}

          <section className="flex flex-col gap-2">
            <h2 className="text-title">圆角 & 全局缩放 & 字体（明暗共用）</h2>
            <Field label="圆角 radius" unit="rem" value={radius} min={0} max={1.6} step={0.0625} onChange={setRadius} />
            <Field label="根字号(全局缩放)" unit="px" value={root} min={12} max={20} step={0.5} onChange={setRoot} />
            <label className="flex items-center gap-2 text-meta">
              <span className="w-28 shrink-0 text-muted-foreground">字体 font-sans</span>
              <select value={fontId} onChange={(e) => setFontId(e.target.value)} className="flex-1 rounded border border-border bg-background px-2 py-1 text-meta">
                {FONT_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <p className="text-caption text-muted-foreground">字体只作用拉丁/数字,中文走系统苹方回退。</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-title">卡片质感（阴影明暗各一版 · 描边浓度共用）</h2>
            <label className="flex items-center gap-2 text-meta">
              <span className="w-28 shrink-0 text-muted-foreground">卡片阴影 --card-lift</span>
              <select value={cardShadow} onChange={(e) => setCardShadow(e.target.value)} className="flex-1 rounded border border-border bg-background px-2 py-1 text-meta">
                {SHADOW_PRESETS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <Field label="描边浓度 ring" value={ringAlpha} min={0} max={0.25} step={0.01} onChange={setRingAlpha} />
            <p className="text-caption text-muted-foreground">阴影只在 &lt;Card&gt; 上生效(当前仅总览页用);描边浓度调 ring-foreground 透明度。要细调阴影直接改下方导出片段。</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-title">对话正文排版（.md-content,明暗共用)</h2>
            <Field label="正文行距 body" value={lh.body} min={1.3} max={2} step={0.05} onChange={(v) => setLh({ ...lh, body: v })} />
            <Field label="代码行距 snug" value={lh.snug} min={1.2} max={1.9} step={0.05} onChange={(v) => setLh({ ...lh, snug: v })} />
            <Field label="标题行距 tight" value={lh.tight} min={1.1} max={1.6} step={0.05} onChange={(v) => setLh({ ...lh, tight: v })} />
            <p className="text-caption text-muted-foreground">对话答案/markdown 的行距(globals 的 --lh-*)。圆角已并入全局 radius:代码块/行内码现跟 --radius 阶走(代码块 --radius-md、行内码 --radius-sm)。</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-title">字阶（明暗共用）</h2>
            <div className="grid grid-cols-[1fr_repeat(4,52px)] items-center gap-x-2 gap-y-1.5 text-caption text-muted-foreground">
              <span /><span className="text-center">px</span><span className="text-center">粗</span><span className="text-center">行距</span><span className="text-center">字距</span>
              {tiers.map((t, i) => <TierRow key={t.key} tier={t} onChange={(p) => setTier(i, p)} />)}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto p-6">
          <section className="flex flex-col gap-1">
            <p className="text-meta text-muted-foreground">字阶预览(读 CSS 变量,实时反映)</p>
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
              {tiers.map((t) => (
                <div key={t.key} className="flex items-baseline gap-3 border-b border-border/50 pb-1.5 last:border-0">
                  <code className="w-28 shrink-0 text-caption text-muted-foreground">text-{t.key}</code>
                  <span style={tierStyle(t)}>财务分析 12,345.67</span>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-1">
            <p className="text-meta text-muted-foreground">对话 markdown 预览(.md-content,反映行距 / 圆角 / 字号)</p>
            <div className="md-content rounded-xl border border-border bg-card p-5">
              <h3>合同收付分析</h3>
              <p>正文示例:本月应付 <code>¥51,000</code>、应收 <code>¥120,000</code>。下面是代码块与列表,看行距与圆角。</p>
              <pre>{`summarizeObligations(rows)\n  // 仅已确认口径,asOf 透传`}</pre>
              <ul>
                <li>应付:金蝶软件 ¥5,000(还款 7 天)</li>
                <li>应收:上海远景科技 ¥120,000</li>
              </ul>
            </div>
          </section>

          <section className="flex flex-col gap-1">
            <p className="text-meta text-muted-foreground">真实组件(反映颜色 / 圆角 / 字号 / 字体)</p>
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex w-40 flex-col gap-1 rounded-lg bg-sidebar p-2">
                <span className="rounded-md bg-primary/10 px-2.5 py-1.5 text-body font-medium text-primary">新对话</span>
                <span className="rounded-md px-2.5 py-1.5 text-body text-foreground hover:bg-accent">总览</span>
                <span className="rounded-md px-2.5 py-1.5 text-body text-muted-foreground hover:bg-accent">资料</span>
              </div>
              <Card className="w-72">
                <CardHeader><CardTitle>合同收付总览</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="text-body">正文示例,看正文与标题、副标的层级关系。</p>
                  <p className="text-meta text-muted-foreground">次要说明 · 更新于 8 小时前</p>
                  <strong className="text-figure tabular-nums">¥1,234,567</strong>
                </CardContent>
              </Card>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm">主按钮</Button>
                  <Button size="sm" variant="outline">次按钮</Button>
                  <Button size="sm" variant="ghost">幽灵</Button>
                </div>
                <input className="w-56 rounded-md border border-input bg-input/20 px-3 py-2 text-body outline-none" placeholder="输入框示例" />
                <span className="font-mono text-body tabular-nums">等宽数字 0123456789 · ¥1,234,567.89</span>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <p className="text-meta text-muted-foreground">导出 / 编辑片段(可直接改,实时生效;含亮/暗两块,粘回 app/globals.css)</p>
              <Button size="sm" variant="outline" className="ml-auto" onClick={copy}>{copied ? "已复制 ✓" : "复制"}</Button>
            </div>
            <textarea
              value={snippet}
              onChange={(e) => { setSnippet(e.target.value); applyCss(e.target.value); }}
              spellCheck={false}
              className="h-80 w-full resize-none rounded-lg border border-border bg-muted/40 p-3 font-mono text-small leading-relaxed outline-none focus:border-ring"
            />
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({ label, unit, value, min, max, step, onChange }: {
  label: string; unit?: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-meta">
      <span className="w-24 shrink-0 text-muted-foreground">{label}{unit ? ` (${unit})` : ""}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="flex-1 accent-[color:var(--primary)]" />
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-meta tabular-nums" />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: Oklch; onChange: (v: Oklch) => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="size-5 rounded border border-border" style={{ background: oklchStr(value) }} />
        <span className="text-small font-medium">{label}</span>
        <code className="ml-auto text-caption text-muted-foreground">{oklchStr(value)}</code>
      </div>
      <Field label="明度 L" value={value.l} min={0} max={1} step={0.005} onChange={(l) => onChange({ ...value, l })} />
      <Field label="彩度 C" value={value.c} min={0} max={0.4} step={0.005} onChange={(c) => onChange({ ...value, c })} />
      <Field label="色相 H" value={value.h} min={0} max={360} step={1} onChange={(h) => onChange({ ...value, h })} />
      <Field label="透明 A" value={value.a} min={0} max={1} step={0.05} onChange={(a) => onChange({ ...value, a })} />
    </div>
  );
}

function TierRow({ tier, onChange }: { tier: Tier; onChange: (p: Partial<Tier>) => void }) {
  const cell = "w-13 rounded border border-border bg-background px-1 py-0.5 text-caption tabular-nums text-center";
  return (
    <>
      <span className="text-meta text-foreground">{tier.label}</span>
      <input type="number" step={1} value={tier.px} onChange={(e) => onChange({ px: parseFloat(e.target.value) })} className={cell} />
      <input type="number" step={50} value={tier.weight} onChange={(e) => onChange({ weight: parseFloat(e.target.value) })} className={cell} />
      <input type="number" step={0.05} value={tier.lh} onChange={(e) => onChange({ lh: parseFloat(e.target.value) })} className={cell} />
      <input type="number" step={0.005} value={tier.tracking} onChange={(e) => onChange({ tracking: parseFloat(e.target.value) })} className={cell} />
    </>
  );
}
