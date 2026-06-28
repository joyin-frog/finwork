import assert from "node:assert/strict";

import {
  CHAT_SIDEBAR_DIVIDER_WIDTH,
  getDefaultSidebarWidth,
  getPanelRightOffset,
  shouldAutoOpenOutputPanel,
  shouldDefaultOpenFilePanel
} from "../app/chat/file-workspace-state";

function main() {
  assert.equal(shouldDefaultOpenFilePanel(0), false, "panel should stay closed when the conversation has no files");
  assert.equal(shouldDefaultOpenFilePanel(3), true, "panel should default open when the conversation has files");

  assert.equal(shouldAutoOpenOutputPanel(0, 1), true, "new outputs should auto-open the panel");
  assert.equal(shouldAutoOpenOutputPanel(2, 2), false, "unchanged output count should not auto-open the panel");

  assert.equal(getDefaultSidebarWidth(1000), Math.round((1000 - CHAT_SIDEBAR_DIVIDER_WIDTH) / 2), "default sidebar width should split the workspace 1:1");
  assert.equal(getDefaultSidebarWidth(200), 200, "sidebar width should respect the minimum width guard");

  assert.equal(getPanelRightOffset(true, 480), 0, "collapsed sidebar should not shift the panel popover");
  assert.equal(getPanelRightOffset(false, 480), 485, "open sidebar should push the panel popover to the chat edge");

  console.log("✓ PASS: chat panel state helpers cover default open, auto-open, 1:1 width and panel alignment");
}

main();
