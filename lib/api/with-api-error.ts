/**
 * withApiError:API 路由错误统一包装(§16.1)。
 *
 * 用于没有自己 try/catch 的 API 路由处理函数:
 *   export const GET = withApiError(async () => { ... }, "/api/xxx");
 *
 * catch 到异常 → recordAppError(kind="api", source=routeSource) → 返回结构化 500 {ok:false,error}。
 *
 * 注意:
 * - 已有 try/catch 的路由不用包(防止双重 catch 混乱审计)。
 * - 纯读/无副作用路由可选加,有数据写操作的路由必须有自己的事务处理。
 */

import { NextResponse } from "next/server";
import { recordAppError } from "@/lib/runtime/app-errors";

export function withApiError<T extends (...args: Parameters<T>) => Promise<Response | NextResponse>>(
  handler: T,
  routeSource: string
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      recordAppError({
        kind: "api",
        source: routeSource,
        message: error.message,
        stack: error.stack ?? null,
      });
      return NextResponse.json(
        { ok: false, error: "服务暂时不可用,请稍后重试" },
        { status: 500 }
      );
    }
  }) as T;
}
