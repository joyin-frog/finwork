import assert from "node:assert/strict";
import { isTrustedLocalRequest } from "../lib/security/local-guard.ts";

const trust = (o: Partial<Parameters<typeof isTrustedLocalRequest>[0]> = {}) =>
  isTrustedLocalRequest({ method: "POST", host: "127.0.0.1:39211", origin: null, referer: null, ...o });

export const localGuardTestPromise = (async () => {
  // ── L1: 合法 Tauri 生产 webview:环回 Host + 环回 Origin ──
  assert.equal(trust({ host: "127.0.0.1:39211", origin: "http://127.0.0.1:39211" }), true, "L1 FAIL: 环回同源应放行");
  assert.equal(trust({ method: "GET", host: "localhost:3000", origin: "http://localhost:3000" }), true, "L1 FAIL: dev localhost 应放行");

  // ── L2: 同源变更请求不带 Origin(部分导航/内部调用)→ 放行 ──
  assert.equal(trust({ host: "127.0.0.1:39211", origin: null, referer: null }), true, "L2 FAIL: 环回 Host 无 Origin 应放行");

  // ── L3: DNS rebinding —— Host 非环回 → 拒绝(无论方法)──
  assert.equal(trust({ method: "GET", host: "evil.com", origin: null }), false, "L3 FAIL: 非环回 Host 应拒绝(rebinding)");
  assert.equal(trust({ host: "attacker.example:39211", origin: "http://attacker.example:39211" }), false, "L3 FAIL: 重绑域名应拒绝");

  // ── L4: 跨源 CSRF —— Host 环回但 Origin 是外部站点 → 变更类拒绝 ──
  assert.equal(trust({ host: "127.0.0.1:39211", origin: "https://evil.com" }), false, "L4 FAIL: 跨源 Origin 变更请求应拒绝");
  assert.equal(trust({ host: "127.0.0.1:39211", origin: null, referer: "https://evil.com/x" }), false, "L4 FAIL: 跨源 Referer 变更请求应拒绝");

  // ── L5: 只读方法不查 Origin(跨源读被浏览器 CORS 挡响应,且无副作用)——但 Host 仍须环回 ──
  assert.equal(trust({ method: "GET", host: "127.0.0.1:39211", origin: "https://evil.com" }), true, "L5 FAIL: GET 跨源 Origin 只要 Host 环回即放行");

  // ── L6: Host 缺失放行(HTTP/1.0 内部调用;无 Host 无从 rebind)──
  assert.equal(trust({ host: null, origin: null }), true, "L6 FAIL: 无 Host 应放行");

  // ── L7: IPv6 环回 [::1] 识别 ──
  assert.equal(trust({ host: "[::1]:39211", origin: "http://[::1]:39211" }), true, "L7 FAIL: IPv6 环回应放行");

  // ── L8: 大小写 / 端口无关 ──
  assert.equal(trust({ host: "LOCALHOST:39211", origin: "http://LocalHost:39211" }), true, "L8 FAIL: 大小写不敏感");

  console.log("local-guard: all 8 checks passed ✓");
})();
