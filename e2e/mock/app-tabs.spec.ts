import path from "node:path";
import { test, expect } from "./fixtures";
import { assertNoCrash } from "./helpers";

const ATTACHMENT_FIXTURE = path.join(process.cwd(), "tests", "fixtures", "excel-preview-enhance.xlsx");

test.beforeAll(async ({ request, browser }) => {
  // Next dev 首次访问会按路由编译；先串行 warm 本 spec 涉及的页面，
  // 让 UI 用例只测客户端导航，不与首编译的 frame replacement 竞态。
  const routes = ["/cockpit", "/agents", "/knowledge", "/skills", "/config", "/chat/new"];
  let origin = "";
  for (const route of routes) {
    const response = await request.get(route);
    expect(response.ok(), `warm route ${route}`).toBe(true);
    origin ||= new URL(response.url()).origin;
  }
  const warmContext = await browser.newContext();
  const warmPage = await warmContext.newPage();
  await warmPage.addInitScript(() => {
    sessionStorage.setItem("fa-firstrun-ready", "1");
    sessionStorage.setItem("fa-firstrun-key-prompted", "1");
  });
  for (const route of routes) {
    await warmPage.goto(`${origin}${route}`, { waitUntil: "networkidle" });
  }
  await warmContext.close();
});

async function fillChat(page: import("@playwright/test").Page, prompt: string) {
  const box = page.getByLabel("输入消息");
  const send = page.getByRole("button", { name: "发送" });
  await expect(async () => {
    await box.click();
    await box.fill("");
    await box.pressSequentially(prompt, { delay: 5 });
    await expect(box).toHaveValue(prompt, { timeout: 2_000 });
    await expect(send).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await send.click();
}

async function openNavPage(page: import("@playwright/test").Page, name: string, pathname: string) {
  await expect(async () => {
    await page.getByRole("complementary").getByRole("link", { name, exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 2_000 }).toBe(pathname);
  }).toPass({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}

test("app tabs: 一级页面建签、切换和关闭回退", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("/cockpit?winchrome=1", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("tab", { name: "总览" })).toBeVisible();

  await openNavPage(page, "智能体", "/agents");
  await expect(page.getByRole("tab", { name: "智能体" })).toHaveAttribute("aria-selected", "true");
  await openNavPage(page, "知识库", "/knowledge");
  await expect(page.getByRole("tab", { name: "知识库" })).toHaveAttribute("aria-selected", "true");
  await openNavPage(page, "技能", "/skills");
  await expect(page.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");
  await openNavPage(page, "设置", "/config");
  await expect(page.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");

  await expect(page.getByRole("button", { name: "关闭全部标签" })).toHaveCount(0);

  const settingTab = page.getByRole("tab", { name: "设置" });
  const settingContainer = settingTab.locator("..");
  const settingClose = settingContainer.locator(".app-tab-close");
  const settingBoxBefore = await settingContainer.boundingBox();
  expect(settingBoxBefore).not.toBeNull();
  await expect(settingClose).toHaveCSS("opacity", "0");
  await expect(settingClose).toHaveCSS("pointer-events", "none");
  await settingTab.hover();
  await expect(settingClose).toHaveCSS("opacity", "1");
  await expect(settingClose).toHaveCSS("pointer-events", "auto");
  const settingBoxAfter = await settingContainer.boundingBox();
  expect(Math.abs((settingBoxAfter?.width ?? 0) - (settingBoxBefore?.width ?? 0))).toBeLessThan(0.5);

  const cockpitTab = page.getByRole("tab", { name: "总览" });
  const cockpitContainer = cockpitTab.locator("..");
  const knowledgeContainer = page.getByRole("tab", { name: "知识库" }).locator("..");
  const inactiveIntrinsicWidths = {
    cockpit: (await cockpitContainer.boundingBox())?.width ?? 0,
    knowledge: (await knowledgeContainer.boundingBox())?.width ?? 0,
  };
  expect(inactiveIntrinsicWidths.cockpit).toBeGreaterThanOrEqual(80);
  expect(inactiveIntrinsicWidths.knowledge).toBeGreaterThan(inactiveIntrinsicWidths.cockpit);
  expect(inactiveIntrinsicWidths.knowledge).toBeLessThanOrEqual(208);
  expect((await settingContainer.boundingBox())?.width ?? 0).toBeGreaterThan((await cockpitContainer.boundingBox())?.width ?? 0);
  await cockpitTab.click();
  await expect(cockpitTab).toHaveAttribute("aria-selected", "true");
  expect((await cockpitContainer.boundingBox())?.width ?? 0).toBeGreaterThan((await settingContainer.boundingBox())?.width ?? 0);
  await settingTab.click();
  await expect(settingTab).toHaveAttribute("aria-selected", "true");

  const listBox = await page.getByRole("tablist").boundingBox();
  expect(listBox).not.toBeNull();
  expect(1000 - (listBox?.x ?? 0) - (listBox?.width ?? 0)).toBeGreaterThanOrEqual(107);

  const readColors = async () => page.evaluate(() => {
    const activeEl = document.querySelector<HTMLElement>(".app-tab.is-active")!;
    const inactiveEl = document.querySelector<HTMLElement>(".app-tab:not(.is-active)")!;
    const activeStyle = getComputedStyle(activeEl);
    const inactiveStyle = getComputedStyle(inactiveEl);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = inactiveStyle.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const inactiveRgb = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    return {
      activeBackground: activeStyle.backgroundColor,
      inactiveBackground: inactiveStyle.backgroundColor,
      activeBorder: activeStyle.borderTopColor,
      inactiveBorder: inactiveStyle.borderTopColor,
      inactiveRgb,
    };
  });
  for (const dark of [false, true]) {
    await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
    const neutralReference = await page.evaluate((color) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = color;
      document.body.append(sample);
      const computed = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return computed;
    }, dark ? "oklch(0.22 0 0)" : "oklch(0.96 0 0)");
    if (!dark) {
      await expect.poll(async () => (await readColors()).inactiveBackground).toBe(neutralReference);
    }
    const colors = await readColors();
    expect(colors.inactiveBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.inactiveBorder).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.inactiveBackground).not.toBe(colors.activeBackground);
    expect(colors.inactiveBorder).not.toBe(colors.activeBorder);
    if (!dark) {
      expect(colors.inactiveBackground).toBe(neutralReference);
      expect(Math.max(...colors.inactiveRgb) - Math.min(...colors.inactiveRgb)).toBeLessThanOrEqual(1);
    }
  }

  await page.setViewportSize({ width: 650, height: 760 });
  const metrics = await page.getByRole("tablist").evaluate((list) => {
    const tabs = [...list.querySelectorAll<HTMLElement>(".app-tab")];
    const selected = tabs.find((tab) => tab.classList.contains("is-active"))!;
    const rest = tabs.filter((tab) => tab !== selected);
    return {
      scrollWidth: list.scrollWidth,
      clientWidth: list.clientWidth,
      activeWidth: selected.getBoundingClientRect().width,
      inactiveWidths: rest.map((tab) => tab.getBoundingClientRect().width),
    };
  });
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(metrics.activeWidth).toBeGreaterThanOrEqual(92);
  expect(metrics.inactiveWidths.every((width) => width >= 80)).toBe(true);

  await settingTab.focus();
  await page.keyboard.press("Tab");
  await expect(settingClose).toBeFocused();
  await expect(settingClose).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.getByRole("tab", { name: "技能" })).toHaveAttribute("aria-selected", "true");

  for (const { name, pathname, selected } of [
    { name: "技能", pathname: "/knowledge", selected: "知识库" },
    { name: "知识库", pathname: "/agents", selected: "智能体" },
    { name: "智能体", pathname: "/cockpit", selected: "总览" },
  ]) {
    await page.getByRole("tab", { name }).hover();
    await page.getByRole("button", { name: `关闭标签：${name}` }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
    await expect(page.getByRole("tab", { name: selected })).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("tab", { name: "总览" }).hover();
  await page.getByRole("button", { name: "关闭标签：总览" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/cockpit");
  await expect(page.getByRole("tab", { name: "总览" })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "总览" })).toHaveAttribute("aria-selected", "true");
  await assertNoCrash(page);
});

test("app tabs: ask-user 阻塞时关闭、按真实 ID 重开并继续同一回合", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "新对话" })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => {
    const counts: number[] = [];
    const sample = () => counts.push(document.querySelectorAll('[role="tab"][aria-selected="true"]').length);
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
    Object.assign(window, { __joy10SelectedCounts: counts, __joy10SelectedObserver: observer });
  });
  await fillChat(page, "这两个方案我该选哪个");

  await expect.poll(() => page.url(), { timeout: 60_000 }).toMatch(/\/chat\/recent\?id=\d+/);
  const conversationId = new URL(page.url()).searchParams.get("id");
  expect(conversationId).toMatch(/^\d+$/);
  await expect(page.getByText("方案甲", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.app-tab.is-active [role="tab"]')).toHaveAttribute("aria-selected", "true");
  const selectedCounts = await page.evaluate(() => {
    const scoped = window as typeof window & { __joy10SelectedCounts?: number[]; __joy10SelectedObserver?: MutationObserver };
    scoped.__joy10SelectedObserver?.disconnect();
    return scoped.__joy10SelectedCounts ?? [];
  });
  expect(selectedCounts.length).toBeGreaterThan(0);
  expect(selectedCounts, "新对话升级和标题更新期间不得出现 0 个选中标签").not.toContain(0);

  await page.locator(".app-tab.is-active").hover();
  await page.locator(".app-tab.is-active .app-tab-close").click();
  await expect(page).toHaveURL(/\/cockpit$/);
  await expect(page.getByLabel("停止生成")).toHaveCount(0);

  await page.getByRole("button", { name: "最近" }).click();
  const recentLink = page
    .getByRole("navigation", { name: "主导航" })
    .locator(`a[href="/chat/recent?id=${conversationId}"]`);
  await expect(recentLink).toBeVisible({ timeout: 30_000 });
  await recentLink.click();
  await expect(page).toHaveURL(new RegExp(`/chat/recent\\?id=${conversationId}$`));
  await expect(page.getByText("方案甲", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByText("方案甲", { exact: true }).click();
  await page.getByRole("button", { name: /提交/ }).click();
  await expect(page.getByText("按「方案甲」口径处理")).toBeVisible({ timeout: 30_000 });
  await assertNoCrash(page);
});

test("app tabs: 历史对话进入新对话后隔离标题、消息、文件和面板状态", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  const box = page.getByLabel("输入消息");
  const send = page.getByRole("button", { name: "发送" });
  await expect(async () => {
    await box.fill("");
    await box.pressSequentially("请帮我看看这份资料", { delay: 5 });
    await expect(box).toHaveValue("请帮我看看这份资料", { timeout: 2_000 });
    await expect(send).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByLabel("添加照片和文件").setInputFiles(ATTACHMENT_FIXTURE);
  const response = page.waitForResponse((res) => res.url().includes("/api/agent/query"), { timeout: 60_000 });
  await send.click();
  expect((await response).status()).toBe(200);
  await expect.poll(() => page.url(), { timeout: 60_000 }).toContain("/chat/recent?id=");
  await expect(page.getByLabel("停止生成")).toHaveCount(0);
  await expect(page.getByLabel("Messages").getByText("请帮我看看这份资料", { exact: true })).toBeVisible();
  await expect(page.getByText(/excel-preview-enhance/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "有帮助" })).toBeVisible();

  const sideNav = page.locator("aside");
  await sideNav.getByRole("link", { name: /新对话/ }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);

  await expect(page.getByRole("heading", { level: 1, name: "新对话" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "今天要处理什么?" })).toBeVisible();
  await expect(page.getByLabel("Messages").getByText("请帮我看看这份资料", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/excel-preview-enhance/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "有帮助" })).toHaveCount(0);
  await assertNoCrash(page);
});
