import { NextResponse } from "next/server";
import { readPublicClaudeSettings, writeClaudeSettings } from "@/lib/settings/claude-settings";
import { withApiError } from "@/lib/api/with-api-error";

export const GET = withApiError(async function GET() {
  return NextResponse.json({
    ok: true,
    data: await readPublicClaudeSettings()
  });
}, "/api/settings/claude");

export const PUT = withApiError(async function PUT(request: Request) {
  const body = (await request.json()) as {
    apiUrl?: string;
    apiKey?: string;
    model?: string;
    clearApiKey?: boolean;
    routerModel?: string;
    subagentModel?: string;
    companyName?: string;
    agentName?: string;
    userName?: string;
    userAvatar?: string;
    roleMode?: "daily" | "tech";
    telemetryEnabled?: boolean;
    telemetryEndpoint?: string;
    telemetryToken?: string;
  };

  return NextResponse.json({
    ok: true,
    data: await writeClaudeSettings({
      apiUrl: body.apiUrl,
      apiKey: body.clearApiKey ? "" : body.apiKey,
      model: body.model,
      routerModel: body.routerModel,
      subagentModel: body.subagentModel,
      companyName: body.companyName,
      agentName: body.agentName,
      userName: body.userName,
      userAvatar: body.userAvatar,
      roleMode: body.roleMode,
      telemetryEnabled: body.telemetryEnabled,
      telemetryEndpoint: body.telemetryEndpoint,
      telemetryToken: body.telemetryToken,
    })
  });
}, "/api/settings/claude");
