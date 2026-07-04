import { expect, test } from "./fixtures";
import { sendChat } from "./helpers";

test("chat transcript exposes one accessible message scroller", async ({ page }) => {
  await sendChat(page, "请介绍一下你自己");

  const transcript = page.getByRole("region", { name: "Messages" });
  await expect(transcript).toHaveCount(1);
  await expect(transcript.getByRole("log")).toContainText("请介绍一下你自己");
  await expect(transcript.getByRole("log")).toContainText("本地模拟 Agent");
});

test("streaming follows the live edge until the reader scrolls away", async ({ page }) => {
  await sendChat(page, "给我一段排版样例");

  const viewport = page.getByRole("region", { name: "Messages" });
  const box = page.getByLabel("输入消息");
  const send = page.getByRole("button", { name: "发送" });

  await box.fill("滚动验证");
  await send.click();
  await expect(viewport.getByText(/你好,我是本地模拟 Agent/)).toBeVisible();

  await viewport.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(viewport.getByText(/你刚才说的是:「滚动验证」/)).toBeVisible();

  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "滚动到最新消息" }).click();
  await expect.poll(() => viewport.evaluate((node) =>
    Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)
  )).toBeLessThanOrEqual(2);
});

test("ask-user exposes an announced status with the official shimmer motion", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  const box = page.getByLabel("输入消息");
  const send = page.getByRole("button", { name: "发送" });
  await expect(async () => {
    await box.fill("");
    await box.pressSequentially("这两个方案我该选哪个", { delay: 5 });
    await expect(box).toHaveValue("这两个方案我该选哪个", { timeout: 2_000 });
    await expect(send).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await send.click();

  const status = page.getByRole("status", { name: /正在询问/ });
  await expect(status).toBeVisible();
  await expect.poll(() => status.evaluate((node) =>
    getComputedStyle(node.querySelector("[data-slot='marker-content']") ?? node).animationName
  )).toContain("tw-shimmer");
});
