import { test, expect } from "./fixtures";
import { assertNoCrash, dismissGate, sendChat } from "./helpers";

// Tier-2:agent 类 journey,由确定性 mock Agent 驱动(FINANCE_AGENT_MOCK_AGENT=1)。
// 验证 UI → /api/agent/query → SSE → 渲染 这条链,无需真 key / 网络。

test("chat: 发送 → 流式回复渲染 → 回合结束", async ({ page }) => {
  const status = await sendChat(page, "请介绍一下你自己"); // 非问候,直达 Agent(问候被路由 cheap 短路)
  expect(status, `agent query HTTP ${status}`).toBe(200);
  await expect(page.getByText("本地模拟 Agent")).toBeVisible();
});

test("skills catalog: 开始 → 新聊天技能已钉 → 发送携带技能", async ({ page }) => {
  await page.goto("/skills", { waitUntil: "domcontentloaded" });
  const payrollCard = page.locator('a[href="/skills/payroll-calc"]');
  await expect(payrollCard).toBeVisible();
  // 卡片上的「进入对话」图标按钮靠 group-hover:opacity-100 才可见,
  // 必须先 hover 卡片再点按钮,否则会因元素视觉不可见而点击失败。
  await payrollCard.hover();
  await payrollCard.getByRole("button", { name: "进入对话" }).click();

  await expect(page).toHaveURL(/\/chat\/new\?skill=payroll-calc/);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(/\/payroll-calc/);

  const requestPromise = page.waitForRequest((request) => request.url().includes("/api/agent/query") && request.method() === "POST");
  await page.getByRole("button", { name: "发送" }).click();
  const request = await requestPromise;
  const body = request.postDataJSON() as { referencedSkills?: string[] };
  expect(body.referencedSkills).toContain("payroll-calc");
  await expect(page.getByText(/核对完成/)).toBeVisible();
});

test("chat: 工具调用 → 工具卡 + 结果渲染", async ({ page }) => {
  await sendChat(page, "帮我核对这批报销数据");
  await expect(page.getByText("核对完成")).toBeVisible();
});

test("chat: 计算回执卡 → 草稿红线标注 + 计算过程可下钻", async ({ page }) => {
  await sendChat(page, "帮我算一下增值税"); // tax_calculator → CalcReceipt structuredContent
  // 工具结果卡挂在「已处理」过程块内,回合结束默认折叠 → 先展开过程块
  await page.getByText(/已处理/).first().click();
  // 草稿红线:未结账数据显著标注,绝不当终值
  await expect(page.getByText(/未结账/).first()).toBeVisible();
  await expect(page.getByText("¥13,000.00").first()).toBeVisible();
  // 怎么算:点开"计算过程"折叠看逐步明细
  await page.getByText("计算过程").first().click();
  await expect(page.getByText("销项税额").first()).toBeVisible();
  // 按哪版口径:口径版本透出
  await expect(page.getByText(/tax-config@2025\.1/).first()).toBeVisible();
});

test("chat: 生成文件 → 产物出现在回答里", async ({ page }) => {
  await sendChat(page, "帮我生成一个示例报表");
  await expect(page.getByText("可在下方查看")).toBeVisible(); // mock 答复文本
  // 产物被追踪并以可点击文件块呈现(同名出现在文件面板 + 消息里,取其一)
  await expect(page.getByRole("button", { name: "示例报表.xlsx" }).first()).toBeVisible();
});

test("chat: 富 markdown 排版渲染不塌 + 外链成链", async ({ page }) => {
  await sendChat(page, "给我一段排版样例");
  const answer = page.locator(".md-content").last();
  // 各 markdown 结构都成形(不是塌成平文本)
  await expect(answer.getByRole("heading", { name: "二级标题" })).toBeVisible();
  await expect(answer.getByText("无序项 A")).toBeVisible();          // 列表
  await expect(answer.locator("table")).toBeVisible();              // 表格
  await expect(answer.getByText("收入")).toBeVisible();
  await expect(answer.locator("pre")).toBeVisible();                // 代码块
  await expect(answer.getByText("行内代码")).toBeVisible();          // 行内代码 chip
  // 外链:自动成链且可见(用中性域名,避开身份脱敏过滤器)。图标/配色属表现层,不在 e2e 锁定
  const link = answer.getByRole("link", { name: /example\.com/ });
  await expect(link).toBeVisible();
});

test("chat: 代码块语言标签 + 复制全文 + 思考折叠块", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await sendChat(page, "给我一段排版样例");
  const answer = page.locator(".md-content").last();

  // #1 代码块语言标签:从 ```python 提取的语言名随代码块呈现
  await expect(answer.getByText("python", { exact: true })).toBeVisible();

  // #3 思考定格标签:thinking 已从过程叙事移除(对齐 Claude),纯思考回合只显示
  // 「已思考 Xs」定格标签,原文不再在 UI 暴露(仍脱敏落库,DB 可查)
  const thinking = page.getByText(/^已思考/);
  await expect(thinking).toBeVisible();

  // #2 复制全文:按钮存在,点击后切到「已复制」态(clipboard 写入成功才会切)
  const copyBtn = page.getByRole("button", { name: "复制全文" }).last();
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();
  await expect(page.getByRole("button", { name: "已复制" }).last()).toBeVisible();

  await assertNoCrash(page);
});

test("chat: ask_user 面板 → 选项 → 继续提交", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeVisible();
  // 双重校验缺一不可:enabled 证明 React 收到了草稿(hydration 前原生 value 也会变),
  // toHaveValue 证明收全了(hydration 中途完成会截头)。
  await expect(async () => {
    await box.click();
    await box.fill("");
    await box.pressSequentially("这两个方案我该选哪个", { delay: 5 });
    await expect(box).toHaveValue("这两个方案我该选哪个", { timeout: 2_000 });
    await expect(page.getByRole("button", { name: "发送" })).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: "发送" }).click();
  // 提问面板(覆盖输入框)出现 → 选「方案甲」(编号选项,标签互不为子串)→ 点「继续」提交
  const opt = page.getByText("方案甲", { exact: true });
  await expect(opt).toBeVisible({ timeout: 30_000 });
  await opt.click();
  await page.getByRole("button", { name: /提交/ }).click();
  // 用正则匹配流式拼字后的完整句（避免整句被拆到多个 text node 时 exact 失败）
  await expect(page.getByText(/按「方案甲」口径处理/)).toBeVisible({ timeout: 30_000 });
  await assertNoCrash(page);
  await page.screenshot({ path: "test-results/ask-summary.png" }).catch(() => {});
});

test("chat: 多工具流程 → 分组时间线可下钻", async ({ page }) => {
  await sendChat(page, "工具演示");
  const process = page.locator("details").filter({ has: page.getByText(/^已处理 6 步/) }).first();
  await process.locator(":scope > summary").click(); // 展开过程块(折叠摘要为「已处理 N 步 · 时长」)
  // 已完成的多步段默认收成一行组摘要(密度对齐 Claude);过程块内容是展开后才挂载的,
  // 两个工具段被中途 thinking 隔开，逐个展开并断言段内步骤，避免摘要文字造成假阳性。
  const groups = process.locator("details.details-fold");
  await expect(groups).toHaveCount(2);
  await groups.nth(0).locator(":scope > summary").click();
  await expect(groups.nth(0).getByText("差旅住宿标准").first()).toBeVisible();
  await groups.nth(1).locator(":scope > summary").click();
  await expect(groups.nth(1).getByText(/联网尽调/).first()).toBeVisible();
  await process.screenshot({ path: "test-results/tool-steps.png" }).catch(() => {});
});
