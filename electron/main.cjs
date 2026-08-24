"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const { createReadAccessPolicy, pathIsWithin } = require("./file-access.cjs");
const {
  generateBootId,
  generateWorkspaceAuthToken,
  isAllowedExternalUrl,
  openNextServerLog,
  processTreeTerminationPlan,
  resolveAppDataDir,
  resolveServerPort,
  writeWorkspaceAuthToken,
} = require("./runtime.cjs");

const BUILTIN_TELEMETRY_ENDPOINT = typeof __FINWORK_TELEMETRY_ENDPOINT__ === "string" ? __FINWORK_TELEMETRY_ENDPOINT__ : "";
const BUILTIN_TELEMETRY_TOKEN = typeof __FINWORK_TELEMETRY_TOKEN__ === "string" ? __FINWORK_TELEMETRY_TOKEN__ : "";

const SPLASH_URL = "data:text/html,<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;height:100%;background:rgb(250,250,250)}.wrap{height:100%;display:flex;align-items:center;justify-content:center}.spin{width:28px;height:28px;border:3px solid rgb(225,225,228);border-top-color:rgb(90,90,100);border-radius:999px;animation:r .8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class='wrap'><div class='spin'></div></div></body></html>";
const SERVER_ERROR_URL = "data:text/html,<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;height:100%;background:rgb(250,250,250);font-family:system-ui;color:rgb(45,45,50)}.wrap{height:100%;display:flex;align-items:center;justify-content:center}.card{text-align:center;max-width:460px;padding:32px}.title{font-size:20px;font-weight:600;margin-bottom:12px}.body{font-size:14px;line-height:1.7;color:rgb(95,95,105)}</style></head><body><div class='wrap'><div class='card'><div class='title'>Finwork 服务未能恢复</div><div class='body'>请完全退出 Finwork 后重新打开。诊断信息已写入应用日志。</div></div></div></body></html>";

let mainWindow = null;
let serverProcess = null;
let serverLog = null;
let shuttingDown = false;
let closeGuardEnabled = false;
let forceClosing = false;
let trustedOrigin = "http://127.0.0.1:3000";
let workspaceAuthToken = "";
let restartAttempted = false;
let readAccessPolicy = null;

function stopProcessTree(child) {
  if (!child) return;
  const plan = processTreeTerminationPlan(process.platform, child.pid);
  try {
    if (plan?.kind === "command") {
      const result = spawnSync(plan.command, plan.args, { windowsHide: true, stdio: "ignore" });
      if (result.status === 0) return;
    } else if (plan?.kind === "signal") {
      process.kill(plan.pid, plan.signal);
      return;
    }
  } catch {
    // 父进程可能已自行退出；下面仍尝试结束直接子进程。
  }
  try { child.kill(); } catch { /* already gone */ }
}

function log(message) {
  const line = `[electron-host] ${new Date().toISOString()} ${message}\n`;
  if (serverLog) serverLog.write(line);
  if (!app.isPackaged) process.stderr.write(line);
}

function senderIsTrusted(event) {
  const url = event.senderFrame?.url || event.sender?.getURL?.() || "";
  return url.startsWith(`${trustedOrigin}/`) || url === trustedOrigin;
}

function urlIsTrusted(url) {
  return url === trustedOrigin || url.startsWith(`${trustedOrigin}/`);
}

function guardIpc(handler) {
  return async (event, ...args) => {
    if (!senderIsTrusted(event)) throw new Error("Rejected IPC from an untrusted renderer");
    return handler(event, ...args);
  };
}

function currentWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

function normalizeDialogFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  return filters.map((filter) => ({
    name: String(filter?.name || "文件"),
    extensions: Array.isArray(filter?.extensions) ? filter.extensions.map(String) : ["*"],
  }));
}

function registerIpc() {
  ipcMain.handle("desktop:workspace-auth-token", guardIpc(async () => workspaceAuthToken));
  ipcMain.handle("desktop:open-dialog", guardIpc(async (event, options = {}) => {
    const properties = [];
    if (options.directory) properties.push("openDirectory");
    else properties.push("openFile");
    if (options.multiple) properties.push("multiSelections");
    const result = await dialog.showOpenDialog(currentWindow(event), {
      title: typeof options.title === "string" ? options.title : undefined,
      filters: normalizeDialogFilters(options.filters),
      properties,
    });
    if (result.canceled) return null;
    await readAccessPolicy.grant(result.filePaths, { directory: Boolean(options.directory) });
    return options.multiple ? result.filePaths : (result.filePaths[0] || null);
  }));
  ipcMain.handle("desktop:save-dialog", guardIpc(async (event, options = {}) => {
    const result = await dialog.showSaveDialog(currentWindow(event), {
      title: typeof options.title === "string" ? options.title : undefined,
      defaultPath: typeof options.defaultPath === "string" ? options.defaultPath : undefined,
      filters: normalizeDialogFilters(options.filters),
    });
    return result.canceled ? null : (result.filePath || null);
  }));
  ipcMain.handle("desktop:read-file", guardIpc(async (_event, filePath) => {
    const authorizedPath = await readAccessPolicy.assertReadable(filePath);
    return fs.promises.readFile(authorizedPath);
  }));
  ipcMain.handle("desktop:read-text-file", guardIpc(async (_event, filePath) => {
    const authorizedPath = await readAccessPolicy.assertReadable(filePath);
    return fs.promises.readFile(authorizedPath, "utf8");
  }));
  ipcMain.handle("desktop:open-path", guardIpc(async (_event, target, application) => {
    if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("Expected an absolute local path");
    if (application) {
      await openPathWithApplication(target, application);
      return;
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  }));
  ipcMain.handle("desktop:open-external", guardIpc(async (_event, url) => {
    if (!isAllowedExternalUrl(url)) throw new Error("Unsupported external URL");
    await shell.openExternal(url);
  }));
  ipcMain.handle("desktop:window-minimize", guardIpc(async (event) => currentWindow(event)?.minimize()));
  ipcMain.handle("desktop:window-toggle-maximize", guardIpc(async (event) => {
    const win = currentWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  }));
  ipcMain.handle("desktop:window-is-maximized", guardIpc(async (event) => Boolean(currentWindow(event)?.isMaximized())));
  ipcMain.handle("desktop:window-close", guardIpc(async (event) => currentWindow(event)?.close()));
  ipcMain.handle("desktop:window-force-close", guardIpc(async (event) => {
    forceClosing = true;
    currentWindow(event)?.destroy();
  }));
  ipcMain.handle("desktop:window-set-close-guard", guardIpc(async (_event, enabled) => {
    closeGuardEnabled = Boolean(enabled);
  }));

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  ipcMain.handle("desktop:updater-check", guardIpc(async () => {
    if (!app.isPackaged) throw new Error("自动更新仅在已打包版本中可用");
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    if (!info || info.version === app.getVersion()) return null;
    return { version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : null };
  }));
  ipcMain.handle("desktop:updater-download", guardIpc(async () => {
    if (!app.isPackaged) throw new Error("自动更新仅在已打包版本中可用");
    await autoUpdater.downloadUpdate();
  }));
  ipcMain.handle("desktop:updater-install", guardIpc(async () => {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }));
  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("desktop:updater-progress", Math.max(0, Math.min(100, Math.round(progress.percent || 0))));
  });
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

async function openPathWithApplication(target, application) {
  if (process.platform === "win32" && application === "__choose__") {
    await spawnDetached("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", target]);
    return;
  }
  if (typeof application !== "string" || !path.isAbsolute(application)) {
    throw new Error("Expected an absolute application path");
  }
  const canonicalApplication = await fs.promises.realpath(application);
  const allowedRoots = process.platform === "darwin"
    ? ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")]
    : process.platform === "win32"
      ? [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)
      : [];
  const allowed = allowedRoots.some((root) => pathIsWithin(canonicalApplication, root));
  const expectedExtension = process.platform === "darwin" ? ".app" : ".exe";
  if (!allowed || path.extname(canonicalApplication).toLowerCase() !== expectedExtension) {
    throw new Error("Application path is outside the allowed desktop application roots");
  }
  if (process.platform === "darwin") await spawnDetached("/usr/bin/open", ["-a", canonicalApplication, target]);
  else if (process.platform === "win32") await spawnDetached(canonicalApplication, [target]);
  else throw new Error("Selecting a custom application is unsupported on this platform");
}

function createMainWindow(initialUrl) {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    title: "Finwork",
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    frame: !isWindows,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 12, y: 24 } : undefined,
    backgroundColor: "#fafafa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("desktop:window-maximized-changed", true));
  win.on("unmaximize", () => win.webContents.send("desktop:window-maximized-changed", false));
  win.on("close", (event) => {
    if (!forceClosing && closeGuardEnabled) {
      event.preventDefault();
      win.webContents.send("desktop:window-close-requested");
    }
  });
  win.on("closed", () => {
    mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (urlIsTrusted(url)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  void win.loadURL(initialUrl);
  return win;
}

function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 900 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on("timeout", () => request.destroy());
      request.on("error", retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error("next-server readiness timed out"));
      else setTimeout(probe, 150);
    };
    probe();
  });
}

function spawnNextServer({ port, bootId, appDataDir }) {
  const serverDir = path.join(process.resourcesPath, "next-server");
  const nodeBinary = path.join(process.resourcesPath, "node", process.platform === "win32" ? "node.exe" : "node");
  const parentWatch = path.join(process.resourcesPath, "parent-watch.cjs");
  const child = spawn(nodeBinary, ["server.js"], {
    cwd: serverDir,
    // Unix 下建立独立进程组，退出时可连同 Python/工具子进程一起回收。
    // Windows 用 taskkill /T；detached 会改变控制台语义，故保持关闭。
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      FINANCE_AGENT_BOOT_ID: bootId,
      FINANCE_AGENT_PROJECT_ROOT: serverDir,
      FINANCE_AGENT_BUNDLED_PLUGIN_DIR: path.join(serverDir, "agent-skills"),
      FINANCE_AGENT_APP_DATA_DIR: appDataDir,
      FINWORK_PARENT_PID: String(process.pid),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${parentWatch}`].filter(Boolean).join(" "),
      ...(BUILTIN_TELEMETRY_ENDPOINT ? { TELEMETRY_ENDPOINT: BUILTIN_TELEMETRY_ENDPOINT } : {}),
      ...(BUILTIN_TELEMETRY_TOKEN ? { TELEMETRY_TOKEN: BUILTIN_TELEMETRY_TOKEN } : {}),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(serverLog, { end: false });
  child.stderr?.pipe(serverLog, { end: false });
  child.once("exit", (code, signal) => {
    log(`next_server_exited bootId=${bootId} pid=${child.pid} exitCode=${code ?? "unavailable"} signal=${signal ?? "none"} restartAttempted=${restartAttempted}`);
    const wasCurrent = serverProcess === child;
    stopProcessTree(child);
    if (shuttingDown || !wasCurrent) return;
    serverProcess = null;
    if (restartAttempted) {
      void mainWindow?.loadURL(SERVER_ERROR_URL);
      return;
    }
    restartAttempted = true;
    log(`next_server_restarting bootId=${bootId} attempt=1`);
    serverProcess = spawnNextServer({ port, bootId, appDataDir });
    void waitForHealth(port).then(() => mainWindow?.loadURL(trustedOrigin)).catch(() => mainWindow?.loadURL(SERVER_ERROR_URL));
  });
  log(`next_server_started bootId=${bootId} pid=${child.pid} port=${port}`);
  return child;
}

async function start() {
  const port = app.isPackaged ? await resolveServerPort() : Number.parseInt(process.env.FINANCE_AGENT_DESKTOP_PORT || "3000", 10);
  trustedOrigin = `http://127.0.0.1:${port}`;
  const appDataDir = resolveAppDataDir({ isPackaged: app.isPackaged });
  fs.mkdirSync(appDataDir, { recursive: true });
  readAccessPolicy = createReadAccessPolicy();
  await readAccessPolicy.grant([appDataDir, process.resourcesPath], { directory: true });
  const bootId = generateBootId();
  workspaceAuthToken = generateWorkspaceAuthToken();
  writeWorkspaceAuthToken(path.join(appDataDir, "workspace-auth-token"), workspaceAuthToken);
  serverLog = openNextServerLog(appDataDir, bootId);
  registerIpc();
  mainWindow = createMainWindow(app.isPackaged ? SPLASH_URL : trustedOrigin);
  if (!app.isPackaged) return;
  serverProcess = spawnNextServer({ port, bootId, appDataDir });
  try {
    await waitForHealth(port);
    log(`next_server_ready bootId=${bootId} port=${port}`);
    await mainWindow.loadURL(trustedOrigin);
  } catch (error) {
    log(`next_server_ready_timeout bootId=${bootId} error=${error}`);
    await mainWindow.loadURL(SERVER_ERROR_URL);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", () => {
    shuttingDown = true;
    forceClosing = true;
    stopProcessTree(serverProcess);
    serverProcess = null;
    serverLog?.end();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox("Finwork 启动失败", String(error));
    app.quit();
  });
}
