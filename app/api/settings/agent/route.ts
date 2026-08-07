import { NextResponse } from "next/server";
import {
  readPublicAgentSettings,
  writeAgentSettings,
} from "@/lib/settings/agent-settings";
import { parseModelFieldsFromBody } from "@/lib/settings/model-config";
import { withApiError } from "@/lib/api/with-api-error";

export const GET = withApiError(async function GET() {
  return NextResponse.json({
    ok: true,
    data: await readPublicAgentSettings(),
  });
}, "/api/settings/agent");

export const PUT = withApiError(async function PUT(request: Request) {
  const body = (await request.json()) as {
    apiUrl?: string;
    apiKey?: string;
    model?: string;
    clearApiKey?: boolean;
    fastModel?: string;
    reasoningModel?: string;
    routerModel?: string;
    subagentModel?: string;
    mainModel?: string;
    companyName?: string;
    agentName?: string;
    userName?: string;
    userAvatar?: string;
    roleMode?: "daily" | "tech";
    telemetryEnabled?: boolean;
    telemetryEndpoint?: string;
    telemetryToken?: string;
  };

  const parsedModels = parseModelFieldsFromBody(body);
  if (parsedModels.kind === "invalid") {
    return NextResponse.json(
      { ok: false, error: "MODEL_CONFIG_INCOMPLETE", fields: parsedModels.errors },
      { status: 400 },
    );
  }
  const modelPatch =
    parsedModels.kind === "ok"
      ? {
          mainModel: parsedModels.config.mainModel,
          routerModel: parsedModels.config.routerModel,
          subagentModel: parsedModels.config.subagentModel,
        }
      : {};

  return NextResponse.json({
    ok: true,
    data: await writeAgentSettings({
      apiUrl: body.apiUrl,
      apiKey: body.clearApiKey ? "" : body.apiKey,
      model: body.model,
      ...modelPatch,
      companyName: body.companyName,
      agentName: body.agentName,
      userName: body.userName,
      userAvatar: body.userAvatar,
      roleMode: body.roleMode,
      telemetryEnabled: body.telemetryEnabled,
      telemetryEndpoint: body.telemetryEndpoint,
      telemetryToken: body.telemetryToken,
    }),
  });
}, "/api/settings/agent");

