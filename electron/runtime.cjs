"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const APP_DIRECTORY_NAME = "Finwork";
const WINDOWS_RELEASE_DATA_DIRECTORY_NAME = "Finwork Data";
const NEXT_SERVER_LOG_MAX_BYTES = 8 * 1024 * 1024;

function generateBootId() {
  return `${Date.now().toString(16).padStart(16, "0")}-${process.pid.toString(16).padStart(8, "0")}-${crypto.randomBytes(8).toString("hex")}`;
}

function generateWorkspaceAuthToken() {
  return crypto.randomBytes(32).toString("hex");
}

function writeWorkspaceAuthToken(filePath, token) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, token, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

function standardAppDataRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  return env.XDG_DATA_HOME || path.join(home, ".local", "share");
}

function normalizeWindowsPath(value) {
  const normalized = path.win32.normalize(String(value)).replace(/[\\/]+$/, "").toLowerCase();
  return normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized;
}

function windowsPathIsWithin(candidate, root) {
  const normalizedCandidate = normalizeWindowsPath(candidate);
  const normalizedRoot = normalizeWindowsPath(root);
  return Boolean(normalizedRoot) && (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  );
}

function releaseWindowsAppDataDir(executable, protectedRoots, protectedFallback) {
  const installDir = path.win32.dirname(executable);
  if (!installDir || installDir === ".") return undefined;
  if (protectedRoots.some((root) => windowsPathIsWithin(installDir, root))) return protectedFallback;
  const installRoot = path.win32.dirname(installDir);
  if (!installRoot || installRoot === installDir) return undefined;
  return path.win32.join(installRoot, WINDOWS_RELEASE_DATA_DIRECTORY_NAME);
}

function resolveAppDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  executable = process.execPath,
  isPackaged = false,
} = {}) {
  for (const key of ["FINANCE_AGENT_APP_DATA_DIR", "FINANCE_AGENT_DATA_DIR"]) {
    if (env[key]) return path.resolve(env[key]);
  }
  const standardDir = path.join(standardAppDataRoot(platform, env, home), APP_DIRECTORY_NAME);
  if (platform !== "win32" || !isPackaged) return standardDir;
  const protectedRoots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.ProgramW6432].filter(Boolean);
  return releaseWindowsAppDataDir(executable, protectedRoots, standardDir) || standardDir;
}

function rotateLogIfNeeded(filePath, maxBytes = NEXT_SERVER_LOG_MAX_BYTES) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (size < maxBytes) return;
  const archive = `${filePath}.1`;
  fs.rmSync(archive, { force: true });
  fs.renameSync(filePath, archive);
}

function openNextServerLog(appDataDir, bootId) {
  const logDir = path.join(appDataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, "next-server.log");
  rotateLogIfNeeded(filePath);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  stream.write(`[host] startup bootId=${bootId} pid=${process.pid} timestampMs=${Date.now()}\n`);
  return stream;
}

function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function resolveServerPort(env = process.env) {
  const configured = Number.parseInt(env.FINANCE_AGENT_DESKTOP_PORT || "", 10);
  if (configured >= 1 && configured <= 65535) return configured;
  const defaultPort = 39211;
  for (let offset = 0; offset < 64; offset += 1) {
    const port = defaultPort + offset;
    if (await isPortAvailable(port)) return port;
  }
  return defaultPort;
}

function isAllowedExternalUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function processTreeTerminationPlan(platform, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    return { kind: "command", command: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] };
  }
  return { kind: "signal", pid: -pid, signal: "SIGTERM" };
}

module.exports = {
  APP_DIRECTORY_NAME,
  NEXT_SERVER_LOG_MAX_BYTES,
  WINDOWS_RELEASE_DATA_DIRECTORY_NAME,
  generateBootId,
  generateWorkspaceAuthToken,
  isAllowedExternalUrl,
  isPortAvailable,
  normalizeWindowsPath,
  openNextServerLog,
  processTreeTerminationPlan,
  releaseWindowsAppDataDir,
  resolveAppDataDir,
  resolveServerPort,
  rotateLogIfNeeded,
  standardAppDataRoot,
  windowsPathIsWithin,
  writeWorkspaceAuthToken,
};
