import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import electronPath from "electron";
import { _electron as electron } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const origin = process.argv[2] || "http://127.0.0.1:3010";
const outputDir = path.join(root, "output", "playwright");
const userDataDir = path.join(os.tmpdir(), `finwork-electron-ui-${process.pid}`);
await mkdir(outputDir, { recursive: true });

const electronApp = await electron.launch({
  executablePath: electronPath,
  args: [root, `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    FINANCE_AGENT_DESKTOP_PORT: new URL(origin).port,
    FINANCE_AGENT_APP_DATA_DIR: path.join(userDataDir, "app-data"),
    FINANCE_AGENT_MOCK_AGENT: "1",
    FINANCE_AGENT_SECRET_BACKEND: "file",
  },
  timeout: 120_000,
});

try {
  const page = await electronApp.firstWindow({ timeout: 120_000 });
  await page.addInitScript(() => {
    sessionStorage.setItem("fa-firstrun-ready", "1");
    sessionStorage.setItem("fa-firstrun-key-prompted", "1");
  });
  await page.goto(`${origin}/chat/new`);
  await page.waitForLoadState("domcontentloaded");

  for (const style of ["linear", "default"]) {
    await page.evaluate((nextStyle) => {
      localStorage.setItem("theme", "dark");
      if (nextStyle === "default") localStorage.setItem("app-style", "default");
      else localStorage.removeItem("app-style");
    }, style);
    await page.reload();
    await page.locator("html.dark").waitFor();

    const sidebarTopbar = page.locator(".app-nav-topbar");
    const pageHeader = page.locator(".app-page-header");
    const searchButton = page.getByRole("button", { name: "搜索" });
    const fileButton = page.getByRole("button", { name: "打开文件面板" });
    const [sidebarBox, headerBox, searchBox, fileBox] = await Promise.all([
      sidebarTopbar.boundingBox(),
      pageHeader.boundingBox(),
      searchButton.boundingBox(),
      fileButton.boundingBox(),
    ]);
    assert.ok(sidebarBox && headerBox && searchBox && fileBox, `${style}: titlebar geometry is missing`);
    assert.equal(Math.round(sidebarBox.height), 46, `${style}: sidebar topbar must be 46px high`);
    assert.equal(Math.round(headerBox.height), 46, `${style}: page header must be 46px high`);
    const centers = [
      sidebarBox.y + sidebarBox.height / 2,
      headerBox.y + headerBox.height / 2,
      searchBox.y + searchBox.height / 2,
      fileBox.y + fileBox.height / 2,
    ];
    assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `${style}: top controls are not vertically aligned: ${centers.join(", ")}`);

    await searchButton.click();
    await page.getByPlaceholder("搜索文件与对话…").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "收起菜单" }).click();
    await page.getByRole("button", { name: "展开菜单" }).click();
    await fileButton.click();
    await page.getByRole("dialog", { name: "文件面板" }).waitFor();
    await page.getByRole("button", { name: "关闭文件面板" }).click();
    await page.screenshot({ path: path.join(outputDir, `electron-dark-${style}.png`) });
  }

  const nativeEvidence = await electronApp.evaluate(({ BrowserWindow, nativeTheme }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      themeSource: nativeTheme.themeSource,
      backgroundColor: win.getBackgroundColor(),
      trafficLightPosition: win.getWindowButtonPosition(),
    };
  });
  assert.equal(nativeEvidence.themeSource, "dark");
  assert.equal(nativeEvidence.backgroundColor.toLowerCase(), "#262626");
  if (process.platform === "darwin") assert.deepEqual(nativeEvidence.trafficLightPosition, { x: 12, y: 16 });
  console.log(JSON.stringify({ origin, nativeEvidence, outputDir, controlsInteractive: true }, null, 2));
} finally {
  await electronApp.close();
}
