import type { FeatureEventName } from "./feature-events";

/**
 * 前端匿名「功能触达」埋点:fire-and-forget,失败静默,绝不阻塞 UI。
 * 只接受白名单事件名(类型层就约束成 FeatureEventName);只发名字,绝不带任何值/ID/内容(红线 7)。
 * 是否真正上报,由遥测总开关在 reporter 出网边界决定;这里只负责打点到本地。
 */
export function trackFeature(name: FeatureEventName): void {
  try {
    void fetch("/api/telemetry/feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
