import { test, expect } from "./fixtures";
import { assertNoCrash, dismissGate } from "./helpers";

// Tier-1:非 agent journey,确定性、无需 mock 工具。验证各页 UI → API → DB/ripgrep 渲染不崩。

test("总览(cockpit)渲染 + 导航", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/cockpit", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByRole("link", { name: "资料" })).toBeVisible();
  await assertNoCrash(page);
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("设置-填 API Key → 保存回路 → 已配置", async ({ page }) => {
  await page.goto("/config?tab=model", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByText("模型连接")).toBeVisible();
  // 隔离 app-data + file 密钥后端:初始未配置;填 Key 失焦触发 PUT 保存 → 徽标翻到「已配置」。
  const key = page.getByLabel("API Key");
  await key.fill("sk-e2e-mock-key");
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/settings/claude") && r.request().method() === "PUT"
  );
  await key.blur();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("已配置")).toBeVisible();
  await assertNoCrash(page);
});

test("设置-记忆页渲染(编辑区在场)", async ({ page }) => {
  await page.goto("/config?tab=memory", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByPlaceholder(/还没有|规矩|加载中/)).toBeVisible();
  await assertNoCrash(page);
});

test("文件预览页渲染不崩", async ({ page }) => {
  await page.goto("/preview", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await assertNoCrash(page);
});
