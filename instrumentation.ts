export async function register() {
  // node:sqlite / node:fs 只在 nodejs runtime 可用;不加守卫时 Next 会把这些
  // 动态导入也打进 edge runtime 包,触发 "node:fs UnhandledSchemeError"。
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initFlags } = await import("@/lib/runtime/flags");
      const { readFeatureFlags } = await import("@/lib/db/sqlite");
      initFlags(readFeatureFlags());
    } catch (err) {
      console.warn("[flags] init from DB failed, using defaults", err);
    }
    try {
      const { appendServerLog } = await import("@/lib/runtime/server-log");
      // cold_boot≈ = 从 Node 进程启动到本钩子(Next bootstrap)的耗时,约等于打包态"白屏阶段"的
      // 主成本(④ Node+Next 冷启)。用来量化决定是否值得做 P1(服务常驻)。
      await appendServerLog(`[startup] next-server 已启动 pid=${process.pid} platform=${process.platform} node=${process.version} cold_boot≈${Math.round(process.uptime() * 1000)}ms`);
      // 运行时自检:node:sqlite 可用性。打包进过旧的 Node 时它不可用 → 每个碰 DB 的路由(cockpit/聊天落库)
      // 500,而零依赖的 /api/health 仍 200(UI 出来但一点就「网络错误」)。落盘让这一根因一眼可查。
      let sqliteStatus = "ok";
      try {
        const sqlite = await import("node:sqlite");
        new sqlite.DatabaseSync(":memory:").close();
      } catch (e) {
        sqliteStatus = `UNAVAILABLE (${e instanceof Error ? e.message : String(e)})`;
      }
      await appendServerLog(`[preflight] node:sqlite=${sqliteStatus}`);
    } catch { /* best-effort */ }
  }
}

/**
 * Next.js 15 原生服务端错误钩子:每次 SSR / 路由处理抛错都会带着 digest 触发这里。
 * 把它连同 digest、请求路径写进磁盘日志,让生产端"server-side exception + Digest xxxx"
 * 能被反查到真实堆栈(此前打包态子进程日志被丢弃,digest 无从查起)。
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context?: { routerKind?: string; routePath?: string; renderSource?: string; routeType?: string }
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { logServerError } = await import("@/lib/runtime/server-log");
    const extra = context
      ? [context.routerKind, context.routeType, context.routePath, context.renderSource].filter(Boolean).join(" ")
      : undefined;
    await logServerError(error, { path: request?.path, method: request?.method, extra });
  } catch {
    // instrumentation 钩子绝不能抛
  }
  // 也落 app_errors 表(脱敏后),供每日批次上报(§16)。
  try {
    const { recordAppError } = await import("@/lib/runtime/app-errors");
    const err = error as { message?: string; stack?: string } | undefined;
    recordAppError({
      kind: "server",
      source: context?.routePath ?? request?.path ?? "unknown",
      message: err?.message ?? String(error),
      stack: err?.stack ?? null,
    });
  } catch {
    // instrumentation 钩子绝不能抛
  }
}
