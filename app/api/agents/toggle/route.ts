import { NextResponse } from "next/server";
import { setRoleDisabled, getDisabledRoleIds } from "@/lib/agent/roles/availability";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { roleId?: unknown; disabled?: unknown };
    const { roleId, disabled } = body;

    if (typeof roleId !== "string" || !roleId) {
      return NextResponse.json(
        { ok: false, error: "roleId 必须是非空字符串" },
        { status: 400 }
      );
    }

    if (typeof disabled !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "disabled 必须是布尔值" },
        { status: 400 }
      );
    }

    try {
      setRoleDisabled(roleId, disabled);
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "操作失败" },
        { status: 400 }
      );
    }

    const disabledIds = getDisabledRoleIds();
    return NextResponse.json({ ok: true, data: { disabled: disabledIds } });
  } catch (error) {
    console.error("[api/agents/toggle] error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "服务器错误" },
      { status: 500 }
    );
  }
}
