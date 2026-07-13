import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

export const animationMotionContractTestPromise = (async () => {
  const primitives = ["button", "toggle", "switch", "badge", "accordion", "navigation-menu", "tabs"];
  for (const primitive of primitives) {
    assert.ok(!src(`components/ui/${primitive}.tsx`).includes("transition-all"), `${primitive} must not animate every property`);
  }

  const shortcuts = src("app/shared/global-shortcuts.tsx");
  const search = src("app/shared/global-search-dialog.tsx");
  assert.match(shortcuts, /searchInstant/);
  assert.match(shortcuts, /helpInstant/);
  assert.match(search, /instant\?: boolean/);
  assert.match(search, /!instant/);

  const { scheduleDialogMotionReset } = await import("../app/shared/global-shortcuts.tsx");
  let scheduled: FrameRequestCallback | undefined;
  let resetCount = 0;
  const cancelHandles: number[] = [];
  const cleanup = scheduleDialogMotionReset(
    false,
    () => { resetCount += 1; },
    (callback) => { scheduled = callback; return 17; },
    (handle) => { cancelHandles.push(handle); },
  );
  assert.equal(resetCount, 0, "instant state must survive the closed render");
  scheduled?.(0);
  assert.equal(resetCount, 1, "instant state resets after the closed render lifecycle");
  cleanup?.();
  assert.deepEqual(cancelHandles, [17]);
  assert.equal(scheduleDialogMotionReset(true, () => { resetCount += 1; }), undefined);

  const toolSteps = src("app/components/tool-call-step.tsx");
  assert.match(toolSteps, /useReducedMotion/);
  assert.ok(!toolSteps.includes('height: "auto"'), "tool detail must not tween auto height");
  assert.match(src("app/components/ask-user-card.tsx"), /useReducedMotion/);
  assert.ok(!src("components/ui/message-scroller.tsx").includes("duration-400"));

  const progress = src("components/ui/progress.tsx");
  const updater = src("app/config/general/updater-settings.tsx");
  for (const source of [progress, updater]) {
    assert.match(source, /scaleX/);
    assert.match(source, /motion-reduce:transition-none/);
    assert.ok(!source.includes("transition-all"));
  }
  assert.match(progress, /Math\.min\(100, Math\.max\(0/);

  const nav = src("app/shared/app-nav.tsx");
  assert.ok(!nav.includes("transition-[width]"));
  assert.match(nav, /layoutId="nav-active-pill"/);
  assert.match(nav, /useReducedMotion/);
  assert.match(nav, /collapsed \? "overflow-visible pointer-events-none"/);
  assert.match(nav, /z-\[-1\]/, "active pill must paint below link content inside the isolated stacking context");
  assert.match(nav, /inert=\{collapsed \? true : undefined\}/, "collapsed navigation descendants must not remain focusable");
  assert.match(nav, /style=\{\{ width: navWidth \}\}/);

  const presets = src("app/shared/motion-presets.ts");
  assert.match(presets, /translateY\(8px\)/);
  assert.match(presets, /translateY\(4px\) scale\(0\.96\)/);
  assert.ok(!/hidden: \{ opacity: 0, (?:scale|y):/.test(presets));

  const preview = src("app/shared/resizable-preview-panel.tsx");
  assert.match(preview, /AnimatePresence/);
  assert.match(preview, /mode="popLayout"/, "exiting preview columns must not keep participating in flex layout");
  assert.match(preview, /translateX\(2%\)/);
  assert.match(preview, /dragging \? 0/);
  assert.match(preview, /!maximized &&/);
  assert.ok(!preview.includes('maximized && "hidden"'));

  const { restorePreviewFocus } = await import("../app/shared/resizable-preview-panel.tsx");
  let focusCount = 0;
  const connectedElement = {} as Element;
  const focusRoot = {
    contains: (element: Node | null) => element === connectedElement,
    focus: () => { focusCount += 1; },
  };
  assert.equal(restorePreviewFocus(focusRoot, connectedElement, true), false, "focus still inside must be preserved");
  assert.equal(restorePreviewFocus(focusRoot, null, true), true, "removed focused content must fall back to the panel root");
  assert.equal(focusCount, 1);
  assert.equal(restorePreviewFocus(focusRoot, null, false), false, "unfocused panel changes must not steal focus");

  console.log("animation-motion-contract: all assertions passed ✓");
})();
