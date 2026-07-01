import assert from "node:assert/strict";
import { isTrustedLocalMutation } from "../lib/api/local-request.ts";

function makeReq(opts: {
  host: string;
  origin?: string;
  fetchSite?: string;
}): Parameters<typeof isTrustedLocalMutation>[0] {
  const { host, origin, fetchSite } = opts;
  const headers = new Headers({ host });
  if (origin !== undefined) headers.set("origin", origin);
  if (fetchSite !== undefined) headers.set("sec-fetch-site", fetchSite);
  const url = new URL(`http://${host}/api/settings/app`);
  return { headers, nextUrl: url } as unknown as Parameters<typeof isTrustedLocalMutation>[0];
}

export const localRequestTestPromise = (async () => {
  // CLI / Tauri：无浏览器头，直连回环
  assert.equal(isTrustedLocalMutation(makeReq({ host: "localhost:3000" })), true, "localhost 无头应通过");
  assert.equal(isTrustedLocalMutation(makeReq({ host: "127.0.0.1:3000" })), true, "127.0.0.1 无头应通过");

  // 浏览器正常 same-origin
  assert.equal(
    isTrustedLocalMutation(makeReq({ host: "localhost:3000", origin: "http://localhost:3000", fetchSite: "same-origin" })),
    true,
    "浏览器 same-origin localhost 应通过"
  );

  // DNS 重绑定：Sec-Fetch-Site 和 Origin 都看起来合法，但 hostname 不是回环
  assert.equal(
    isTrustedLocalMutation(makeReq({ host: "attacker.example:3000", origin: "http://attacker.example:3000", fetchSite: "same-origin" })),
    false,
    "DNS 重绑定非回环 hostname 必须拒绝"
  );

  // 跨站
  assert.equal(
    isTrustedLocalMutation(makeReq({ host: "localhost:3000", origin: "https://attacker.example", fetchSite: "cross-site" })),
    false,
    "cross-site 必须拒绝"
  );

  // Origin 不匹配
  assert.equal(
    isTrustedLocalMutation(makeReq({ host: "localhost:3000", origin: "https://attacker.example", fetchSite: "same-origin" })),
    false,
    "Origin 不匹配必须拒绝"
  );

  // IPv6 回环
  assert.equal(isTrustedLocalMutation(makeReq({ host: "[::1]:3000" })), true, "IPv6 回环 [::1] 应通过");

  console.log("local-request: 所有检查通过 ✓");
})();

localRequestTestPromise.catch((err) => {
  console.error(err);
  process.exit(1);
});
