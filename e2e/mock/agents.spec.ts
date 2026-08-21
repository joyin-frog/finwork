import { test, expect } from "./fixtures";
import { assertNoCrash } from "./helpers";

// Tier-1:多智能体花名册。验证 UI → /api/agents 渲染 + 启停回路(POST toggle → 落库 → 重拉后状态翻转)。

test("智能体:花名册渲染 + 停用/启用回路", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/agents", { waitUntil: "domcontentloaded" });

  // 团队空间导航：聊天先保留为待设计入口，智能体页不再展示旧的「本月任务」看板。
  await expect(page.getByRole("link", { name: "对话", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "团队", exact: true })).toBeVisible();
  await expect(page.getByTitle("聊天页面暂未设计")).toBeVisible();
  await expect(page.getByRole("link", { name: "智能体", exact: true })).toBeVisible();
  await expect(page.getByText("本月任务", { exact: true })).toHaveCount(0);

  // 花名册渲染:注册表里 available 的角色出现
  const row = page.locator('[data-agent-card]').filter({ hasText: "记账专员" }).first();
  await expect(row).toBeVisible();
  await assertNoCrash(page);

  // 停用:POST /api/agents/toggle 成功 → 重拉花名册 → 开关翻转为「启用」
  const toggled = page.waitForResponse(
    (r) => r.url().includes("/api/agents/toggle") && r.request().method() === "POST"
  );
  await row.getByRole("switch", { name: "停用" }).click();
  expect((await toggled).status()).toBe(200);
  await expect(row.getByRole("switch", { name: "启用" })).toBeVisible();

  // 启用还原(不给后续用例留下停用状态)
  await row.getByRole("switch", { name: "启用" }).click();
  await expect(row.getByRole("switch", { name: "停用" })).toBeVisible();

  // 切回「对话」工作空间后，现有对话入口仍可用。
  await page.getByLabel("工作空间切换").getByRole("link", { name: "对话", exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
  await expect(page.getByRole("link", { name: /^新对话/ })).toBeVisible();

  expect(errs, errs.join("\n")).toHaveLength(0);
});
