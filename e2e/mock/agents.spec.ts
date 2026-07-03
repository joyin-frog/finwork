import { test, expect } from "./fixtures";
import { assertNoCrash } from "./helpers";

// Tier-1:多智能体花名册。验证 UI → /api/agents 渲染 + 启停回路(POST toggle → 落库 → 重拉后状态翻转)。

test("智能体:花名册渲染 + 停用/启用回路", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/agents", { waitUntil: "domcontentloaded" });

  // 花名册渲染:注册表里 available 的角色出现
  const row = page.locator('[role="button"]').filter({ hasText: "记账专员" }).first();
  await expect(row).toBeVisible();
  await assertNoCrash(page);

  // 停用:POST /api/agents/toggle 成功 → 重拉花名册 → 「已停用」徽标出现、按钮翻转为「启用」
  const toggled = page.waitForResponse(
    (r) => r.url().includes("/api/agents/toggle") && r.request().method() === "POST"
  );
  await row.getByRole("button", { name: "停用" }).click();
  expect((await toggled).status()).toBe(200);
  await expect(row.getByText("已停用")).toBeVisible();

  // 启用还原(不给后续用例留下停用状态)
  await row.getByRole("button", { name: "启用" }).click();
  await expect(row.getByText("已停用")).toHaveCount(0);
  expect(errs, errs.join("\n")).toHaveLength(0);
});
