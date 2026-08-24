"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createReadAccessPolicy } = require("../electron/file-access.cjs");
const {
  generateWorkspaceAuthToken,
  isAllowedExternalUrl,
  processTreeTerminationPlan,
  releaseWindowsAppDataDir,
  resolveAppDataDir,
  rotateLogIfNeeded,
  windowsPathIsWithin,
  writeWorkspaceAuthToken,
} = require("../electron/runtime.cjs");

test("desktop sidecar termination covers the complete process tree", () => {
  assert.deepEqual(processTreeTerminationPlan("win32", 1234), {
    kind: "command",
    command: "taskkill.exe",
    args: ["/PID", "1234", "/T", "/F"],
  });
  assert.deepEqual(processTreeTerminationPlan("darwin", 1234), {
    kind: "signal",
    pid: -1234,
    signal: "SIGTERM",
  });
  assert.equal(processTreeTerminationPlan("linux", 0), null);
});

test("Windows writable installs keep Finwork Data beside the install directory", () => {
  assert.equal(
    releaseWindowsAppDataDir("D:\\Finwork\\Finwork.exe", [], "C:\\Users\\gyro\\AppData\\Local\\Finwork"),
    "D:\\Finwork Data",
  );
});

test("Windows Program Files installs use the standard writable fallback", () => {
  const fallback = "C:\\Users\\gyro\\AppData\\Local\\Finwork";
  assert.equal(
    releaseWindowsAppDataDir("C:\\Program Files\\Finwork\\Finwork.exe", ["C:\\PROGRAM FILES"], fallback),
    fallback,
  );
  assert.equal(windowsPathIsWithin("C:\\Program Files Portable\\Finwork", "C:\\Program Files"), false);
});

test("environment override remains the highest-priority data root", () => {
  assert.equal(resolveAppDataDir({ env: { FINANCE_AGENT_APP_DATA_DIR: "./custom-data" } }), path.resolve("custom-data"));
});

test("workspace token is 256-bit hex and written with private Unix permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-electron-token-"));
  const file = path.join(dir, "workspace-auth-token");
  const token = generateWorkspaceAuthToken();
  writeWorkspaceAuthToken(file, token);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(file, "utf8"), token);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("log rotation retains one bounded archive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-electron-log-"));
  const file = path.join(dir, "next-server.log");
  fs.writeFileSync(file, "12345678");
  fs.writeFileSync(`${file}.1`, "old");
  rotateLogIfNeeded(file, 8);
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "12345678");
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("external URL allowlist excludes executable and script schemes", () => {
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedExternalUrl("mailto:test@example.com"), true);
  assert.equal(isAllowedExternalUrl("file:///tmp/test"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
});

test("renderer file reads require app-root or picker-granted paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-electron-read-scope-"));
  const appRoot = path.join(dir, "app-data");
  const outsideRoot = path.join(dir, "outside");
  fs.mkdirSync(appRoot);
  fs.mkdirSync(outsideRoot);
  const appFile = path.join(appRoot, "settings.json");
  const pickedFile = path.join(outsideRoot, "picked.txt");
  const secretFile = path.join(outsideRoot, "secret.txt");
  fs.writeFileSync(appFile, "app");
  fs.writeFileSync(pickedFile, "picked");
  fs.writeFileSync(secretFile, "secret");

  const policy = createReadAccessPolicy();
  await policy.grant(appRoot, { directory: true });
  await policy.grant(pickedFile);
  assert.equal(await policy.assertReadable(appFile), fs.realpathSync(appFile));
  assert.equal(await policy.assertReadable(pickedFile), fs.realpathSync(pickedFile));
  await assert.rejects(policy.assertReadable(secretFile), /outside the authorized/);

  if (process.platform !== "win32") {
    const escape = path.join(appRoot, "escape.txt");
    fs.symlinkSync(secretFile, escape);
    await assert.rejects(policy.assertReadable(escape), /outside the authorized/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
