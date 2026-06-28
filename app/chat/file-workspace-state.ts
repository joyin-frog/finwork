export const CHAT_SIDEBAR_DIVIDER_WIDTH = 5;

/** 拖拽分宽时聊天列至少保留的宽度:低于此输入框会被挤塌,所以预览不能拖到几乎全覆盖(全屏走「放大」按钮)。 */
export const MIN_CHAT_COLUMN_WIDTH = 420;

/** 拖拽时预览列的最大宽度:留够 MIN_CHAT_COLUMN_WIDTH 给聊天列;容器过窄时回落到 200 下限。 */
export function getMaxSidebarWidth(containerWidth: number, dividerWidth = CHAT_SIDEBAR_DIVIDER_WIDTH) {
  return Math.max(200, containerWidth - dividerWidth - MIN_CHAT_COLUMN_WIDTH);
}

export function shouldDefaultOpenFilePanel(fileCount: number) {
  return fileCount > 0;
}

export function shouldAutoOpenOutputPanel(previousOutputCount: number, nextOutputCount: number) {
  return nextOutputCount > previousOutputCount;
}

export function getDefaultSidebarWidth(containerWidth: number, dividerWidth = CHAT_SIDEBAR_DIVIDER_WIDTH) {
  const availableWidth = Math.max(0, containerWidth - dividerWidth);
  return Math.max(200, Math.round(availableWidth / 2));
}

export function getPanelRightOffset(sidebarCollapsed: boolean, sidebarWidth: number, dividerWidth = CHAT_SIDEBAR_DIVIDER_WIDTH) {
  return sidebarCollapsed ? 0 : Math.max(0, sidebarWidth + dividerWidth);
}
