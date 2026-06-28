import { expect, type Page } from "@playwright/test";

// mock e2e 共享辅助:页面无崩溃、首启 doctor 浮层兜底关闭、发一条消息并等回合结束。

export async function assertNoCrash(page: Page) {
  await expect(page.locator("text=Unhandled Runtime Error")).toHaveCount(0);
  await expect(page.locator("text=Application error")).toHaveCount(0);
}

/**
 * 首启环境自检是模态浮层(mock 模式没接 python 运行时,必弹出)。它异步出现,过早查会漏,
 * 漏掉就会拦截后续点击。这里确定性地等它出现再「暂时跳过」关掉,并等浮层消失。
 */
export async function dismissGate(page: Page) {
  const skip = page.getByRole("button", { name: "暂时跳过" });
  try {
    await skip.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    return; // 没弹出(已被跳过/不该出现)——直接继续
  }
  await skip.click();
  await skip.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
}

/**
 * 在 /chat/new 发一条消息,等到 SSE 回合结束(URL 重写到 /chat/recent?id=N、停止按钮消失)。
 * mock Agent 是确定性的,回合很快;返回 agent query 的 HTTP 状态码供断言。
 */
export async function sendChat(page: Page, prompt: string): Promise<number> {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeVisible();
  await box.click();
  await box.pressSequentially(prompt, { delay: 5 }); // 真实键入,可靠提交 React 草稿态
  const sendBtn = page.getByRole("button", { name: "发送" });
  await expect(sendBtn).toBeEnabled();
  const respPromise = page.waitForResponse((r) => r.url().includes("/api/agent/query"), { timeout: 60_000 });
  await sendBtn.click();
  const resp = await respPromise;
  await expect(box).toHaveValue("", { timeout: 15_000 });
  await expect.poll(() => page.url(), { timeout: 60_000 }).toContain("/chat/recent?id=");
  await expect(page.getByLabel("停止生成")).toHaveCount(0);
  await assertNoCrash(page);
  return resp.status();
}
