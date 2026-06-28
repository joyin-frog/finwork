import { NextResponse } from "next/server";
import { installPythonRuntime, defaultInstallSteps } from "@/lib/runtime/python-installer";

// 按需安装高级分析组件(Python 运行时 + 依赖)到 app 数据目录。免管理员;失败降级,基础功能不受影响。
export async function POST() {
  const result = await installPythonRuntime({ steps: defaultInstallSteps });
  return NextResponse.json({ ok: result.ok, data: result }, { status: result.ok ? 200 : 500 });
}
