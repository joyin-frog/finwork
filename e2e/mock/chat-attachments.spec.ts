import path from "node:path";
import { test, expect } from "./fixtures";
import { assertNoCrash, dismissGate } from "./helpers";

// Tier-2:附件旅程 —— 财务用户的核心动作是"把发票/表格扔进对话"。
// 验证 选文件 → 附件卡出现 → 随消息 multipart 发送 → 回合结束后附件被跟踪、文件名可见。

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "excel-preview-enhance.xlsx");

test("chat: 添加附件 → 发送 → 附件随消息落库渲染", async ({ page }) => {
  await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
  await dismissGate(page);

  // 先用键入探测等 hydration 完成(同 helpers.sendChat):过早 setInputFiles 会丢 change 事件。
  // 措辞避开 mock 关键词(生成/表格/核对…),走普通问答脚本。
  const box = page.getByLabel("输入消息");
  const sendBtn = page.getByRole("button", { name: "发送" });
  await expect(async () => {
    await box.click();
    await box.fill("");
    await box.pressSequentially("请帮我看看这份资料", { delay: 5 });
    await expect(sendBtn).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // 组合框已可交互 → 同组件的 file input 监听也已挂载,经隐藏 input 注入(与「添加内容」菜单同一入口)
  await page.getByLabel("添加照片和文件").setInputFiles(FIXTURE);
  // 附件托盘出现卡片(可预览)
  const tray = page.getByLabel("已添加文件");
  await expect(tray.getByRole("button", { name: /预览 excel-preview-enhance\.xlsx/ })).toBeVisible();

  const respPromise = page.waitForResponse((r) => r.url().includes("/api/agent/query"), { timeout: 60_000 });
  await sendBtn.click();
  expect((await respPromise).status()).toBe(200);

  // 回合结束:URL 重写到已落库会话、托盘清空、附件以文件名出现在消息区(已被跟踪)
  await expect.poll(() => page.url(), { timeout: 60_000 }).toContain("/chat/recent?id=");
  await expect(tray).toHaveCount(0);
  await expect(page.getByText(/excel-preview-enhance/).first()).toBeVisible();
  await assertNoCrash(page);
});
