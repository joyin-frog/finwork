import { test, expect } from "@playwright/test";
import { assertNoCrash, dismissGate } from "./helpers";

// 遥测设置 journey(§17):
// - 开关默认开(telemetryEnabled:true)
// - 主区无 token/endpoint 输入框(内置模式)
// - 测试区有 telemetry-test-endpoint / telemetry-test-token 输入 + 「立即上报(测试)」按钮
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

test("遥测设置: 开关默认开 + 主区无 token 输入框 + 测试区有输入框和按钮 + 可关闭", async ({ page }) => {
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

  await page.goto("/config?tab=environment", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 断言「使用数据上报」章节可见
  await expect(page.getByText("使用数据上报(可选)")).toBeVisible();

  // 开关默认应为 ON(§17.2)
  const toggle = page.getByRole("switch", { name: "启用上报" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();

  // 主区不应有 token 输入框(§17.1 内置模式隐藏)
  await expect(page.locator("input[id='telemetry-token']")).toHaveCount(0);
  await expect(page.locator("input[id='telemetry-endpoint']")).toHaveCount(0);

  // 应有内置说明文字
  await expect(page.getByText("上报目标已内置")).toBeVisible();

  // 测试区应有 endpoint / token 输入框
  await expect(page.locator("input[id='telemetry-test-endpoint']")).toHaveCount(1);
  await expect(page.locator("input[id='telemetry-test-token']")).toHaveCount(1);

  // 测试区应有「立即上报(测试)」按钮
  const testBtn = page.getByRole("button", { name: "立即上报(测试)" });
  await expect(testBtn).toBeVisible();

  // 可以关闭:点击开关 → 变为 OFF(无确认弹框)
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  // 不应有任何 dialog
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await assertNoCrash(page);
});

test("遥测设置: 测试上报按钮 → mock 成功 → 显示结果", async ({ page }) => {
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

  // mock force=true 上报返回成功结果
  await page.route("/api/telemetry/report", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { force?: boolean };
    if (body.force) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status: 200, traceCount: 5, appErrorCount: 2, endpoint: "https://example.com" }),
      });
    } else {
      await route.fulfill({ status: 202, body: JSON.stringify({ ok: true }) });
    }
  });

  await page.route("/api/settings/app*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { value: "1" } }),
    });
  });

  await page.route("/api/settings/doctor", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { python: { ok: false, detail: "mock" } } }),
    });
  });

  await page.goto("/config?tab=environment", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 点击测试上报按钮
  const testBtn = page.getByRole("button", { name: "立即上报(测试)" });
  await expect(testBtn).toBeVisible();
  await testBtn.click();

  // 应显示成功结果
  await expect(page.getByText("已上报 5 条 trace / 2 条错误,接收端 200")).toBeVisible({ timeout: 5000 });

  await assertNoCrash(page);
});

test("遥测设置: 测试上报按钮 → mock 失败 → 显示错误原因", async ({ page }) => {
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

  // mock force=true 上报返回失败结果
  await page.route("/api/telemetry/report", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { force?: boolean };
    if (body.force) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, status: 401, traceCount: 3, appErrorCount: 0, endpoint: "https://example.com", error: "接收端返回 401" }),
      });
    } else {
      await route.fulfill({ status: 202, body: JSON.stringify({ ok: true }) });
    }
  });

  await page.route("/api/settings/app*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { value: "1" } }),
    });
  });

  await page.route("/api/settings/doctor", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { python: { ok: false, detail: "mock" } } }),
    });
  });

  await page.goto("/config?tab=environment", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  const testBtn = page.getByRole("button", { name: "立即上报(测试)" });
  await expect(testBtn).toBeVisible();
  await testBtn.click();

  // 应显示失败原因
  await expect(page.getByText(/上报失败.*401/)).toBeVisible({ timeout: 5000 });

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
