import { test, expect, type Page } from "@playwright/test";

// Real UI journeys driven through a real browser against a real (sandbox) server.
// These prove "展示 + 交互": pages render without crashing and the core chat
// interaction actually wires UI → API → SSE → render.

async function assertNoCrash(page: Page) {
  await expect(page.locator("text=Unhandled Runtime Error")).toHaveCount(0);
  await expect(page.locator("text=Application error")).toHaveCount(0);
}

// First-run doctor gate is a modal overlay; dismiss it if it ever shows so it
// doesn't intercept interaction. (With the sandbox's python runtime wired it stays quiet.)
async function dismissGate(page: Page) {
  const skip = page.getByRole("button", { name: "暂时跳过" });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
}

test("cockpit renders with nav (展示)", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto("/cockpit", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByRole("link", { name: "知识库" })).toBeVisible();
  await assertNoCrash(page);
  if (pageErrors.length) console.log("[cockpit pageerrors]", pageErrors.join(" | "));
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("chat: send → real agent reply → render (交互)", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeVisible();

  const prompt = "你好，请用一句话介绍你自己";
  await box.click();
  await box.pressSequentially(prompt, { delay: 10 }); // real typing → reliably commits React draft state
  const sendBtn = page.getByRole("button", { name: "发送" });
  await expect(sendBtn).toBeEnabled(); // disabled binds to draft.trim() — proves state committed
  const respPromise = page.waitForResponse((r) => r.url().includes("/api/agent/query"), { timeout: 90_000 });
  await sendBtn.click();

  // UI fired the agent call and it was accepted
  const resp = await respPromise;
  expect(resp.status(), `agent query HTTP ${resp.status()}`).toBe(200);

  // sendMessage executed → composer cleared
  await expect(box).toHaveValue("", { timeout: 15_000 });

  // full SSE round-trip completed → the done handler rewrites /chat/new to /chat/recent?id=N.
  // Generous window because the router can time out and fall back to the slower main path.
  await expect.poll(() => page.url(), { timeout: 150_000 }).toContain("/chat/recent?id=");
  await expect(page.getByLabel("停止生成")).toHaveCount(0);
  await assertNoCrash(page);
});

test("config shows configured key + model (展示)", async ({ page }) => {
  await page.goto("/config?tab=model", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await assertNoCrash(page);
  await expect(page.getByText("模型连接")).toBeVisible();
  await expect(page.getByText("已配置")).toBeVisible();
});

test("knowledge page renders (展示)", async ({ page }) => {
  await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByRole("link", { name: "知识库" })).toBeVisible();
  await assertNoCrash(page);
});

test("observability panel renders (观测)", async ({ page }) => {
  await page.goto("/observability", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  await expect(page.getByRole("link", { name: "观测" })).toBeVisible();
  await assertNoCrash(page);
});
