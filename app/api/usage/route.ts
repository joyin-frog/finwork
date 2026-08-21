import { NextResponse } from "next/server";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { getUsageStatus } from "@/lib/usage/store";
import { isEnabled } from "@/lib/runtime/flags";
import { withApiError } from "@/lib/api/with-api-error";

// 进度环/浮层取数:只读当前两窗口的百分比 + 重置时刻 + 是否拦截。绝对 token 数与上限不外露。
export const GET = withApiError(async function GET() {
  if (!isEnabled("USAGE_LIMIT_ENABLED")) {
    return NextResponse.json({ ok: true, data: { enabled: false } });
  }
  const settings = await readAgentSettings().catch(() => null);
  const usage = getUsageStatus({
    now: Date.now(),
    roles: {
      fastModel: settings?.fastModel ?? "",
      reasoningModel: settings?.reasoningModel ?? "",
    },
    persist: false, // 展示路径只读,不重锚/不落库
  });
  return NextResponse.json({
    ok: true,
    data: {
      enabled: true,
      blocked: usage.blocked,
      fivehour: { pct: usage.fivehour.pct, resetAt: usage.fivehour.resetAt },
      week: { pct: usage.week.pct, resetAt: usage.week.resetAt },
    },
  });
}, "/api/usage");
