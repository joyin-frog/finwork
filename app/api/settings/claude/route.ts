import { NextResponse } from "next/server";
import { readPublicClaudeSettings, writeClaudeSettings } from "@/lib/settings/claude-settings";
import { parseModelFieldsFromBody } from "@/lib/settings/model-config";
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
    /** UI: 快速模型 → routerModel + subagentModel */
    fastModel?: string;
    /** UI: 推理模型 → mainModel */
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
    // 400 + 字段级错误；磁盘保持不变
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
    data: await writeClaudeSettings({
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
    })
  });
}, "/api/settings/claude");
