import assert from "node:assert/strict";
import { FEATURE_EVENT_NAMES, isFeatureEventName } from "../lib/telemetry/feature-events.ts";
import { trackFeature } from "../lib/telemetry/track.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

export const telemetryFeatureTestPromise = (async () => {
  // ── 1. 白名单内所有名字都被识别(round-trip) ────────────────────────
  for (const name of FEATURE_EVENT_NAMES) {
    assert.ok(isFeatureEventName(name), `白名单事件 ${name} 应被识别`);
  }

  // ── 2. 白名单外 / 非字符串一律拒绝(红线 7:事件名不可夹带 PII) ───────
  assert.equal(isFeatureEventName("nav.unknown"), false, "未登记事件名应拒绝");
  assert.equal(isFeatureEventName("feature.payroll.open 1280.50"), false, "夹带数值的名字应拒绝");
  assert.equal(isFeatureEventName(123), false, "数字应拒绝");
  assert.equal(isFeatureEventName(null), false, "null 应拒绝");
  assert.equal(isFeatureEventName(undefined), false, "undefined 应拒绝");
  assert.equal(isFeatureEventName({ name: "nav.chat" }), false, "对象应拒绝");

  // ── 3. 白名单无重复 ─────────────────────────────────────────────────
  assert.equal(new Set(FEATURE_EVENT_NAMES).size, FEATURE_EVENT_NAMES.length, "事件名不应重复");

  // ── 4. trackFeature 发出正确的 fire-and-forget POST ──────────────────
  const origFetch = globalThis.fetch;
  try {
    let captured: { url: unknown; init: RequestInit | undefined } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = ((url: unknown, init?: RequestInit) => {
      captured = { url, init };
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as any;

    trackFeature("nav.chat");
    assert.ok(captured, "trackFeature 应同步调用 fetch");
    assert.equal(captured!.url, "/api/telemetry/feature", "应打到 feature 埋点端点");
    assert.equal(captured!.init?.method, "POST");
    assert.equal((captured!.init as RequestInit & { keepalive?: boolean }).keepalive, true, "应 keepalive 以便页面卸载时仍能发出");
    const body = JSON.parse(String(captured!.init?.body)) as { name: string };
    assert.equal(body.name, "nav.chat", "请求体应只含事件名");
    assert.deepEqual(Object.keys(body), ["name"], "请求体除事件名外不应有其它字段");

    // ── 5. fetch 同步抛错 → trackFeature 不抛(失败静默) ─────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (() => {
      throw new Error("network down");
    }) as any;
    assert.doesNotThrow(() => trackFeature("nav.cockpit"), "fetch 同步抛错时不应冒泡");

    // ── 6. fetch 返回 rejected promise → 不产生未捕获异常 ─────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (() => Promise.reject(new Error("rejected"))) as any;
    assert.doesNotThrow(() => trackFeature("nav.config"));
    await flush(); // 若 .catch 缺失会在此 tick 报 unhandled rejection
  } finally {
    globalThis.fetch = origFetch;
  }

  console.log("telemetry-feature: all 6 checks passed ✓");
})();
