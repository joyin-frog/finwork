import { _electron as electron } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const executablePath = path.resolve(process.argv[2] || "dist-electron/mac-arm64/Finwork.app/Contents/MacOS/Finwork");
const screenshotPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), "finwork-electron-smoke.png"));
const appDataDir = path.resolve(
  process.env.FINANCE_AGENT_APP_DATA_DIR || path.join(os.tmpdir(), "finwork-electron-smoke-data")
);
await mkdir(appDataDir, { recursive: true });

const electronApp = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    FINANCE_AGENT_APP_DATA_DIR: appDataDir,
    FINANCE_AGENT_MOCK_AGENT: "1",
    FINANCE_AGENT_SECRET_BACKEND: "file",
  },
  timeout: 120_000,
});

let origin = "";
try {
  const page = await electronApp.firstWindow({ timeout: 120_000 });
  page.on("pageerror", (pageError) => console.error("Electron renderer pageerror:", pageError));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Electron renderer console:", message.text());
  });
  // The packaged smoke verifies desktop chrome, not onboarding. Keep the
  // first-run gate from covering the header controls in a fresh CI profile.
  await page.addInitScript(() => {
    sessionStorage.setItem("fa-firstrun-ready", "1");
    sessionStorage.setItem("fa-firstrun-key-prompted", "1");
  });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120_000 });
  // Reload the app-owned entry URL so the init script applies before React
  // mounts. Navigating a packaged BrowserWindow directly with page.goto can
  // race Electron's own initial load on Windows and leave the smoke on an
  // unrendered document.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ timeout: 120_000 });
  const evidence = await page.evaluate(async () => {
    const desktop = window.finworkDesktop;
    if (!desktop) throw new Error("window.finworkDesktop bridge is missing");
    const token = await desktop.workspaceAuthToken();
    const health = await fetch("/api/health").then((response) => ({ ok: response.ok, status: response.status }));
    const cockpit = await fetch("/api/cockpit/summary").then((response) => ({ ok: response.ok, status: response.status }));
    return {
      url: location.href,
      origin: location.origin,
      title: document.title,
      platform: desktop.platform,
      tokenLength: token.length,
      health,
      cockpit,
    };
  });
  origin = evidence.origin;
  // Write an early screenshot too: failures in the interaction assertions
  // should still leave a useful artifact in CI.
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.getByRole("button", { name: "搜索" }).click();
  await page.getByPlaceholder("搜索文件与对话…").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "收起菜单" }).click();
  await page.getByRole("button", { name: "展开菜单" }).waitFor();
  await page.getByRole("button", { name: "展开菜单" }).click();
  await page.locator('a[href="/chat/new"]').first().click();
  await page.waitForURL(`${origin}/chat/new`);
  await page.getByRole("button", { name: "打开文件面板" }).click();
  await page.getByRole("dialog", { name: "文件面板" }).waitFor();
  await page.getByRole("button", { name: "关闭文件面板" }).click();
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(JSON.stringify({ ...evidence, headerControlsInteractive: true, screenshotPath, appDataDir }, null, 2));
  if (!evidence.health.ok || !evidence.cockpit.ok || evidence.tokenLength !== 64) process.exitCode = 1;
} catch (error) {
  const page = electronApp.windows()[0];
  if (page) {
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body?.innerText.slice(0, 500) ?? "",
    })).catch(() => null);
    console.error("Electron smoke page diagnostic:", JSON.stringify(diagnostic));
  }
  const nextServerLog = await readFile(path.join(appDataDir, "logs", "next-server.log"), "utf8").catch(() => "");
  if (nextServerLog) console.error("Electron next-server log tail:\n", nextServerLog.slice(-12_000));
  throw error;
} finally {
  await electronApp.close();
}

if (origin) {
  const deadline = Date.now() + 10_000;
  let stopped = false;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {
      stopped = true;
      break;
    }
  }
  if (!stopped) throw new Error(`Electron closed but the local server is still listening at ${origin}`);
}
