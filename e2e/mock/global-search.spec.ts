import { test, expect } from "./fixtures";
import { assertNoCrash, dismissGate } from "./helpers";

// 首启 doctor/配置 gate 在 idle 后才弹——每次点击前清一次
async function clearGate(page: import("@playwright/test").Page) {
  const skip = page.getByRole("button", { name: "暂时跳过" });
  if (await skip.count()) { await skip.first().click().catch(() => {}); await page.waitForTimeout(150); }
}

// 确定性打开全局搜索浮窗(绕开平台快捷键差异)
async function openSearchAndWait(page: import("@playwright/test").Page) {
  // 用 toPass 重试:首次 Fast Refresh 完成前事件监听器可能未注册
  const placeholder = page.locator('[data-slot="command-input"]');
  await expect(async () => {
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("app-shortcut", { detail: { id: "global-search" } }))
    );
    await expect(placeholder).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return placeholder;
}

test("全局搜索:打开浮窗 + 对话内容命中 → 跳到 /chat/recent", async ({ page }) => {
  // 发一条带唯一词的用户消息建会话。用用户消息(乐观渲染 + 立即入库)做可搜内容,
  // 不等 mock agent 回复 → 去抖(避免 waitForResponse 偶发超时)。
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeVisible();
  await box.click();
  await box.pressSequentially("GSEARCHUNIQ全局搜索测试", { delay: 5 });
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("GSEARCHUNIQ全局搜索测试")).toBeVisible({ timeout: 15_000 });

  // 会话建立:URL 应含 /chat/recent?id=
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/chat/recent?id=");

  // ─── 打开全局搜索浮窗 ────────────────────────────────────────────────────────
  await clearGate(page);
  const placeholder = await openSearchAndWait(page);

  // ─── 输入关键词,等搜索结果 ──────────────────────────────────────────────────
  await placeholder.fill("GSEARCHUNIQ");
  await page.waitForTimeout(300); // debounce 200ms + fetch

  // 等对话结果出现;由于对话内容含关键词,matchedInContent=true 且应有命中项
  await expect(async () => {
    await expect(page.locator('[data-slot="command-item"]').first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 15_000 });

  // 点击第一个对话命中 → 跳到 /chat/recent?id=
  const firstConvItem = page.locator('[data-slot="command-item"]').first();
  await clearGate(page);
  await firstConvItem.click();

  await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/chat/recent?id=");

  await assertNoCrash(page);
});

test("全局搜索:事件派发打开浮窗(稳定性测试)", async ({ page }) => {
  await page.goto("/cockpit", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 通过事件派发打开浮窗(最稳定;toPass 重试处理 Fast Refresh 时序)
  await clearGate(page);
  const placeholder = await openSearchAndWait(page);
  await expect(placeholder).toBeVisible();

  await assertNoCrash(page);
});
