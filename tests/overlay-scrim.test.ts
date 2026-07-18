import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const src = (file: string) => readFileSync(path.join(root, file), "utf8");

export const overlayScrimTestPromise = (async () => {
  const globals = src("app/globals.css");
  const tokens = src("app/styles/tokens.css");
  assert.match(tokens, /--scrim-modal:\s*color-mix\([^;]+8%/, "应定义 8% 常规模态遮罩 token");
  assert.match(tokens, /--scrim-blocking:\s*color-mix\([^;]+16%/, "应定义 16% 阻塞遮罩 token");
  assert.ok(globals.includes("--color-scrim-modal: var(--scrim-modal)"), "常规模态 token 应暴露为 Tailwind 语义色");
  assert.ok(globals.includes("--color-scrim-blocking: var(--scrim-blocking)"), "阻塞 token 应暴露为 Tailwind 语义色");

  const modalFiles = [
    "components/ui/dialog.tsx",
    "components/ui/sheet.tsx",
    "app/shared/global-search-dialog.tsx",
    "app/shared/global-shortcuts.tsx",
  ];
  for (const file of modalFiles) {
    assert.ok(src(file).includes("bg-scrim-modal"), `${file} 应使用常规模态遮罩`);
  }

  for (const file of ["components/ui/alert-dialog.tsx", "app/shared/first-run-gate.tsx"]) {
    assert.ok(src(file).includes("bg-scrim-blocking"), `${file} 应使用阻塞遮罩`);
  }

  const overlaySources = [...modalFiles, "components/ui/alert-dialog.tsx", "app/shared/first-run-gate.tsx"]
    .map((file) => src(file))
    .join("\n");
  assert.doesNotMatch(overlaySources, /bg-black\/(?:50|80)|bg-foreground\/8|backdrop-blur-(?:xs|sm)/, "全屏遮罩不得绕过语义 token");

  console.log("overlay-scrim: semantic modal/blocking tokens wired ✓");
})();
