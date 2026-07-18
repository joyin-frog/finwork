import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const styleColorOrthogonalityTestPromise = (async () => {
  const tokenPath = path.join(root, "app/styles/tokens.css");
  assert.ok(existsSync(tokenPath), "颜色主题应由 app/styles/tokens.css 独立承载");

  const globals = read("app/globals.css");
  const tokens = read("app/styles/tokens.css");
  assert.ok(globals.includes('@import "./styles/tokens.css";'), "globals.css 应导入独立颜色 token 模块");

  for (const token of [
    "--background",
    "--foreground",
    "--card",
    "--sidebar",
    "--border",
  ]) {
    assert.match(tokens, new RegExp(`${token.replaceAll("-", "\\-")}\\s*:`), `${token} 应由颜色 token 模块定义`);
  }
  assert.match(tokens, /:root\s*\{/, "颜色模块应定义亮色主题");
  assert.match(tokens, /\.dark\s*\{/, "颜色模块应定义暗色主题");

  const styleMount = globals.slice(globals.indexOf("风格覆盖挂载区"));
  assert.ok(styleMount.length > 0, "globals.css 应保留风格挂载区");
  const colorTokens = [
    "background", "foreground", "primary", "primary-foreground",
    "ring", "card", "card-foreground", "popover", "popover-foreground", "sidebar",
    "muted", "muted-foreground", "accent", "accent-foreground", "border", "input",
    "card-ring",
  ];
  for (const token of colorTokens) {
    assert.doesNotMatch(
      styleMount,
      new RegExp(`--${token}\\s*:`),
      `data-style 挂载区不得定义颜色 token --${token}`,
    );
  }

  assert.match(styleMount, /\[data-style='linear'\]\s*\{[^}]*--radius:/s, "界面风格仍应拥有圆角布局 token");
  assert.match(styleMount, /\[data-style='linear'\]\s*\{[^}]*--surface-pad:/s, "界面风格仍应拥有密度 token");
  assert.match(styleMount, /\[data-style='linear'\] \.app-main/, "界面风格仍应拥有结构规则");

  assert.doesNotMatch(tokens, /--shell-canvas\s*:/, "窗口外壳与侧栏应共用 --sidebar，不再维护第二个颜色 token");
  assert.doesNotMatch(globals, /var\(--shell-canvas\)/, "布局样式不得继续消费独立窗口背板色");

  const linearSidebar = styleMount.match(/\[data-style='linear'\] \.app-side\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.ok(linearSidebar, "现代风格应保留侧栏结构规则");
  assert.doesNotMatch(linearSidebar, /background\s*:/, "现代风格不得改变侧栏的语义取色");
  assert.match(read("app/shared/app-nav.tsx"), /bg-sidebar/, "所有风格的侧栏都应统一消费 --sidebar");

  const shell = read("app/shared/app-shell.tsx");
  assert.match(shell, /app-shell/, "应用最外层应提供统一外壳语义类");
  assert.doesNotMatch(shell, /shell-canvas/, "应用外壳不应继续消费独立背板色");
  assert.match(styleMount, /\[data-style='linear'\] \.app-shell\s*\{[^}]*background:\s*var\(--sidebar\)/s, "现代模式的外圈底层应与侧栏共用 --sidebar");
  assert.match(styleMount, /\[data-style='linear'\] \.app-titlebar\s*\{[^}]*background:\s*var\(--sidebar\)/s, "现代模式标题栏应与侧栏共用 --sidebar");

  const playground = read("app/dev/theme/theme-playground.tsx");
  assert.ok(playground.includes("app/styles/tokens.css"), "主题调试台应把颜色导出到独立 token 模块");
  assert.doesNotMatch(playground, /html\.dark\[data-style='linear'\][^{]*\{[^}]*COLOR_KEYS/s, "主题调试台不得生成风格专属配色");
  assert.doesNotMatch(playground, /shell-canvas/i, "主题调试台不应再提供独立窗口背板颜色");

  console.log("style-color-orthogonality: color theme and layout style are independent ✓");
})();
