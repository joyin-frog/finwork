import { test, expect } from "@playwright/test";
import { assertNoCrash } from "./helpers";

/**
 * 三条 mock e2e:
 *  1) 首启向导·正常:缺组件→自动安装(进度条,无「开始安装」按钮)→「下一步」→ 连模型(只主模型)→ 完成;无画像表单。
 *  2) 首启向导·失败:安装失败→出现「重试」但还不能「暂时跳过」;重试一次仍败→才出现「暂时跳过」。
 *  3) 设置 → 画像:字段自动保存(带「已保存」指示);年营收非法值就地标红、不静默存。
 * 全程 mock,不打真网络、不依赖 Key。画像已移出首启,只在设置页。
 */

async function mockDoctor(
  page: import("@playwright/test").Page,
  opts: { pythonOk: boolean; keyOk: boolean },
) {
  await page.route("/api/settings/doctor", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          python: { ok: opts.pythonOk, detail: opts.pythonOk ? "ok" : "未安装", missing: opts.pythonOk ? [] : ["openpyxl", "pandas"] },
          apiKeyConfigured: opts.keyOk,
        },
      }),
    });
  });
  await page.route("/api/telemetry/report", async (route) => {
    await route.fulfill({ status: 202, body: JSON.stringify({ ok: true }) });
  });
}

test("首启向导:缺组件→自动装(进度条,无开始按钮)→下一步→连模型(主模型)→完成", async ({ page }) => {
  await mockDoctor(page, { pythonOk: false, keyOk: false });
  let installCalls = 0;
  let putBody: any;
  await page.route("/api/settings/python/install", async (route) => {
    installCalls++;
    await new Promise((r) => setTimeout(r, 400)); // 让安装态可见
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { detail: "ok" } }) });
  });
  await page.route("/api/settings/claude", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      putBody = req.postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: {} }) });
    } else if (req.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { apiUrl: "https://api.anthropic.com", model: "" } }) });
    } else {
      await route.fallback();
    }
  });

  await page.goto("/cockpit", { waitUntil: "domcontentloaded" });
  const card = page.getByText("欢迎用小财", { exact: true });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("安装组件")).toBeVisible();
  // 自动安装:没有「开始安装」按钮,且有进度反馈
  await expect(page.getByRole("button", { name: "开始安装" })).toHaveCount(0);
  await expect(page.getByText(/正在安装/)).toBeVisible({ timeout: 4_000 });

  // 装完 → 「下一步」可点
  const next = page.getByRole("button", { name: "下一步" });
  await expect(next).toBeEnabled({ timeout: 8_000 });
  expect(installCalls).toBe(1);
  await next.click();

  // 第二步:连模型(只主模型,无画像)
  await expect(page.getByPlaceholder(/主模型/)).toBeVisible();
  await expect(page.getByText("所在地区")).toHaveCount(0);
  await page.getByPlaceholder("API Key（sk-...）").fill("sk-test-123");
  await page.getByRole("button", { name: "完成" }).click();
  await expect(card).toBeHidden({ timeout: 8_000 });
  expect(putBody?.apiKey).toBe("sk-test-123");
  await assertNoCrash(page);
});

test("首启向导:安装失败→重试一次仍败→才出现「暂时跳过」", async ({ page }) => {
  await mockDoctor(page, { pythonOk: false, keyOk: true }); // key 已配 → 只缺组件
  let calls = 0;
  await page.route("/api/settings/python/install", async (route) => {
    calls++;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, data: { detail: "下载失败" } }) });
  });

  await page.goto("/cockpit", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("欢迎用小财", { exact: true })).toBeVisible({ timeout: 10_000 });

  // 第一次自动安装失败 → 有「重试」,但还不能「暂时跳过」
  const retry = page.getByRole("button", { name: "重试" });
  await expect(retry).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("button", { name: "暂时跳过" })).toHaveCount(0);
  expect(calls).toBe(1);

  // 重试一次仍败 → 才出现「暂时跳过」
  await retry.click();
  const skip = page.getByRole("button", { name: "暂时跳过" });
  await expect(skip).toBeVisible({ timeout: 8_000 });
  expect(calls).toBe(2);

  // key 已配 → 跳过安装直接收尾
  await skip.click();
  await expect(page.getByText("欢迎用小财", { exact: true })).toBeHidden({ timeout: 8_000 });
  await assertNoCrash(page);
});

test("设置→画像:字段自动保存(显示已保存),年营收非法值标红且不写入", async ({ page }) => {
  // 关掉所有首启浮层:本会话自检完成
  await page.addInitScript(() => {
    sessionStorage.setItem("fa-firstrun-ready", "1");
    sessionStorage.setItem("fa-firstrun-key-prompted", "1");
  });
  let putCount = 0;
  let lastPut: any;
  await page.route("/api/profile", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { profile: {}, updatedAt: null } }) });
    } else if (req.method() === "PUT") {
      putCount++;
      lastPut = req.postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    } else {
      await route.fallback();
    }
  });

  await page.goto("/config?tab=profile", { waitUntil: "domcontentloaded" });

  // 改地区 → 自动保存,出现「已保存」且 PUT 落库
  const region = page.getByPlaceholder("上海市松江区");
  await expect(region).toBeVisible({ timeout: 10_000 });
  await region.fill("北京市朝阳区");
  await expect(page.getByText("已保存 ✓")).toBeVisible({ timeout: 8_000 });
  expect(putCount).toBeGreaterThanOrEqual(1);
  expect(lastPut?.profile).toMatchObject({ region: "北京市朝阳区" });

  // 年营收填非法值(0)→ 就地标红、提示「未保存」,且 PUT 次数不再因此增加
  const putBefore = putCount;
  await page.getByPlaceholder("1000").fill("0");
  await expect(page.getByText("请输入大于 0 的数字，当前值未保存。")).toBeVisible({ timeout: 4_000 });
  await page.waitForTimeout(900);
  expect(putCount).toBe(putBefore);
  await assertNoCrash(page);
});
