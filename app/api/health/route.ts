import { NextResponse } from "next/server";

// 轻量就绪探针:Tauri 外壳启动时轮询此端点,等 Next 真正能服务后再把 webview 从 loading 占位页
// 切到主界面,消除"服务还没起来就加载 → 白屏/连接错误页"。
// 务必零依赖、不碰 DB/Python,确保 server 一能服务路由就立刻 200。
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}
