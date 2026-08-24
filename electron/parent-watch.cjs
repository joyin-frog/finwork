"use strict";

// 独立 Node sidecar 不会自动继承 Electron 的生命周期。保留启动时父 PID，父进程崩溃或
// 被强杀后主动退出；正常退出仍由 Electron main 显式 kill，因而不会等待本轮轮询。
const parentPid = Number.parseInt(process.env.FINWORK_PARENT_PID || "", 10);
if (parentPid > 0) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 2_000);
  timer.unref();
}
