"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("finworkDesktop", {
  platform: process.platform,
  workspaceAuthToken: () => ipcRenderer.invoke("desktop:workspace-auth-token"),
  openDialog: (options) => ipcRenderer.invoke("desktop:open-dialog", options),
  saveDialog: (options) => ipcRenderer.invoke("desktop:save-dialog", options),
  readFile: async (filePath) => {
    const bytes = await ipcRenderer.invoke("desktop:read-file", filePath);
    return Uint8Array.from(bytes);
  },
  readTextFile: (filePath) => ipcRenderer.invoke("desktop:read-text-file", filePath),
  openPath: (target, application) => ipcRenderer.invoke("desktop:open-path", target, application),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  window: {
    minimize: () => ipcRenderer.invoke("desktop:window-minimize"),
    toggleMaximize: () => ipcRenderer.invoke("desktop:window-toggle-maximize"),
    isMaximized: () => ipcRenderer.invoke("desktop:window-is-maximized"),
    close: () => ipcRenderer.invoke("desktop:window-close"),
    forceClose: () => ipcRenderer.invoke("desktop:window-force-close"),
    setCloseGuard: (enabled) => ipcRenderer.invoke("desktop:window-set-close-guard", Boolean(enabled)),
    onMaximizedChanged: (callback) => on("desktop:window-maximized-changed", callback),
    onCloseRequested: (callback) => on("desktop:window-close-requested", callback),
  },
  updater: {
    check: () => ipcRenderer.invoke("desktop:updater-check"),
    download: (onProgress) => {
      const unsubscribe = on("desktop:updater-progress", onProgress);
      return ipcRenderer.invoke("desktop:updater-download").finally(unsubscribe);
    },
    install: () => ipcRenderer.invoke("desktop:updater-install"),
  },
});
