// 本地 API 访问护栏(纯字符串判定,可在 edge middleware 里跑)。
// 威胁模型:生产态 Next 是监听 127.0.0.1:39211~ 的真实 HTTP 服务。没有校验的话:
//  - 跨源 CSRF:用户在普通浏览器打开的恶意网页可 fetch 到本机端口触发操作(烧配额/诱导读文件);
//  - DNS rebinding:恶意域名重绑到 127.0.0.1 后与本机同源,绕过 CORS 直接读响应。
// 两道防线:Host 必须是环回地址(挡 rebinding,因为 rebind 请求带 Host: evil.com);
// 变更类请求若带 Origin/Referer,其主机也必须是环回(挡跨源 CSRF,跨源 fetch 带 Origin: evil.com)。

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

/** 从 Host 头或 Origin/Referer URL 里取主机名(去端口、去协议)。取不到返回 null。 */
function extractHostname(value: string | null): string | null {
  if (!value) return null;
  let v = value.trim();
  if (!v) return null;
  // Origin/Referer 形如 http://host:port/…;Host 形如 host:port。有协议的先剥协议 + 路径。
  const schemeIdx = v.indexOf("://");
  if (schemeIdx >= 0) {
    v = v.slice(schemeIdx + 3);
    const slash = v.indexOf("/");
    if (slash >= 0) v = v.slice(0, slash);
  }
  // 去端口:IPv6 用 [::1]:port,先处理方括号;否则按最后一个冒号切端口。
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end >= 0) return v.slice(0, end + 1).toLowerCase();
  }
  const colon = v.lastIndexOf(":");
  if (colon >= 0 && !v.includes("::")) v = v.slice(0, colon);
  return v.toLowerCase();
}

function isLoopbackHostname(hostname: string | null): boolean {
  return hostname != null && LOOPBACK_HOSTNAMES.has(hostname);
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 请求是否可信(来自本机 app 自身)。
 * - Host 缺失:放行(HTTP/1.1 浏览器必带 Host;缺失多为内部调用,且无 Host 无从 rebind)。
 * - Host 非环回:拒绝(DNS rebinding)。
 * - 变更类方法且带 Origin/Referer 但主机非环回:拒绝(跨源 CSRF)。GET 等只读方法不查 Origin。
 */
export function isTrustedLocalRequest(req: {
  method: string;
  host: string | null;
  origin: string | null;
  referer: string | null;
}): boolean {
  const hostName = extractHostname(req.host);
  if (hostName !== null && !isLoopbackHostname(hostName)) return false;

  if (MUTATING_METHODS.has(req.method.toUpperCase())) {
    const originSource = req.origin ?? req.referer;
    if (originSource) {
      const originHost = extractHostname(originSource);
      if (!isLoopbackHostname(originHost)) return false;
    }
  }
  return true;
}
