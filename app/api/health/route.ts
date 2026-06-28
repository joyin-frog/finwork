import { NextResponse } from "next/server";

// 轻量就绪探针:Tauri 外壳启动时轮询此端点(不带参数),等 Next 真正能服务后再把 webview 从 loading
// 占位页切到主界面,消除"服务还没起来就加载 → 白屏/连接错误页"。
// 浅探针务必零依赖、不碰 DB/Python,确保 server 一能服务路由就立刻 200(外壳只调 GET /api/health,见 lib.rs)。
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // 浅探针(外壳轮询):零依赖,立刻 200。
  if (new URL(request.url).searchParams.get("deep") !== "1") {
    return NextResponse.json({ ok: true });
  }

  // 深探针(手动 /api/health?deep=1):逐层探 DB / 模型网关,定位「UI 能开但一点就网络错误」到底坏在哪。
  // 不被外壳轮询调用,故可以慢、可以重。所有探测都吞错并降级为「该项 ok:false」,绝不让本端点自己 500。
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // node:sqlite + DB:动态 import 兜住"过旧 Node 致 node:sqlite 不可用"——那种情况下静态 import 会让
  // 路由模块整个加载失败,这里改成可上报的一项而非崩溃。
  try {
    const { getDb } = await import("@/lib/db/sqlite");
    getDb().prepare("SELECT 1").get();
    checks.db = { ok: true };
  } catch (e) {
    checks.db = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // 模型网关可达性:对配置的 ANTHROPIC_BASE_URL 发一个短超时 GET。能连上(哪怕 4xx/404)即视为可达;
  // 抛错(DNS/拒连/超时)= 不可达。只测连通——不带 key、不下发任何会话内容。
  try {
    const { readClaudeSettings } = await import("@/lib/settings/claude-settings");
    const base = (await readClaudeSettings()).apiUrl?.trim() ?? "";
    if (!base) {
      checks.gateway = { ok: false, detail: "apiUrl 未配置" };
    } else {
      const res = await fetch(base, { method: "GET", signal: AbortSignal.timeout(4000) });
      checks.gateway = { ok: true, detail: `reachable (HTTP ${res.status})` };
    }
  } catch (e) {
    checks.gateway = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  // 任一项不健康就落盘,便于用户把 server-<date>.log 发来时一眼看出坏在 DB 还是网关。
  if (!ok) {
    try {
      const { appendServerLog } = await import("@/lib/runtime/server-log");
      await appendServerLog(`[health-deep] ${JSON.stringify(checks)}`);
    } catch { /* best-effort */ }
  }
  return NextResponse.json({ ok, checks });
}
