import { test, expect } from "./fixtures";
import { assertNoCrash, dismissGate } from "./helpers";

// Tier-1:非 agent journey,确定性、无需 mock 工具。验证各页 UI → API → DB/ripgrep 渲染不崩。

test("总览(cockpit)渲染 + 导航", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/cockpit", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByRole("link", { name: "知识库" })).toBeVisible();
  await assertNoCrash(page);
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("设置-填 API Key → 保存回路 → 已配置", async ({ page }) => {
  await page.goto("/config?tab=model", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByRole("heading", { name: "模型连接", level: 3 })).toBeVisible();
  // 隔离 app-data + file 密钥后端:初始未配置;填 Key 失焦触发 PUT 保存 → 徽标翻到「已配置」。
  // hydration 前 fill 不会被 React 跟踪、blur 不触发保存 → 重试"填→失焦→等 PUT"直到保存真的发生。
  const key = page.getByLabel("API Key");
  await expect(async () => {
    await key.fill("sk-e2e-mock-key");
    const saved = page.waitForResponse(
      (r) => r.url().includes("/api/settings/claude") && r.request().method() === "PUT",
      { timeout: 5_000 }
    );
    await key.blur();
    expect((await saved).status()).toBe(200);
  }).toPass({ timeout: 30_000 });
  // 「模型连接」区块的整体状态说明已下线;改为直接核对 API Key 输入框的 placeholder 翻成「已配置：...」。
  await expect(page.getByLabel("API Key")).toHaveAttribute("placeholder", /已配置/);
  await assertNoCrash(page);
});

test("设置-个性化渲染画像与记忆", async ({ page }) => {
  await page.goto("/config?tab=personalization", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByText("公司画像", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/还没有|规矩|加载中/)).toBeVisible();
  await assertNoCrash(page);
});

test("设置-旧 tab 深链显式重定向", async ({ page }) => {
  const cases = [
    ["understanding", "personalization"],
    ["memory", "personalization"],
    ["profile", "personalization"],
    ["usage", "model"],
  ] as const;
  for (const [legacy, target] of cases) {
    await page.goto(`/config?tab=${legacy}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/config\\?tab=${target}$`));
  }
  // skills 不再是设置 tab,深链应跳到独立的 /skills 编辑器,而非某个 config tab。
  await page.goto("/config?tab=skills", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/skills$/);
});

test("文件库页渲染不崩", async ({ page }) => {
  await page.goto("/files", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByText(/个文件/).first()).toBeVisible(); // 头部计数常驻,空库时为「0 个文件」
  await assertNoCrash(page);
});

test("文件预览页渲染不崩", async ({ page }) => {
  await page.goto("/preview", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await assertNoCrash(page);
});
