import { test as base, expect } from "@playwright/test";

// 统一的 mock e2e fixture:从源头消除"首启自检浮层赛跑"这一类 flaky。
//
// 背景:FirstRunGate 挂在 AppShell,空闲时 fetch /api/settings/doctor;只要判定"缺组件 / 未配 key",
// 就弹一个 fixed inset-0 z-50 的模态浮层盖住聊天输入框。它异步出现(requestIdleCallback + doctor 拉
// 起 Python 子进程,慢),旧的 helpers.dismissGate 靠"等 8s 再点暂时跳过"去关它——在 CI 冷启动 /
// 路由首次编译时浮层往往晚于 8s 出现,或 gate 进了不可跳过的安装步,于是关不掉 → 所有"往聊天框输入"
// 的用例集体超时(就是 PR #5 的 e2e 红)。
//
// 正解:导航前预置 FirstRunGate 自己的"已就绪/已提示"会话标记,命中它的提前返回
// (见 app/shared/first-run-gate.tsx:`if (sessionStorage.getItem(KEY_PROMPTED) && sessionStorage.getItem(OK)) return;`),
// 浮层根本不弹——没有浮层就没有赛跑。
//
// 为什么用 sessionStorage 而非 mock /api/settings/doctor:后者会把"key 已配置/组件就绪"强加给整个
// app,污染那些真正要测设置/密钥/遥测状态的用例(pages 保存 key、telemetry)。只关浮层、不改 app 状态,
// 才是最小副作用的做法。
//
// 注意:profile-onboarding.spec 专门测这个浮层,故它仍直接 import @playwright/test、不走本 fixture。
const FIRSTRUN_READY = "fa-firstrun-ready";
const FIRSTRUN_KEY_PROMPTED = "fa-firstrun-key-prompted";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(
      ([ready, prompted]) => {
        try {
          sessionStorage.setItem(ready, "1");
          sessionStorage.setItem(prompted, "1");
        } catch {
          /* sessionStorage 不可用时忽略 */
        }
      },
      [FIRSTRUN_READY, FIRSTRUN_KEY_PROMPTED],
    );
    // Playwright fixture 的 `use` 形参不是 React Hook;react-hooks 规则在此误报。
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },
});

export { expect };
