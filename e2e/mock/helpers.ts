import { expect, type Page } from "@playwright/test";

// mock e2e 共享辅助:页面无崩溃、首启 doctor 浮层兜底关闭、发一条消息并等回合结束。

export async function assertNoCrash(page: Page) {
  await expect(page.locator("text=Unhandled Runtime Error")).toHaveCount(0);
  await expect(page.locator("text=Application error")).toHaveCount(0);
}

/**
 * 首启环境自检浮层已由 fixtures.ts 通过 mock /api/settings/doctor 从源头关掉(组件就绪 + key 已配置
 * → FirstRunGate.runSelfCheck 提前返回、浮层不弹)。故此处不再"等 8s 再点暂时跳过"地赛跑。
 * 保留为即时兜底:万一极端情况下浮层仍在,立刻点掉,绝不阻塞(isVisible 不等待)。
 * 调用点无需改动;新写的用例已不需要再调它。
 */
export async function dismissGate(page: Page) {
  const skip = page.getByRole("button", { name: "暂时跳过" });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => {});
  }
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
  const sendBtn = page.getByRole("button", { name: "发送" });
  // React 组合框 hydration 完成后才挂上 onChange:过早键入会丢字、发送键一直 disabled。
  // 重试"清空→键入→确认发送键可点",直到组合框真正可交互——不依赖固定等待(更稳)。
  await expect(async () => {
    await box.click();
    await box.fill("");
    await box.pressSequentially(prompt, { delay: 5 }); // 真实键入,可靠提交 React 草稿态
    await expect(sendBtn).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const respPromise = page.waitForResponse((r) => r.url().includes("/api/agent/query"), { timeout: 60_000 });
  await sendBtn.click();
  const resp = await respPromise;
  await expect(box).toHaveValue("", { timeout: 15_000 });
  await expect.poll(() => page.url(), { timeout: 60_000 }).toContain("/chat/recent?id=");
  await expect(page.getByLabel("停止生成")).toHaveCount(0);
  await assertNoCrash(page);
  return resp.status();
}
