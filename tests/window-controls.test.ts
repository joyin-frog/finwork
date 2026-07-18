import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Windows 三件套行为契约（docs/spec/design-window-chrome-integration.md §4.3/§4.4）。
// 说明：仓库测试链无 jsdom / testing-library（package.json 无此依赖），无法可靠挂载
// 依赖 @tauri-apps/api 运行时的客户端组件，故按 Spec §5 的兜底走源码契约断言：
// 锁定「按钮 → Window API」接线、最大化状态同步与点击几何，真实功能以 Windows 打包冒烟收口。

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

export const windowControlsTestPromise = (async () => {
  const controls = read("app/shared/window-controls.tsx");

  // 三枚按钮的功能接线保持不变：最小化 / 最大化还原切换 / 关闭。
  assert.match(
    controls,
    /aria-label="最小化"[^>]*onClick=\{\(\) => win && void win\.minimize\(\)\}|aria-label="最小化"[\s\S]{0,200}?win\.minimize\(\)/,
    "最小化按钮应调用 win.minimize()"
  );
  assert.match(
    controls,
    /aria-label=\{maximized \? "还原" : "最大化"\}[\s\S]{0,200}?win\.toggleMaximize\(\)/,
    "中键应按最大化态切换语义并调用 win.toggleMaximize()"
  );
  assert.match(
    controls,
    /aria-label="关闭"[\s\S]{0,300}?win\.close\(\)/,
    "关闭按钮应调用 win.close()"
  );

  // 最大化状态同步：初值 isMaximized() + onResized 订阅 + 卸载清理。
  assert.match(controls, /win\.isMaximized\(\)\.then\(setMaximized\)/, "应以 isMaximized() 初始化状态");
  assert.match(controls, /\.onResized\(/, "应订阅 onResized 同步最大化态");
  assert.match(controls, /unlisten\?\.\(\)/, "卸载时应清理 onResized 监听");

  // 图标随状态切换，且尺寸符合 §4.3（常规 14px=size-3.5，还原双框 13px）。
  assert.match(controls, /maximized \? Copy01Icon : AppWindowIcon/, "中键图标应随最大化态切换");
  assert.match(controls, /size-3\.5/, "常规图标应为 14px（size-3.5）");
  assert.match(controls, /size-\[13px\]/, "还原图标应为 13px");

  // 点击几何：44×40 且贴满标题栏高度（Fitts：最大化态屏幕右上角像素命中关闭）。
  const globals = read("app/globals.css");
  assert.match(
    globals,
    /\.app-titlebar \.app-titlebar-btn\s*\{[^}]*width:\s*2\.75rem[^}]*height:\s*100%[^}]*border-radius:\s*0/s,
    "三键点击区应为 44px 宽、贴满 40px 标题栏高、直角贴边"
  );
  assert.match(controls, /app-titlebar-btn/, "三键应挂 .app-titlebar-btn 点击几何类");

  // 关闭按钮 hover/focus-visible 走 destructive 语义色，常态保持普通前景色。
  // 不依赖 JSX 属性顺序：先定位含 aria-label="关闭" 的 Button 块，再断言其属性内含 destructive 类。
  const closeButtonBlock = controls
    .split("<Button")
    .find((chunk) => chunk.slice(0, chunk.indexOf(">")).includes('aria-label="关闭"'));
  assert.ok(closeButtonBlock, "应存在 aria-label=关闭 的按钮");
  assert.ok(
    closeButtonBlock!.slice(0, closeButtonBlock!.indexOf(">")).includes("hover:bg-destructive"),
    "关闭按钮 hover 应使用 destructive 语义色"
  );

  // 双击切换最大化依赖 Tauri 拖动区内建行为，不得再绑 onDoubleClick 造成双触发。
  assert.doesNotMatch(controls, /onDoubleClick=/, "不得手写 onDoubleClick 绑定（Tauri 拖动区已内建双击切换）");

  console.log("window-controls: 三键接线、状态同步与点击几何契约 ✓");
})();
