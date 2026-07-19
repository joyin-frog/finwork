import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// 窗口壳层排布契约（docs/spec/design-window-chrome-integration.md 2026-07-19 决策覆盖）：
// Windows 标题栏横贯全窗，侧栏与主工作区一起从标题栏下方开始；侧栏内部顶栏保持正常高度；
// macOS 零变化；已删标签栏的僵尸 Token 清除；原生窗口标题修复。

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const windowChromeLayoutTestPromise = (async () => {
  const shell = read("app/shared/app-shell.tsx");

  // 壳层顺序：WindowTitleBar 是根外壳首项；AppNav 与 app-workspace 位于其后的横排 body 内。
  const navIdx = shell.indexOf("<AppNav");
  const bodyIdx = shell.indexOf('<div className="app-shell-body');
  const workspaceIdx = shell.indexOf("app-workspace");
  const titlebarIdx = shell.indexOf("<WindowTitleBar");
  const mainIdx = shell.indexOf("<main");
  assert.ok(navIdx > -1, "AppShell 应渲染 AppNav");
  assert.ok(titlebarIdx > -1 && titlebarIdx < bodyIdx, "WindowTitleBar 应位于 app-shell-body 之前并横贯全窗");
  assert.ok(navIdx > bodyIdx, "AppNav 应位于 app-shell-body 内");
  assert.ok(workspaceIdx > navIdx, "app-workspace 应位于 AppNav 之后（横排同级）");
  assert.ok(mainIdx > workspaceIdx, "main 应位于 app-workspace 内");

  const bodyClassMatch = shell.match(/className="([^"]*\bapp-shell-body\b[^"]*)"/);
  assert.ok(bodyClassMatch, "应存在 .app-shell-body 横排层");
  for (const cls of ["flex", "flex-1", "min-h-0", "min-w-0"]) {
    assert.ok(bodyClassMatch![1].includes(cls), `app-shell-body 必须含 ${cls}`);
  }

  // main 变为纵排主轴子项，必须补 min-h-0，否则长内容页把 main 撑出视口、overflow-auto 失效。
  const mainClassMatch = shell.match(/<main[^>]*className="([^"]*)"/s);
  assert.ok(mainClassMatch, "main 应有 className");
  assert.ok(mainClassMatch![1].includes("min-h-0"), "main 必须含 min-h-0（flex 纵排滚动硬约束）");

  // 工作区包装层几何中性：只允许布局穿透类，禁止 margin/padding/transform/滚动容器/堆叠上下文属性。
  const workspaceClassMatch = shell.match(/className="([^"]*\bapp-workspace\b[^"]*)"/);
  assert.ok(workspaceClassMatch, "应存在 .app-workspace 包装层");
  const allowed = new Set(["app-workspace", "flex", "flex-1", "min-w-0", "min-h-0", "flex-col"]);
  for (const cls of workspaceClassMatch![1].split(/\s+/).filter(Boolean)) {
    assert.ok(allowed.has(cls), `app-workspace 仅允许几何中性类，发现越界类：${cls}`);
  }

  // 标题栏独占窗口系统几何 Token；侧栏位于其下方，内部顶栏不得再被 Windows 强行同步高度。
  const globals = read("app/globals.css");
  assert.match(globals, /--window-chrome-height:\s*2\.5rem/, "应声明 --window-chrome-height: 2.5rem");
  assert.match(
    globals,
    /\.app-titlebar\s*\{[^}]*height:\s*var\(--window-chrome-height\)/s,
    ".app-titlebar 高度应消费 --window-chrome-height"
  );
  assert.doesNotMatch(
    globals,
    /:root\[data-platform="windows"\] \.app-nav-topbar\s*\{[^}]*height:\s*var\(--window-chrome-height\)/s,
    "Windows 侧栏顶栏不得再消费窗口标题栏高度 Token"
  );

  // 标题栏现在横贯全窗，现代风格也以一条细线明确分隔窗口栏与应用内容。
  assert.match(
    globals,
    /\[data-style='linear'\] \.app-titlebar\s*\{[^}]*border-bottom:\s*1px solid var\(--border\)/s,
    "现代风格标题栏应保留与应用内容的细分隔线"
  );

  // 僵尸 Token 清理：已删标签栏遗留的 --window-controls-inset 不得残存。
  assert.doesNotMatch(globals, /--window-controls-inset/, "僵尸 Token --window-controls-inset 应全部删除");

  // 组件内不再写死窗口几何：高度/分隔线/尾部留白全部下放 CSS。
  const controls = read("app/shared/window-controls.tsx");
  assert.match(controls, />Finwork</, "Windows 标题栏左侧应显示产品名称 Finwork");
  assert.match(controls, /src="\/icon\.svg"/, "Windows 标题栏应复用正式品牌图标");
  assert.doesNotMatch(controls, /\bh-8\b/, "标题栏高度不得写死在组件（应走 Token）");
  assert.doesNotMatch(controls, /border-b\b/, "分隔线不得写死在组件（应走风格映射）");
  assert.doesNotMatch(controls, /\bpr-1\b/, "关闭按钮点击区必须触达右缘，不得留 pr-1");
  assert.match(controls, /z-\[60\]/, "标题栏必须保留 z-[60]（压过全屏模态，任何时候可关窗）");
  assert.match(controls, /data-tauri-drag-region/, "标题栏必须保留拖动区标记");

  // Tooltip 全局默认保持中性；侧栏顶栏就地加 side=right + collisionPadding，避免伸入 Windows 标题栏。
  const tooltip = read("components/ui/tooltip.tsx");
  assert.match(tooltip, /<TooltipPrimitive\.Portal>/, "Tooltip 必须经 Portal 脱离页面 overflow 容器");
  assert.doesNotMatch(tooltip, /side\s*=\s*"bottom"/, "不得把 side=bottom 写进全局 Tooltip 默认");
  assert.doesNotMatch(tooltip, /z-\[70\]/, "不得抬高全局 Tooltip z-index 去迁就标题栏");
  const navTop = read("app/shared/nav-top-controls.tsx");
  assert.match(navTop, /side="right"/, "侧栏顶栏 ShortcutHint 应 side=right，不向上伸入标题栏");
  assert.match(navTop, /collisionPadding=\{8\}/, "侧栏顶栏 ShortcutHint 应带 collisionPadding");
  assert.match(navTop, /sideOffset=\{6\}/, "侧栏顶栏 ShortcutHint 应带 sideOffset");

  // macOS 零变化：侧栏顶栏继续 h-11，不因 Windows 统一高度被顺手改掉。
  const nav = read("app/shared/app-nav.tsx");
  assert.match(nav, /app-nav-topbar[^"]*\bh-11\b|"[^"]*\bh-11\b[^"]*app-nav-topbar/, "macOS 侧栏顶栏应保持 h-11");

  // 原生窗口标题修复：conf 的 title 因 create:false 不生效，必须在建窗链上设置。
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /\.title\("Finwork"\)/, "建窗链应设置原生标题 Finwork（Alt-Tab/任务栏悬停可见）");
  assert.doesNotMatch(lib, /\.title\(""\)/, "不得残留空原生标题");

  console.log("window-chrome-layout: 壳层排布、统一几何与随行清理契约 ✓");
})();
