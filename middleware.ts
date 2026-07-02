import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isTrustedLocalRequest } from "@/lib/security/local-guard";

// 只护 /api/*:桌面 app 的 Next 生产态是监听 127.0.0.1 的真实 HTTP 服务,任意网页可 fetch 到它。
// 拒绝非环回 Host(DNS rebinding)与跨源变更请求(CSRF)。页面/静态资源是同源导航,不经此。
export function middleware(request: NextRequest) {
  const trusted = isTrustedLocalRequest({
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    referer: request.headers.get("referer"),
  });
  if (!trusted) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
