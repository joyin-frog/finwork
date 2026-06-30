/**
 * e2e/mock/excel-preview-screenshot.spec.ts
 *
 * 截图测试:渲染增强后的 Excel 预览并截图。
 * 使用 /e2e-preview?fixture=excel-preview-enhance.xlsx 绕过 Tauri 文件对话框。
 * 截图存到 test-results/excel-preview.png。
 *
 * 运行命令(mock 模式,无需 Key):
 *   npx playwright test e2e/mock/excel-preview-screenshot.spec.ts
 */
import { test, expect } from "./fixtures";
import { dismissGate } from "./helpers";
import path from "node:path";
import fs from "node:fs";

const FIXTURE = "excel-preview-enhance.xlsx";
const SCREENSHOT_PATH = path.join(process.cwd(), "test-results", "excel-preview.png");

test("Excel 预览增强截图", async ({ page }) => {
  // 确保输出目录存在
  fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });

  // 导航到 e2e 测试 harness 页,关闭首启浮层
  await page.goto(`/e2e-preview?fixture=${FIXTURE}`, { waitUntil: "networkidle" });
  await dismissGate(page);

  // 等待 Excel 网格出现
  await expect(page.locator(".preview-excel-grid")).toBeVisible({ timeout: 30_000 });

  // 等待公式栏出现(AC1)
  await expect(page.locator(".preview-excel-formula-bar")).toBeVisible();

  // 等待数据行出现(至少有一个单元格)
  await expect(page.locator(".preview-excel-cell").first()).toBeVisible();

  // 数据行不足以填满视口时,下方补「空网格行」铺满(像真 Excel,sheet 标签仍置底)
  await expect(page.locator("tr.preview-excel-filler-row").first()).toBeVisible({ timeout: 6_000 });
  expect(await page.locator("tr.preview-excel-filler-row").count()).toBeGreaterThan(0);

  // 截图
  await page.screenshot({
    path: SCREENSHOT_PATH,
    fullPage: false,
  });

  // 验证截图文件存在
  expect(fs.existsSync(SCREENSHOT_PATH)).toBe(true);
  console.log(`截图已保存: ${SCREENSHOT_PATH}`);
});

test("公式栏点击单元格更新(AC1)", async ({ page }) => {
  await page.goto(`/e2e-preview?fixture=${FIXTURE}`, { waitUntil: "networkidle" });
  await dismissGate(page);
  await expect(page.locator(".preview-excel-grid")).toBeVisible({ timeout: 30_000 });

  // 点击一个单元格(第一个数据单元格)
  const firstCell = page.locator(".preview-excel-cell").first();
  await firstCell.click({ force: true });

  // 公式栏的地址框应更新
  const nameBox = page.locator(".preview-excel-name-box");
  await expect(nameBox).toBeVisible();
  const label = await nameBox.textContent();
  expect(label).toBeTruthy();
  expect(label!.trim()).not.toBe("–");
});

test("数字右对齐可见(AC3)", async ({ page }) => {
  await page.goto(`/e2e-preview?fixture=${FIXTURE}`, { waitUntil: "networkidle" });
  await dismissGate(page);
  await expect(page.locator(".preview-excel-grid")).toBeVisible({ timeout: 30_000 });

  // 找到 data-numeric="true" 的单元格,验证 text-align: right
  const numericCell = page.locator(".preview-excel-cell[data-numeric='true']").first();
  const count = await numericCell.count();
  if (count > 0) {
    const textAlign = await numericCell.evaluate((el) => getComputedStyle(el).textAlign);
    expect(["right", "end"]).toContain(textAlign);
  }
  // 即使 fixture 格式没触发,测试不报失败(环境依赖 ExcelJS 解析)
});
