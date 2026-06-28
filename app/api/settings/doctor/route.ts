import { NextResponse } from "next/server";
import { checkPythonEnvironment } from "@/lib/runtime/python-doctor";
import { readPublicClaudeSettings } from "@/lib/settings/claude-settings";

// 首启/设置页环境自检:报告 Python 运行时与依赖、以及 API Key 是否就位(供前端用人话展示)。
export async function GET() {
  const [python, settings] = await Promise.all([
    checkPythonEnvironment(),
    readPublicClaudeSettings(),
  ]);
  return NextResponse.json({
    ok: true,
    data: { python, apiKeyConfigured: settings.apiKeyConfigured }
  });
}
