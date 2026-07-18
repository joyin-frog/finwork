import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const appTabBarRemovalTestPromise = (async () => {
  assert.equal(existsSync(path.join(root, "app/shared/app-tab-bar.tsx")), false, "现代风格顶部标签栏组件应被删除");

  const shell = read("app/shared/app-shell.tsx");
  assert.doesNotMatch(shell, /AppTabBar|RouteTabSync/, "应用外壳不应再渲染或同步顶部标签栏");

  const globals = read("app/globals.css");
  assert.doesNotMatch(globals, /\.app-tab(?:bar|\b|-)/, "全局样式不应残留顶部标签栏规则");
  assert.doesNotMatch(globals, /\[data-style='linear'\] \.app-nav-topbar\s*\{[^}]*display:\s*none/s, "现代风格应恢复侧栏顶部控制区");
  assert.doesNotMatch(globals, /\[data-style='linear'\] \.app-sidebar-toggle\s*\{[^}]*display:\s*none/s, "现代风格收起侧栏后应恢复页面头部展开按钮");

  const tokens = read("app/styles/tokens.css");
  assert.doesNotMatch(tokens, /--app-tab-/, "颜色主题不应保留已删除标签栏的专用 token");

  const controls = read("app/shared/nav-top-controls.tsx");
  assert.doesNotMatch(controls, /app-tabbar/, "导航控制组件说明不应再引用标签栏");

  const conventions = read("docs/ui-conventions.md");
  assert.match(conventions, /现代风格不使用应用级顶部标签栏/, "UI 约定应记录现代外壳不使用顶部标签栏");

  console.log("app-tab-bar-removal: modern shell uses sidebar navigation only ✓");
})();
