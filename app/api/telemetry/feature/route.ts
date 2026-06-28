import { recordFeatureEvent } from "@/lib/db/sqlite";

// 匿名「功能触达」埋点接收点:前端 POST { name } → 本地计数。
// 红线 7:recordFeatureEvent 内部按白名单校验,白名单外的名字静默丢弃,事件名永不夹带 PII;
// 此处只落本地计数,是否上报由遥测开关(reporter)在出网边界另行把关。best-effort,绝不影响前端。
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    if (typeof body?.name === "string") recordFeatureEvent(body.name);
  } catch {
    /* 忽略:埋点失败不该影响任何前端操作 */
  }
  return new Response(null, { status: 204 });
}
