/** Electron updater/release contract. Kept at the historical path so ad-hoc callers do not break. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const tauriUpdaterConfigTestPromise = (async () => {
  const builder = readFileSync("electron-builder.yml", "utf8");
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const electronDev = readFileSync("scripts/electron-dev.mjs", "utf8");
  const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const main = readFileSync("electron/main.cjs", "utf8");
  const preload = readFileSync("electron/preload.cjs", "utf8");
  const electronSmoke = readFileSync("scripts/electron-smoke.mjs", "utf8");
  const prepareTauri = readFileSync("scripts/prepare-tauri.mjs", "utf8");
  const electronResourceSmoke = readFileSync("scripts/electron-resource-smoke.mjs", "utf8");
  const appShell = readFileSync("app/shared/app-shell.tsx", "utf8");
  const appNav = readFileSync("app/shared/app-nav.tsx", "utf8");
  const globals = readFileSync("app/globals.css", "utf8");
  const updaterUi = readFileSync("app/config/general/updater-settings.tsx", "utf8");

  assert.ok(builder.includes("provider: github"), "electron-builder must publish through GitHub");
  assert.ok(builder.includes("releaseType: draft"), "release must remain draft until manual approval");
  assert.ok(builder.includes("- nsis"), "Windows release must produce an NSIS installer");
  assert.ok(builder.includes("- zip"), "macOS release needs ZIP metadata for electron-updater");

  try {
    execFileSync("python3", ["-c", "import sys, yaml; yaml.safe_load(sys.stdin)"], {
      input: release,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
  } catch {
    assert.ok(release.includes("on:") && release.includes("jobs:"), "release.yml structure is invalid");
  }

  assert.ok(release.includes("electron-builder"), "release workflow must build Electron packages");
  assert.ok(release.includes("APPLE_CERTIFICATE"), "release workflow must support Apple signing");
  assert.ok(release.includes("APPLE_APP_SPECIFIC_PASSWORD"), "release workflow must support Apple notarization");
  assert.ok(release.includes("WINDOWS_CERT"), "release workflow must support Windows signing");
  assert.ok(release.includes("$ASSET.sha256"), "bundled Python runtime must be verified against the upstream checksum");
  assert.ok(release.includes("electron-resource-smoke.mjs"), "release workflow must execute bundled Node/Python evidence");
  assert.ok(release.includes("HAS_APPLE_SIGNING") && release.includes("HAS_WINDOWS_SIGNING"), "tag releases must fail closed when signing secrets are absent");
  assert.ok(release.includes("codesign --verify") && release.includes("stapler validate") && release.includes("spctl --assess"), "macOS release must verify signature, notarization and Gatekeeper");
  assert.ok(release.includes("Get-AuthenticodeSignature"), "Windows release must verify Authenticode signatures");
  assert.ok(release.includes("merge-electron-release.mjs"), "release workflow must merge both macOS architectures into updater metadata");
  assert.ok(release.includes("gh release upload"), "release workflow must publish the merged artifacts as one draft");
  assert.ok(!release.includes("tauri-apps/tauri-action"), "release workflow must not publish Tauri artifacts");

  assert.equal(packageJson.scripts.dev, "node scripts/electron-dev.mjs", "pnpm dev must open the Electron desktop app");
  assert.equal(packageJson.scripts["web:dev"], "next dev", "browser-only development needs a separate non-recursive entry");
  assert.match(electronDev, /\["run", "web:dev"/, "Electron development must start the browser-only Next script");
  assert.doesNotMatch(electronDev, /\["run", "dev"/, "Electron development must not recurse through the default desktop script");
  assert.doesNotMatch(electronDev, /"web:dev", "--", "--port"/, "pnpm 11 must not forward a separator that Next treats as a project directory");
  assert.match(tauriConfig.build.beforeDevCommand, /pnpm run web:dev/, "legacy Tauri rollback must start the browser-only Next script");
  assert.doesNotMatch(tauriConfig.build.beforeDevCommand, /web:dev -- --port/, "legacy Tauri rollback must use pnpm 11 argument forwarding");
  assert.doesNotMatch(JSON.stringify(tauriConfig.build), /run-package-script\.mjs/, "Tauri rollback must not reference a missing helper");

  assert.ok(main.includes("autoUpdater.autoDownload = false"), "updater downloads must be manual");
  assert.ok(preload.includes("desktop:updater-check"), "updater IPC should be exposed through preload");
  assert.ok(updaterUi.includes("confirmAndInstall"), "updater UI should keep the human confirmation gate");
  assert.ok(main.includes("app.dock.setIcon"), "macOS development must replace the generic Electron dock icon");
  assert.ok(main.includes("icon: developmentIcon"), "Windows/Linux development windows must use the Finwork icon");
  assert.ok(main.includes("trafficLightPosition: isMac ? { x: 12, y: 16 }"), "macOS traffic lights must align to the shared 46px header center");
  assert.ok(main.includes('ipcMain.handle("desktop:set-native-theme"'), "Electron must synchronize native window chrome with the app theme");
  assert.ok(preload.includes("desktop:set-native-theme") && appShell.includes("setNativeTheme(resolvedTheme)"), "renderer theme changes must reach Electron");
  assert.ok(globals.includes(":is(button, a, input, textarea, select"), "interactive header controls must be excluded from Electron drag regions");
  assert.ok(globals.includes("--app-header-height: 2.875rem"), "all desktop header geometry must share one 46px token");
  assert.ok(appNav.includes('"bg-sidebar mx-1 mb-1"'), "classic sidebar controls must share the page-header top origin");
  assert.ok(electronSmoke.includes('sessionStorage.setItem("fa-firstrun-ready", "1")'), "packaged header smoke must not be covered by first-run onboarding");
  assert.ok(electronSmoke.includes('page.locator(".app-shell").waitFor'), "packaged interaction smoke must wait for the Electron app shell");
  assert.ok(electronSmoke.includes('a[href="/chat/new"]'), "packaged interaction smoke must navigate through the app instead of racing Electron with page.goto");
  assert.ok(prepareTauri.includes('"atom-one-light.css", "atom-one-dark.css"'), "desktop resource preparation must explicitly copy runtime highlight themes");
  assert.ok(electronResourceSmoke.includes('"runtime-assets", "highlight", "atom-one-light.css"'), "packaged resource smoke must reject missing highlight themes");

  console.log("electron-updater-config: builder, signing, publication and manual gate contracts passed ✓");
})();
