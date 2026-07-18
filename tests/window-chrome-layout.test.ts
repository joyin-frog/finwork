import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// 窗口壳层排布契约（docs/spec/design-window-chrome-integration.md §4.1/§4.2/§4.6）：
// 侧栏与主工作区同级横排，Windows 标题栏收进工作区列；经典/现代共享同一窗口几何 Token；
// macOS 零变化；已删标签栏的僵尸 Token 清除；原生窗口标题修复。

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const windowChromeLayoutTestPromise = (async () => {
  const shell = read("app/shared/app-shell.tsx");

  // 壳层顺序：AppNav 在前，app-workspace 其后；WindowTitleBar 在工作区内且位于 main 之前。
  const navIdx = shell.indexOf("<AppNav");
  const workspaceIdx = shell.indexOf("app-workspace");
  const titlebarIdx = shell.indexOf("<WindowTitleBar");
  const mainIdx = shell.indexOf("<main");
  assert.ok(navIdx > -1, "AppShell 应渲染 AppNav");
  assert.ok(workspaceIdx > navIdx, "app-workspace 应位于 AppNav 之后（横排同级）");
  assert.ok(titlebarIdx > workspaceIdx, "WindowTitleBar 应移入 app-workspace 内");
  assert.ok(mainIdx > titlebarIdx, "main 应位于 WindowTitleBar 之后");

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

  // 统一几何 Token：标题栏与 Windows 侧栏顶栏消费同一 --window-chrome-height，禁止双份常量。
  const globals = read("app/globals.css");
  assert.match(globals, /--window-chrome-height:\s*2\.5rem/, "应声明 --window-chrome-height: 2.5rem");
  assert.match(
    globals,
    /\.app-titlebar\s*\{[^}]*height:\s*var\(--window-chrome-height\)/s,
    ".app-titlebar 高度应消费 --window-chrome-height"
  );
  assert.match(
    globals,
    /:root\[data-platform="windows"\] \.app-nav-topbar\s*\{[^}]*height:\s*var\(--window-chrome-height\)/s,
    "Windows 侧栏顶栏应消费同一高度 Token"
  );

  // 现代风格无第二条分隔线：分隔策略在 CSS 风格映射，现代置 none。
  assert.match(
    globals,
    /\[data-style='linear'\] \.app-titlebar\s*\{[^}]*border-bottom:\s*none/s,
    "现代风格标题栏不得有独立分隔线（由主卡上边界分层）"
  );

  // 僵尸 Token 清理：已删标签栏遗留的 --window-controls-inset 不得残存。
  assert.doesNotMatch(globals, /--window-controls-inset/, "僵尸 Token --window-controls-inset 应全部删除");

  // 组件内不再写死窗口几何：高度/分隔线/尾部留白全部下放 CSS。
  const controls = read("app/shared/window-controls.tsx");
  assert.doesNotMatch(controls, /\bh-8\b/, "标题栏高度不得写死在组件（应走 Token）");
  assert.doesNotMatch(controls, /border-b\b/, "分隔线不得写死在组件（应走风格映射）");
  assert.doesNotMatch(controls, /\bpr-1\b/, "关闭按钮点击区必须触达右缘，不得留 pr-1");
  assert.match(controls, /z-\[60\]/, "标题栏必须保留 z-[60]（压过全屏模态，任何时候可关窗）");
  assert.match(controls, /data-tauri-drag-region/, "标题栏必须保留拖动区标记");

  // macOS 零变化：侧栏顶栏继续 h-11，不因 Windows 统一高度被顺手改掉。
  const nav = read("app/shared/app-nav.tsx");
  assert.match(nav, /app-nav-topbar[^"]*\bh-11\b|"[^"]*\bh-11\b[^"]*app-nav-topbar/, "macOS 侧栏顶栏应保持 h-11");

  // 原生窗口标题修复：conf 的 title 因 create:false 不生效，必须在建窗链上设置。
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /\.title\("Finwork"\)/, "建窗链应设置原生标题 Finwork（Alt-Tab/任务栏悬停可见）");
  assert.doesNotMatch(lib, /\.title\(""\)/, "不得残留空原生标题");

  console.log("window-chrome-layout: 壳层排布、统一几何与随行清理契约 ✓");
})();
