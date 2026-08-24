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
 * CLI / 桌面宿主直连 localhost / 127.x.x.x，无浏览器 fetch 元数据，仍可通过。
 */
export function isTrustedLocalMutation(req: NextRequest): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  // Next dev 会把 nextUrl.hostname 规范化成 localhost，即使真实 Host 与 Electron
  // 页面都是 127.0.0.1。安全判断应以网络请求的 Host 为准，并只允许同协议、
  // 同端口的回环别名互换，避免误放行来自其他本地端口的跨站请求。
  const host = req.headers.get("host");
  let requestOrigin: URL;
  try {
    // 真实 HTTP/1.1 请求一定带 Host；缺失只会出现在 Next 内部调用或单测构造的
    // NextRequest，此时仍以它自己的回环 URL 为边界。
    requestOrigin = host ? new URL(`${req.nextUrl.protocol}//${host}`) : new URL(req.nextUrl.origin);
  } catch {
    return false;
  }
  if (!LOOPBACK_RE.test(requestOrigin.hostname)) return false;

  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const source = new URL(origin);
    return LOOPBACK_RE.test(source.hostname)
      && source.protocol === requestOrigin.protocol
      && source.port === requestOrigin.port;
  } catch {
    return false;
  }
}
