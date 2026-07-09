"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
// Surface 展示区：唯一允许直写外观类做对照的页面。
import { Surface } from "@/components/ui/surface";

type Oklch = { l: number; c: number; h: number; a: number };
type ColorKey = "background" | "foreground" | "primary" | "primary-foreground" | "ring" | "card" | "sidebar" | "muted" | "accent" | "border";
type Tier = { key: string; label: string; px: number; weight: number; lh: number; tracking: number };
type Mode = "light" | "dark";
type StyleMode = "default" | "linear";

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

// Linear 风格新 token 的初始值(对齐 globals.css [data-style='linear'] / html.dark[data-style='linear'])
const DEFAULT_SHELL_CANVAS_LIGHT: Oklch = { l: 0.962, c: 0.003, h: 260, a: 1 };
const DEFAULT_SHELL_CANVAS_DARK: Oklch = { l: 0.13, c: 0.003, h: 260, a: 1 };
const DEFAULT_DENSITY = { surfacePad: 1, surfacePadSm: 0.75, pagePad: 1.5, sectionGap: 1.5, cardGap: 1 };
const DEFAULT_MOTION = { fast: 120, slow: 300 };

const round = (n: number, p: number) => { const m = 10 ** p; return Math.round(n * m) / m; };
const oklchStr = (c: Oklch) => c.a < 1
  ? `oklch(${round(c.l, 3)} ${round(c.c, 3)} ${round(c.h, 1)} / ${round(c.a * 100, 1)}%)`
  : `oklch(${round(c.l, 3)} ${round(c.c, 3)} ${round(c.h, 1)})`;
const pxToRem = (px: number) => round(px / 16, 4);

// oklch 字符串解析（失败返回 null）
function parseOklch(str: string): Oklch | null {
  const s = str.trim();
  const m = s.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/);
  if (!m) return null;
  const aRaw = m[4] ? parseFloat(m[4]) : 1;
  const a = m[5] === "%" ? aRaw / 100 : aRaw;
  return { l: parseFloat(m[1]), c: parseFloat(m[2]), h: parseFloat(m[3]), a };
}

function readComputedDensity(el: HTMLElement): typeof DEFAULT_DENSITY {
  const g = (prop: string) => parseFloat(getComputedStyle(el).getPropertyValue(prop).trim());
  return {
    surfacePad: g("--surface-pad") || DEFAULT_DENSITY.surfacePad,
    surfacePadSm: g("--surface-pad-sm") || DEFAULT_DENSITY.surfacePadSm,
    pagePad: g("--page-pad") || DEFAULT_DENSITY.pagePad,
    sectionGap: g("--section-gap") || DEFAULT_DENSITY.sectionGap,
    cardGap: g("--card-gap") || DEFAULT_DENSITY.cardGap,
  };
}

function readComputedMotion(el: HTMLElement): typeof DEFAULT_MOTION {
  const g = (prop: string) => parseFloat(getComputedStyle(el).getPropertyValue(prop).trim());
  return {
    fast: g("--motion-fast") || DEFAULT_MOTION.fast,
    slow: g("--motion-slow") || DEFAULT_MOTION.slow,
  };
}

// 双模快照：移除 inline 覆盖，临时切换 dark class 读亮/暗两套级联值后恢复。
// 同步完成，无重排，不产生闪帧。用于切风格和首次挂载（无 localStorage 时）。
function snapshotStyleColors(el: HTMLElement, isDark: boolean): {
  light: Record<ColorKey, Oklch>;
  dark: Record<ColorKey, Oklch>;
  shellCanvasLight: Oklch;
  shellCanvasDark: Oklch;
  radius: number;
  density: typeof DEFAULT_DENSITY;
  motion: typeof DEFAULT_MOTION;
} {
  // 保存并移除所有 inline 覆盖，让 getComputedStyle 读到纯 CSS 级联值
  const PROPS = [
    ...COLOR_KEYS.map((k) => `--${k}`),
    "--shell-canvas", "--radius",
    "--surface-pad", "--surface-pad-sm", "--page-pad", "--section-gap", "--card-gap", "--motion-fast", "--motion-slow",
  ];
  const savedInline = PROPS.map((p) => el.style.getPropertyValue(p));
  const savedFontSize = el.style.fontSize;
  PROPS.forEach((p) => el.style.removeProperty(p));
  el.style.fontSize = "";  // 移除根字号覆盖，避免影响 rem 解析

  // transparent → a=0 的 oklch；其余 CSS 关键字/var() 无法解析则回退到硬编码默认值
  const readColor = (prop: string): Oklch | null => {
    const val = getComputedStyle(el).getPropertyValue(prop).trim();
    if (val === "transparent") return { l: 0, c: 0, h: 0, a: 0 };
    return parseOklch(val);
  };

  // 读亮色（含 radius，风格间可能不同）
  el.classList.remove("dark");
  const light = Object.fromEntries(COLOR_KEYS.map((k) => [k, readColor(`--${k}`) ?? LIGHT[k]])) as Record<ColorKey, Oklch>;
  const shellCanvasLight = readColor("--shell-canvas") ?? DEFAULT_SHELL_CANVAS_LIGHT;
  const radius = parseFloat(getComputedStyle(el).getPropertyValue("--radius").trim()) || DEFAULT_RADIUS;
  const density = readComputedDensity(el);
  const motion = readComputedMotion(el);

  // 读暗色
  el.classList.add("dark");
  const dark = Object.fromEntries(COLOR_KEYS.map((k) => [k, readColor(`--${k}`) ?? DARK[k]])) as Record<ColorKey, Oklch>;
  const shellCanvasDark = readColor("--shell-canvas") ?? DEFAULT_SHELL_CANVAS_DARK;

  // 恢复原状
  if (isDark) el.classList.add("dark"); else el.classList.remove("dark");
  PROPS.forEach((p, i) => { if (savedInline[i]) el.style.setProperty(p, savedInline[i]); });
  el.style.fontSize = savedFontSize;

  return { light, dark, shellCanvasLight, shellCanvasDark, radius, density, motion };
}

function applyCss(text: string) {
  const r = document.documentElement;
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) r.style.setProperty(m[1], m[2].trim());
  const fs = text.match(/font-size\s*:\s*([\d.]+px)/);
  if (fs) r.style.fontSize = fs[1];
}

function buildExport(
  light: Record<ColorKey, Oklch>, dark: Record<ColorKey, Oklch>, radius: number, tiers: Tier[], root: number,
  fontId: string, cardShadow: string, ringAlpha: number, lh: typeof DEFAULT_LH,
  styleMode: StyleMode, shellCanvasLight: Oklch, shellCanvasDark: Oklch,
  density: typeof DEFAULT_DENSITY, motion: typeof DEFAULT_MOTION,
): string {
  const shadow = SHADOW_PRESETS.find((s) => s.id === cardShadow) ?? SHADOW_PRESETS[0];
  const ringStr = (fg: Oklch) => `oklch(${round(fg.l, 3)} ${round(fg.c, 3)} ${round(fg.h, 1)} / ${round(ringAlpha * 100, 1)}%)`;
  const theme = tiers.map((t) =>
    [`  --text-${t.key}: ${pxToRem(t.px)}rem;`, `  --text-${t.key}--line-height: ${t.lh};`, `  --text-${t.key}--font-weight: ${t.weight};`, t.tracking ? `  --text-${t.key}--letter-spacing: ${t.tracking}em;` : null].filter(Boolean).join("\n")
  ).join("\n\n");
  const font = FONT_OPTIONS.find((f) => f.id === fontId);

  if (styleMode === "linear") {
    // 生成 [data-style='linear'] 与 html.dark[data-style='linear'] 覆盖块
    // 按行合并回挂载区：暗块里的 --popover/--muted-foreground/--input/--elevation-* 等非旋钮 token 不在导出中，整块替换会把它们丢掉
    const lines = [
      "/* === 字阶:替换 @theme {} 内容(UI 按 px,导出 rem=px/16,明暗共用)=== */",
      "@theme {", theme, "}", "",
      "/* 贴回 globals.css 风格挂载区:按行合并进对应选择器块(同名行覆盖,导出中没有的行保留——暗块的 popover/muted-foreground/input/elevation 等不在旋钮内,整块替换会丢) */",
      "/* === Linear 亮色覆盖块 === */",
      "[data-style='linear'] {",
      `  --shell-canvas: ${oklchStr(shellCanvasLight)};`,
      ...COLOR_KEYS.map((k) => `  --${k}: ${oklchStr(light[k])};`),
      `  --radius: ${radius}rem;`,
      `  /* 密度/动效与明暗无关，放亮块 */`,
      `  --surface-pad: ${density.surfacePad}rem;`,
      `  --surface-pad-sm: ${density.surfacePadSm}rem;`,
      `  --page-pad: ${density.pagePad}rem;`,
      `  --section-gap: ${density.sectionGap}rem;`,
      `  --card-gap: ${density.cardGap}rem;`,
      `  --motion-fast: ${motion.fast}ms;`,
      `  --motion-slow: ${motion.slow}ms;`,
      ...(ringAlpha !== DEFAULT_RING_ALPHA ? [`  --card-ring: ${ringStr(light.foreground)};`] : []),
      ...(cardShadow !== "flat" ? [`  --card-lift: ${shadow.light};`] : []),
      ...(font?.sans ? [`  --font-sans: ${font.sans};`] : []),
      ...(font?.mono ? [`  --font-mono: ${font.mono};`] : []),
      "}",
      "",
      "/* === Linear 暗色覆盖块 === */",
      "html.dark[data-style='linear'] {",
      `  --shell-canvas: ${oklchStr(shellCanvasDark)};`,
      ...COLOR_KEYS.map((k) => `  --${k}: ${oklchStr(dark[k])};`),
      ...(ringAlpha !== DEFAULT_RING_ALPHA ? [`  --card-ring: ${ringStr(dark.foreground)};`] : []),
      ...(cardShadow !== "flat" ? [`  --card-lift: ${shadow.dark};`] : []),
      "}",
    ];
    if (root !== DEFAULT_ROOT) lines.push("", "/* 全局缩放:根字号(默认16) */", `html { font-size: ${root}px; }`);
    return lines.join("\n") + "\n";
  }

  // 默认风格：维持现状，:root / .dark 两段（密度/动效有变化时追加）
  const densityChanged = density.surfacePad !== DEFAULT_DENSITY.surfacePad || density.surfacePadSm !== DEFAULT_DENSITY.surfacePadSm || density.pagePad !== DEFAULT_DENSITY.pagePad || density.sectionGap !== DEFAULT_DENSITY.sectionGap || density.cardGap !== DEFAULT_DENSITY.cardGap;
  const motionChanged = motion.fast !== DEFAULT_MOTION.fast || motion.slow !== DEFAULT_MOTION.slow;
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
    ...(densityChanged ? [
      `  /* 密度 token (与明暗无关，默认风格修改时粘回 :root) */`,
      `  --surface-pad: ${density.surfacePad}rem;`,
      `  --surface-pad-sm: ${density.surfacePadSm}rem;`,
      `  --page-pad: ${density.pagePad}rem;`,
      `  --section-gap: ${density.sectionGap}rem;`,
      `  --card-gap: ${density.cardGap}rem;`,
    ] : []),
    ...(motionChanged ? [
      `  /* 动效 token */`,
      `  --motion-fast: ${motion.fast}ms;`,
      `  --motion-slow: ${motion.slow}ms;`,
    ] : []),
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
  // 新增：风格、外壳色、密度、动效
  const [styleMode, setStyleMode] = useState<StyleMode>("default");
  const [shellCanvasLight, setShellCanvasLight] = useState<Oklch>(DEFAULT_SHELL_CANVAS_LIGHT);
  const [shellCanvasDark, setShellCanvasDark] = useState<Oklch>(DEFAULT_SHELL_CANVAS_DARK);
  const [density, setDensity] = useState(DEFAULT_DENSITY);
  const [motion, setMotion] = useState(DEFAULT_MOTION);

  useEffect(() => {
    try {
      // 风格读 DOM（由设置页写入），不读 localStorage，确保刷新后回到设置页所选风格
      const domStyle = document.documentElement.dataset.style;
      setStyleMode(domStyle === "linear" ? "linear" : "default");

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
        if (s.shellCanvasLight) setShellCanvasLight(s.shellCanvasLight);
        if (s.shellCanvasDark) setShellCanvasDark(s.shellCanvasDark);
        if (s.density) setDensity({ ...DEFAULT_DENSITY, ...s.density });
        if (s.motion) setMotion({ ...DEFAULT_MOTION, ...s.motion });
      } else {
        // 无 localStorage：双模快照读 CSS 级联值，确保亮/暗 state 与当前风格对齐
        const r = document.documentElement;
        const isDark = r.classList.contains("dark");
        setMode(isDark ? "dark" : "light");
        const snap = snapshotStyleColors(r, isDark);
        setLight(snap.light);
        setDark(snap.dark);
        setShellCanvasLight(snap.shellCanvasLight);
        setShellCanvasDark(snap.shellCanvasDark);
        setRadius(snap.radius);
        setDensity(snap.density);
        setMotion(snap.motion);
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
    // 风格模式
    if (styleMode === "linear") r.dataset.style = "linear";
    else r.removeAttribute("data-style");
    // 新 token：shell-canvas（linear 风格才覆盖，默认风格走 CSS 级联 var(--background)）
    const activeShellCanvas = mode === "dark" ? shellCanvasDark : shellCanvasLight;
    if (styleMode === "linear") r.style.setProperty("--shell-canvas", oklchStr(activeShellCanvas));
    else r.style.removeProperty("--shell-canvas");
    // 密度
    r.style.setProperty("--surface-pad", `${density.surfacePad}rem`);
    r.style.setProperty("--surface-pad-sm", `${density.surfacePadSm}rem`);
    r.style.setProperty("--page-pad", `${density.pagePad}rem`);
    r.style.setProperty("--section-gap", `${density.sectionGap}rem`);
    r.style.setProperty("--card-gap", `${density.cardGap}rem`);
    // 动效
    r.style.setProperty("--motion-fast", `${motion.fast}ms`);
    r.style.setProperty("--motion-slow", `${motion.slow}ms`);

    setSnippet(buildExport(light, dark, radius, tiers, root, fontId, cardShadow, ringAlpha, lh, styleMode, shellCanvasLight, shellCanvasDark, density, motion));
    try { localStorage.setItem(LS_KEY, JSON.stringify({ light, dark, mode, radius, root, tiers, fontId, cardShadow, ringAlpha, lh, shellCanvasLight, shellCanvasDark, density, motion })); } catch { /* ignore */ }
  }, [light, dark, mode, radius, root, tiers, fontId, cardShadow, ringAlpha, lh, styleMode, shellCanvasLight, shellCanvasDark, density, motion, loaded]);

  // 切风格：双模快照读新风格的 CSS 级联值，重置亮/暗全部颜色及新 token
  const handleStyleModeChange = (newStyle: StyleMode) => {
    const r = document.documentElement;
    if (newStyle === "linear") r.dataset.style = "linear";
    else r.removeAttribute("data-style");
    const snap = snapshotStyleColors(r, mode === "dark");
    setLight(snap.light);
    setDark(snap.dark);
    setShellCanvasLight(snap.shellCanvasLight);
    setShellCanvasDark(snap.shellCanvasDark);
    setRadius(snap.radius);
    setDensity(snap.density);
    setMotion(snap.motion);
    setStyleMode(newStyle);
  };

  const reset = () => {
    setLight(LIGHT); setDark(DARK); setRadius(DEFAULT_RADIUS); setRoot(DEFAULT_ROOT); setTiers(DEFAULT_TIERS); setFontId("default");
    setCardShadow("flat"); setRingAlpha(DEFAULT_RING_ALPHA); setLh(DEFAULT_LH);
    setShellCanvasLight(DEFAULT_SHELL_CANVAS_LIGHT);
    setShellCanvasDark(DEFAULT_SHELL_CANVAS_DARK);
    setDensity(DEFAULT_DENSITY);
    setMotion(DEFAULT_MOTION);
    setStyleMode("default");
    const r = document.documentElement;
    r.style.fontSize = "";
    r.style.removeProperty("--card-lift");
    r.style.removeProperty("--card-ring");
    r.style.removeProperty("--shell-canvas");
    for (const k of ["--lh-tight", "--lh-snug", "--lh-body"]) r.style.removeProperty(k);
    for (const k of ["--surface-pad", "--surface-pad-sm", "--page-pad", "--section-gap", "--card-gap", "--motion-fast", "--motion-slow"]) r.style.removeProperty(k);
    r.removeAttribute("data-style");
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  };
  const active = mode === "dark" ? dark : light;
  const setActiveColor = (k: ColorKey, v: Oklch) => (mode === "dark" ? setDark : setLight)((p) => ({ ...p, [k]: v }));
  const activeShellCanvas = mode === "dark" ? shellCanvasDark : shellCanvasLight;
  const setActiveShellCanvas = (v: Oklch) => (mode === "dark" ? setShellCanvasDark : setShellCanvasLight)(v);
  const setTier = (i: number, patch: Partial<Tier>) => setTiers((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3 shrink-0">
        <h1 className="text-h2">主题调试台</h1>
        {/* 风格选择器 */}
        <div className="flex overflow-hidden rounded-md border border-border text-meta">
          <button onClick={() => handleStyleModeChange("default")} className={styleMode === "default" ? "bg-primary px-3 py-1 text-primary-foreground" : "px-3 py-1 text-muted-foreground"}>默认</button>
          <button onClick={() => handleStyleModeChange("linear")} className={styleMode === "linear" ? "bg-primary px-3 py-1 text-primary-foreground" : "px-3 py-1 text-muted-foreground"}>Linear</button>
        </div>
        {/* 明暗切换 */}
        <div className="flex overflow-hidden rounded-md border border-border text-meta">
          <button onClick={() => setMode("light")} className={mode === "light" ? "bg-primary px-3 py-1 text-primary-foreground" : "px-3 py-1 text-muted-foreground"}>亮</button>
          <button onClick={() => setMode("dark")} className={mode === "dark" ? "bg-primary px-3 py-1 text-primary-foreground" : "px-3 py-1 text-muted-foreground"}>暗</button>
        </div>
        <span className="text-meta text-muted-foreground">
          风格「{styleMode === "linear" ? "Linear" : "默认"}」· 编辑「{mode === "dark" ? "暗色" : "亮色"}」· 预览开关，刷新后回到设置页所选风格
        </span>
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

          {/* 外壳组：--shell-canvas */}
          <section className="flex flex-col gap-3">
            <h2 className="text-title">外壳（明暗各调）</h2>
            {styleMode === "linear" ? (
              <ColorControl
                label={`窗口背板 --shell-canvas（${mode === "dark" ? "暗" : "亮"}）`}
                value={activeShellCanvas}
                onChange={setActiveShellCanvas}
              />
            ) : (
              <p className="text-caption text-muted-foreground rounded-lg border border-border p-3">
                默认风格下 <code>--shell-canvas</code> 继承自 <code>--background</code>，切换至 <strong>Linear</strong> 风格后可编辑。
              </p>
            )}
          </section>

          {/* 密度组：五件套 rem */}
          <section className="flex flex-col gap-2">
            <h2 className="text-title">密度（rem · 明暗共用）</h2>
            <Field label="surface-pad" unit="rem" value={density.surfacePad} min={0} max={2} step={0.125} onChange={(v) => setDensity((d) => ({ ...d, surfacePad: v }))} />
            <Field label="surface-pad-sm" unit="rem" value={density.surfacePadSm} min={0} max={2} step={0.125} onChange={(v) => setDensity((d) => ({ ...d, surfacePadSm: v }))} />
            <Field label="page-pad" unit="rem" value={density.pagePad} min={0} max={3} step={0.125} onChange={(v) => setDensity((d) => ({ ...d, pagePad: v }))} />
            <Field label="section-gap" unit="rem" value={density.sectionGap} min={0} max={3} step={0.125} onChange={(v) => setDensity((d) => ({ ...d, sectionGap: v }))} />
            <Field label="card-gap" unit="rem" value={density.cardGap} min={0} max={2} step={0.125} onChange={(v) => setDensity((d) => ({ ...d, cardGap: v }))} />
            <p className="text-caption text-muted-foreground">密度调整后 cockpit 间距实时可见；p-page 等工具类走 var 链。</p>
          </section>

          {/* 动效组：fast / slow ms */}
          <section className="flex flex-col gap-2">
            <h2 className="text-title">动效（ms · 明暗共用）</h2>
            <Field label="motion-fast" unit="ms" value={motion.fast} min={0} max={500} step={10} onChange={(v) => setMotion((m) => ({ ...m, fast: v }))} />
            <Field label="motion-slow" unit="ms" value={motion.slow} min={0} max={1000} step={10} onChange={(v) => setMotion((m) => ({ ...m, slow: v }))} />
            <p className="text-caption text-muted-foreground">调整后 hover 过渡/入场动画实时变化。</p>
          </section>

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

          {/* ── Surface 原语展示区（WP8a）──
               唯一允许在 className 直写外观类做对照的页面；行内豁免 ESLint 护栏。
               每格：variant 名 + 对应 token + 视觉预览。 */}
          <section className="flex flex-col gap-2">
            <p className="text-meta text-muted-foreground">Surface 原语 · 变体全组合（随主题实时变化）</p>
            {/* level × shape 组合网格 */}
            <div className="grid grid-cols-4 gap-2 text-caption">
              {/* 表头 */}
              <div className="col-span-4 grid grid-cols-4 gap-2 text-muted-foreground font-medium">
                <span></span>
                <span>shape=control <code className="text-[10px]">rounded-md</code></span>
                <span>shape=card <code className="text-[10px]">rounded-lg</code></span>
                <span>shape=pill <code className="text-[10px]">rounded-full</code></span>
              </div>
              {/* level=page */}
              <span className="self-center text-muted-foreground">level=page <code className="text-[10px]">bg-background</code></span>
              <Surface level="page" edge="hairline" shape="control" className="p-3 text-meta">page · hairline · control</Surface>
              <Surface level="page" edge="hairline" shape="card" className="p-3 text-meta">page · hairline · card</Surface>
              <Surface level="page" edge="hairline" shape="pill" className="px-3 py-1.5 text-meta">page · pill</Surface>
              {/* level=card */}
              <span className="self-center text-muted-foreground">level=card <code className="text-[10px]">bg-card + elev-1</code></span>
              <Surface level="card" edge="hairline" shape="control" className="p-3 text-meta">card · hairline · control</Surface>
              <Surface level="card" edge="hairline" shape="card" className="p-3 text-meta">card · hairline · card（默认）</Surface>
              <Surface level="card" edge="none" shape="pill" className="px-3 py-1.5 text-meta">card · none · pill</Surface>
              {/* level=panel */}
              <span className="self-center text-muted-foreground">level=panel <code className="text-[10px]">bg-card + elev-1</code></span>
              <Surface level="panel" edge="hairline" shape="control" className="p-3 text-meta">panel · hairline · control</Surface>
              <Surface level="panel" edge="strong" shape="panel" className="p-3 text-meta">panel · strong · panel</Surface>
              <Surface level="panel" edge="hairline" shape="chip" className="px-2 py-1 text-meta">panel · chip <code className="text-[10px]">0.25rem</code></Surface>
              {/* level=overlay */}
              <span className="self-center text-muted-foreground">level=overlay <code className="text-[10px]">bg-popover + elev-3</code></span>
              <Surface level="overlay" edge="hairline" shape="overlay" className="p-3 text-meta">overlay · hairline · overlay</Surface>
              <Surface level="overlay" edge="none" shape="card" className="p-3 text-meta">overlay · none · card</Surface>
              <Surface level="overlay" edge="hairline" shape="pill" className="px-3 py-1.5 text-meta">overlay · pill</Surface>
            </div>
            {/* inset 阴影演示 */}
            <div className="flex gap-3 items-start">
              <Surface level="card" edge="hairline" shape="card" inset className="p-3 text-meta flex-1">inset=true（主内容内嵌阴影，左侧投影）</Surface>
              <Surface level="card" edge="hairline" shape="card" className="p-3 text-meta flex-1">inset=false（默认 elevation-1）</Surface>
            </div>
            <p className="text-caption text-muted-foreground">
              token 对应：chip → <code>--radius-chip: 0.25rem</code>；elevation → <code>--elevation-1/2/3</code>；边框 → <code>--color-border</code>
            </p>
          </section>

          <section className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <p className="text-meta text-muted-foreground">
                导出 / 编辑片段（可直接改,实时生效;
                {styleMode === "linear" ? "Linear 风格覆盖块,按行合并回 globals.css 风格挂载区(勿整块替换)" : "含亮/暗两块,粘回 app/globals.css"}）
              </p>
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
      <span className="w-28 shrink-0 text-muted-foreground">{label}{unit ? ` (${unit})` : ""}</span>
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
