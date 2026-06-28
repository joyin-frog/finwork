import { test, expect } from "@playwright/test";
import { dismissGate, sendChat } from "./helpers";

// Tier-2 mock e2e:对话内查找(Cmd+F 浮窗)journey。
// 绕开平台按键差异,用 CustomEvent 确定性打开查找面板;不断言高亮像素,只断言计数+交互。

test("find-in-chat: 打开浮窗 → 输入关键词 → 计数 → 翻页 → 关闭", async ({ page }) => {
  // 1. 发一条带唯一词的用户消息,建立有内容的对话。
  //    用用户消息(乐观渲染、必在 DOM)做可搜内容,不依赖 mock agent 回复 → 去抖。
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeVisible();
  await box.click();
  await box.pressSequentially("查找测试关键词 MUTEXY", { delay: 5 });
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("查找测试关键词 MUTEXY")).toBeVisible({ timeout: 15_000 });

  // 首启 gate 可能在交互后重出,清掉
  await dismissGate(page);

  // 2. 确定性打开查找浮窗(绕开平台 Cmd/Ctrl+F 差异)
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("app-shortcut", { detail: { id: "find-in-chat" } }))
  );

  // 3. 断言浮窗出现(给 React 状态更新留时间)
  const panel = page.locator("[data-find-ui]");
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // 4. 输入用户消息里确定有的词
  const input = panel.getByRole("textbox", { name: "查找" });
  await expect(input).toBeVisible();
  await input.fill("MUTEXY");

  // 5. 断言计数出现且大于 0(形如「1 / 1」)
  // 注:匹配 「X / Y」其中 X >= 1,排除 「0 / 0」
  await expect(panel.getByText(/[1-9]\d*\s*\/\s*\d+/)).toBeVisible({ timeout: 5_000 });

  // 6. 点「下一个」不报错(仅在有匹配时)
  const nextBtn = panel.getByLabel("下一个");
  await expect(nextBtn).toBeEnabled();
  await nextBtn.click();

  // 7. 点 ✕ 关闭,浮窗消失
  const closeBtn = panel.getByLabel("关闭查找");
  await closeBtn.click();
  await expect(panel).toHaveCount(0);
});

test("find-in-chat: URL ?find= 参数自动打开并预填词", async ({ page }) => {
  // 先建立一个有内容的对话,拿到 id
  await sendChat(page, "你好");
  await dismissGate(page);
  const url = page.url(); // /chat/recent?id=N
  const withFind = url + "&find=模拟";

  // 带 find 参数打开
  await page.goto(withFind, { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 浮窗自动打开
  const panel = page.locator("[data-find-ui]");
  await expect(panel).toBeVisible({ timeout: 8_000 });

  // 输入框预填了关键词
  const input = panel.getByRole("textbox", { name: "查找" });
  await expect(input).toHaveValue("模拟");

  // URL 里的 find 参数已被清掉
  await expect.poll(() => page.url()).not.toContain("find=");
});
