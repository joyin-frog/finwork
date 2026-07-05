import { test, expect } from "./fixtures";
import { assertNoCrash, dismissGate } from "./helpers";

// 遥测设置 journey(§17):
// - 开关默认开(telemetryEnabled:true)
// - 设置页只保留开关,不再展示内置/未内置状态说明,也不再有本地调试用的测试上报区块
// - 可关闭
// - 首启告知 toast 出现一次(disclosureShown 未见过时)
// 不打真网络,不依赖真 installId。

function makeSettingsBody(telemetryEnabled: boolean) {
  return JSON.stringify({
    ok: true,
    data: {
      apiUrl: "https://api.anthropic.com",
      model: "",
      apiKeyConfigured: false,
      apiKeyPreview: "",
      apiKeyPersisted: true,
      companyName: "",
      agentName: "小财",
      routerModel: "",
      subagentModel: "",
      mainModel: "",
      roleMode: "daily",
      telemetryEnabled,
      telemetryEndpoint: "",
      telemetryToken: "",
      telemetryInstallId: "11111111-1111-4111-8111-111111111111",
    },
  });
}

function makeStatusBody(enabled: boolean, builtIn = true) {
  return JSON.stringify({
    ok: true,
    data: {
      enabled,
      endpoint: builtIn ? "(内置)" : "",
      endpointBuiltIn: builtIn,
      installId: "11111111-1111-4111-8111-111111111111",
      lastReportedAt: 0,
      lastReportedCount: 0,
    },
  });
}

test("遥测设置: 开关默认开 + 可关闭", async ({ page }) => {
  let settingsEnabled = true;

  await page.route("/api/settings/claude", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: makeSettingsBody(settingsEnabled),
      });
    } else if (route.request().method() === "PUT") {
      // 解析 body 更新本地状态
      try {
        const body = JSON.parse(route.request().postData() ?? "{}") as { telemetryEnabled?: boolean };
        if (body.telemetryEnabled !== undefined) settingsEnabled = body.telemetryEnabled;
      } catch { /* ok */ }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: makeSettingsBody(settingsEnabled),
      });
    } else {
      await route.continue();
    }
  });

  await page.route("/api/telemetry/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: makeStatusBody(settingsEnabled, true),
    });
  });

  await page.route("/api/telemetry/report", async (route) => {
    await route.fulfill({ status: 202, body: JSON.stringify({ ok: true }) });
  });

  // disclosureShown 已展示(避免 toast 干扰此测试)
  await page.route("/api/settings/app*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { value: "1" } }),
      });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
  });

  await page.route("/api/settings/doctor", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { python: { ok: false, detail: "mock" } } }),
    });
  });

  await page.goto("/config?tab=about", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  await expect(page.getByText("数据与隐私", { exact: true })).toBeVisible();

  // 开关默认应为 ON(§17.2)
  const toggle = page.getByRole("switch", { name: "启用上报" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();

  // 主区不应有 token/endpoint 输入框,也不应再有本地调试用的测试上报区块(已下线)
  await expect(page.locator("input[id='telemetry-token']")).toHaveCount(0);
  await expect(page.locator("input[id='telemetry-endpoint']")).toHaveCount(0);
  await expect(page.locator("input[id='telemetry-test-endpoint']")).toHaveCount(0);
  await expect(page.locator("input[id='telemetry-test-token']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "立即上报(测试)" })).toHaveCount(0);

  // 可以关闭:点击开关 → 变为 OFF(无确认弹框)
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  // 不应有任何 dialog
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await assertNoCrash(page);
});

test("遥测设置: 首启告知 toast 出现一次(disclosureShown 未见过)", async ({ page }) => {
  await page.route("/api/settings/claude", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: makeSettingsBody(true),
    });
  });

  await page.route("/api/telemetry/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: makeStatusBody(true, true),
    });
  });

  await page.route("/api/telemetry/report", async (route) => {
    await route.fulfill({ status: 202, body: JSON.stringify({ ok: true }) });
  });

  // disclosureShown 未见过:GET 返回 null,PUT 记录
  let disclosureShown = false;
  await page.route("/api/settings/app*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { value: disclosureShown ? "1" : null } }),
      });
    } else if (route.request().method() === "PUT") {
      disclosureShown = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    } else {
      await route.continue();
    }
  });

  await page.route("/api/settings/doctor", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { python: { ok: false, detail: "mock" } } }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 首启告知 toast 应出现
  await expect(page.getByText("使用数据上报")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("不含财务数据")).toBeVisible();
  // toast 有「去设置」按钮
  await expect(page.getByRole("button", { name: "去设置" })).toBeVisible();

  await assertNoCrash(page);
});
