import { NextResponse } from "next/server";
import { checkPythonEnvironment } from "@/lib/runtime/python-doctor";
import { getSpreadsheetCapabilities } from "@/lib/runtime/spreadsheet-probe";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";
import { getModelConfigReadiness } from "@/lib/settings/model-config";

// 首启/设置页环境自检：Python、Spreadsheet 能力、模型配置就绪、API Key。
export async function GET() {
  const [python, settings, spreadsheet] = await Promise.all([
    checkPythonEnvironment(),
    readPublicClaudeSettings(),
    getSpreadsheetCapabilities().catch(() => null),
  ]);
  const { modelConfigReady, missingModelRoles } = getModelConfigReadiness(settings);
  return NextResponse.json({
    ok: true,
    data: {
      python,
      spreadsheet,
      apiKeyConfigured: settings.apiKeyConfigured,
      modelConfigReady,
      missingModelRoles,
    },
  });
}
