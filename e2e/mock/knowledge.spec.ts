import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { assertNoCrash, dismissGate } from "./helpers";

// 首启 doctor/配置 gate 在 idle 后才弹、是 fixed inset-0 z-50 浮层,会拦截点击。
// xlsx 流程多步且慢(首传编译 exceljs、客户端 exceljs 解析),gate 易中途冒出——每个点击前清一次。
async function clearGate(page: import("@playwright/test").Page) {
  const skip = page.getByRole("button", { name: "暂时跳过" });
  if (await skip.count()) { await skip.first().click().catch(() => {}); await page.waitForTimeout(150); }
}

// Tier-1:知识库 上传 → 检索(真 ripgrep)→ 预览 全闭环。不依赖 agent。
test("知识库:上传 → 检索 → 预览", async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-"));
  const file = path.join(dir, "差旅报销制度.md");
  // 含一个唯一关键词 EEKW,便于断言 ripgrep 真命中。
  writeFileSync(file, "# 差旅报销制度\n\n出差住宿标准:一线城市每晚不超过 600 元。EEKW 唯一关键词。\n");

  await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 打开上传面板 → 选文件 → 上传并索引
  await page.getByRole("button", { name: "上传文档" }).click();
  await page.setInputFiles('input[type="file"]', file);
  await page.getByRole("button", { name: "上传并索引" }).click();

  // 文档进库(卡片标题)
  await expect(page.getByText("差旅报销制度").first()).toBeVisible({ timeout: 30_000 });

  // 检索唯一关键词 → ripgrep 真命中
  const search = page.getByLabel("搜索知识库");
  await search.fill("EEKW");
  await search.press("Enter");
  await expect(page.getByText("EEKW").first()).toBeVisible({ timeout: 30_000 });

  await assertNoCrash(page);
});

// Tier-1:xlsx 搜索命中 → 「在表格中查看」→ 切到命中所在工作表/行,且表格内 ↑↓ 可逐个命中跳。
// 同一关键词刻意分布在「两个工作表」各一行 → 跳转/翻页后靠工作表独有内容(汇总:合计 / 明细:李四)
// 判断切对了哪个 sheet,非时序、稳。
test("知识库:xlsx 搜索命中 → 在表格中查看 → 多命中 ↑↓ 跨表跳", async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-xlsx-"));
  const file = path.join(dir, "报销台账.xlsx");
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("汇总");
  s1.addRow(["项目", "金额", "备注"]);
  s1.addRow(["合计", 1000, "薪资保密凭据"]); // 命中 1(汇总 第2行)
  const s2 = wb.addWorksheet("报销明细");
  s2.addRow(["姓名", "城市", "事由"]); // row 1
  s2.addRow(["张三", "北京", "日常"]); // row 2
  s2.addRow(["李四", "上海", "薪资保密凭据"]); // 命中 2(报销明细 第3行)
  await wb.xlsx.writeFile(file);

  await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  await page.getByRole("button", { name: "上传文档" }).click();
  await page.setInputFiles('input[type="file"]', file);
  await page.getByRole("button", { name: "上传并索引" }).click();

  // 等索引真正完成:首个 xlsx 上传在 next dev 下要现编译 exceljs、较慢,且卡片名易与上传框文件名混淆。
  // 用"重试搜索直到命中出现"作为索引完成信号(搜索是一次性的,索引没好就 0 命中、需重搜)。
  const search = page.getByLabel("搜索知识库");
  await expect(async () => {
    await search.fill("");
    await search.fill("薪资保密凭据");
    await search.press("Enter");
    await expect(page.getByRole("button", { name: /查看原文/ })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 90_000 });

  // 高亮落在搜索词的字上(护 rg 字节→字符偏移修复:中文行别把高亮滑到后面的数字)。
  // 中文走 2-gram 分词,命中拆成多个 <mark>(唯一/差旅…),断言其中一个 gram 高亮可见即可。
  await expect(page.locator("mark").filter({ hasText: "保密" }).first()).toBeVisible({ timeout: 30_000 });

  // xlsx 命中点「查看原文」→ 直接进表格并跳到命中行(首个命中=行号最小=汇总 第2行),不再有中间镜像文本步
  await clearGate(page);
  await page.getByRole("button", { name: /查看原文/ }).first().click({ timeout: 30_000 });

  const grid = page.locator(".preview-excel-grid");
  await expect(grid).toBeVisible({ timeout: 30_000 });
  // 多命中:导航显示「/2 个匹配」+ 首个命中落在「汇总」(合计可见)+ 命中行持续高亮(不闪一下就没)
  await expect(page.getByText(/\/\s*2 个匹配/)).toBeVisible({ timeout: 30_000 });
  await expect(grid.getByText("合计")).toBeVisible();
  await expect(grid.locator("tr.preview-excel-row-flash")).toBeVisible();

  // 点「下一个匹配」→ 跨表跳到「报销明细」(李四可见、第3行存在 = ↑↓ 多命中跨表跳生效)
  await clearGate(page);
  await page.getByRole("button", { name: "下一个匹配" }).click();
  await expect(grid.getByText("李四")).toBeVisible({ timeout: 30_000 });
  await expect(grid.locator('tr[data-rownum="3"]')).toBeVisible();

  // 预览「放大」回归:放大时整列隐藏文件列表(对齐 chat 隐藏主内容区);否则 min-w 列不收缩会把
  // 预览撑出容器、overflow-hidden 把头部右侧按钮裁到屏外 → 「还原 / 取消全屏」按钮消失。
  // toBeVisible 不查"裁到屏外",所以额外断言还原按钮 boundingBox 落在视口内。
  await expect(search).toBeVisible(); // 放大前:列表列(含搜索框)在
  await clearGate(page);
  await page.getByRole("button", { name: "放大预览" }).click();
  await expect(search).toBeHidden({ timeout: 5_000 }); // 放大后:列表列被隐藏
  const restoreBtn = page.getByRole("button", { name: "还原预览" });
  await expect(restoreBtn).toBeVisible();
  const rbox = await restoreBtn.boundingBox();
  expect(rbox).not.toBeNull();
  expect(rbox!.x + rbox!.width).toBeLessThanOrEqual(page.viewportSize()!.width); // 没被裁到屏幕右侧外
  await restoreBtn.click(); // 还原 → 列表列回来
  await expect(search).toBeVisible({ timeout: 5_000 });

  await assertNoCrash(page);
});
