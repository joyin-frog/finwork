import { NextResponse } from "next/server";
import { getTelemetryStatus } from "@/lib/telemetry/reporter";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";

export async function GET() {
  const settings = await readPublicClaudeSettings();
  const status = getTelemetryStatus();
  // §17.1: 判断 endpoint 是否由编译期内置 env 提供,只暴露 bool,绝不把 token 值发给前端。
  const endpointBuiltIn = !!(process.env.TELEMETRY_ENDPOINT ?? "").trim();
  // 展示给前端的 endpoint:内置时返回脱敏标记,否则返回用户设置值。
  const displayEndpoint = endpointBuiltIn ? "(内置)" : settings.telemetryEndpoint;
  return NextResponse.json({
    ok: true,
    data: {
      enabled: settings.telemetryEnabled,
      endpoint: displayEndpoint,
      endpointBuiltIn,
      installId: settings.telemetryInstallId,
      lastReportedAt: status.lastReportedAt,
      lastReportedCount: status.lastReportedCount,
    },
  });
}
