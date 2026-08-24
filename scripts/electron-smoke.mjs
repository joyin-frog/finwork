import { _electron as electron } from "playwright";
import { mkdir } from "node:fs/promises";
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
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120_000 });
  await page.waitForLoadState("domcontentloaded");
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
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(JSON.stringify({ ...evidence, screenshotPath, appDataDir }, null, 2));
  if (!evidence.health.ok || !evidence.cockpit.ok || evidence.tokenLength !== 64) process.exitCode = 1;
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
