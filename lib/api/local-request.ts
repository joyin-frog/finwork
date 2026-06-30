import type { NextRequest } from "next/server";

// 127.0.0.0/8、::1 和 localhost 均为回环地址。
// URL.hostname 对 IPv6 返回带括号的形式（[::1]），需一并匹配。
const LOOPBACK_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

/**
 * 防止浏览器跨站或 DNS 重绑定请求触发本地敏感操作。
 *
 * DNS 重绑定场景：attacker.example 解析到 127.0.0.1，浏览器发送
 * Host: attacker.example:PORT，使 req.nextUrl.origin 与 Origin 完全一致，
 * 仅凭 origin === req.nextUrl.origin 的检查就会放行。
 * 因此必须额外校验 hostname 是否为回环地址，确保任何非回环 Host 都被拒绝。
 *
 * CLI / Tauri 直连 localhost / 127.x.x.x，无浏览器 fetch 元数据，仍可通过。
 */
export function isTrustedLocalMutation(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return false;

  // DNS 重绑定防护：即使 Origin 与重绑定后的 Host 匹配，hostname 也必须是回环地址。
  return LOOPBACK_RE.test(req.nextUrl.hostname);
}
