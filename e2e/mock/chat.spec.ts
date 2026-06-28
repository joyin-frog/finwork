import { test, expect } from "@playwright/test";
import { assertNoCrash, dismissGate, sendChat } from "./helpers";

// Tier-2:agent 类 journey,由确定性 mock Agent 驱动(FINANCE_AGENT_MOCK_AGENT=1)。
// 验证 UI → /api/agent/query → SSE → 渲染 这条链,无需真 key / 网络。

test("chat: 发送 → 流式回复渲染 → 回合结束", async ({ page }) => {
  const status = await sendChat(page, "请介绍一下你自己"); // 非问候,直达 Agent(问候被路由 cheap 短路)
  expect(status, `agent query HTTP ${status}`).toBe(200);
  await expect(page.getByText("本地模拟 Agent")).toBeVisible();
});

test("chat: 工具调用 → 工具卡 + 结果渲染", async ({ page }) => {
  await sendChat(page, "帮我核对这批报销数据");
  await expect(page.getByText("核对完成")).toBeVisible();
});

test("chat: 生成文件 → 产物出现在回答里", async ({ page }) => {
  await sendChat(page, "帮我生成一个示例报表");
  await expect(page.getByText("可在下方查看")).toBeVisible(); // mock 答复文本
  // 产物被追踪并以可点击文件块呈现(同名出现在文件面板 + 消息里,取其一)
  await expect(page.getByRole("button", { name: "示例报表.xlsx" }).first()).toBeVisible();
});

test("chat: 富 markdown 排版渲染不塌 + 外链地球图标", async ({ page }) => {
  await sendChat(page, "给我一段排版样例");
  const answer = page.locator(".md-content").last();
  // 各 markdown 结构都成形(不是塌成平文本)
  await expect(answer.getByRole("heading", { name: "二级标题" })).toBeVisible();
  await expect(answer.getByText("无序项 A")).toBeVisible();          // 列表
  await expect(answer.locator("table")).toBeVisible();              // 表格
  await expect(answer.getByText("收入")).toBeVisible();
  await expect(answer.locator("pre")).toBeVisible();                // 代码块
  await expect(answer.getByText("行内代码")).toBeVisible();          // 行内代码 chip
  // 外链:绿色文本 + 地球图标(svg),角色为 link
  const link = answer.getByRole("link", { name: /openai\.github\.io/ });
  await expect(link).toBeVisible();
  await expect(link.locator("svg")).toBeVisible();                  // 🌐 地球标识
  // 金额列在 markdown 里标了右对齐,CSS 应强制为左对齐
  await expect(answer.locator("td").filter({ hasText: "123" })).toHaveCSS("text-align", "left");
});

test("chat: ask_user 面板 → 选项 → 继续提交", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);
  const box = page.getByLabel("输入消息");
  await expect(box).toBeVisible();
  await box.click();
  await box.pressSequentially("这两个方案我该选哪个", { delay: 5 });
  await page.getByRole("button", { name: "发送" }).click();
  // 提问面板(覆盖输入框)出现 → 选「方案甲」(编号选项,标签互不为子串)→ 点「继续」提交
  const opt = page.getByText("方案甲", { exact: true });
  await expect(opt).toBeVisible({ timeout: 30_000 });
  await opt.click();
  await page.getByRole("button", { name: /提交/ }).click();
  await expect(page.getByText("按「方案甲」口径处理")).toBeVisible({ timeout: 30_000 });
  await assertNoCrash(page);
  await page.screenshot({ path: "test-results/ask-summary.png" }).catch(() => {});
});

test("chat: 多工具流程 → 类型图标时间线", async ({ page }) => {
  await sendChat(page, "工具演示");
  await page.getByText(/已处理/).first().click(); // 展开过程块(折叠摘要为「已处理 N 步 · 时长」)
  const details = page.locator("details").first();
  await expect(details.getByText("财务分析")).toBeVisible();                        // Skill:友好名「调用【财务分析】技能」(不再露 finance-skills: id)
  await expect(details.getByText("差旅住宿标准")).toBeVisible();                    // search_knowledge:去「」+ mcp 归一化
  await expect(details.getByText(/运行 Python/)).toHaveCount(0);                    // run_python:不露语言细节
  await expect(details.getByText("运行代码").first()).toBeVisible();                 // run_python:图标 + 友好文案
  await expect(details.getByText(/[「」]/)).toHaveCount(0);                          // 无 CJK 引号
  await details.screenshot({ path: "test-results/tool-steps.png" }).catch(() => {});
});
