import { NextResponse } from "next/server";
import { withApiError } from "@/lib/api/with-api-error";
import {
  getSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
  isValidSkillName,
  SkillError,
} from "@/lib/agent/skills-store";

type Ctx = { params: Promise<{ name: string }> };

function badName() {
  return NextResponse.json({ ok: false, error: "技能名不合法" }, { status: 400 });
}

function mapSkillError(err: unknown): NextResponse | null {
  if (err instanceof SkillError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "exists" ? 409 : err.code === "read_only" ? 403 : 400;
    return NextResponse.json({ ok: false, error: err.message }, { status });
  }
  return null;
}

export const GET = withApiError(async function GET(_request: Request, { params }: Ctx) {
  const { name } = await params;
  if (!isValidSkillName(name)) return badName();
  const detail = await getSkill(name);
  if (!detail) return NextResponse.json({ ok: false, error: "技能不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, data: detail });
}, "/api/skills/[name]");

export const PUT = withApiError(async function PUT(request: Request, { params }: Ctx) {
  const { name } = await params;
  if (!isValidSkillName(name)) return badName();
  const body = (await request.json()) as { description?: string; body?: string };
  try {
    const detail = await updateSkill(name, {
      description: (body.description ?? "").trim(),
      body: body.body ?? "",
    });
    return NextResponse.json({ ok: true, data: detail });
  } catch (err) {
    const mapped = mapSkillError(err);
    if (mapped) return mapped;
    throw err;
  }
}, "/api/skills/[name]");

export const PATCH = withApiError(async function PATCH(request: Request, { params }: Ctx) {
  const { name } = await params;
  if (!isValidSkillName(name)) return badName();
  const body = (await request.json()) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "enabled 必须为布尔值" }, { status: 400 });
  }
  try {
    await setSkillEnabled(name, body.enabled);
    return NextResponse.json({ ok: true, data: await getSkill(name) });
  } catch (err) {
    const mapped = mapSkillError(err);
    if (mapped) return mapped;
    throw err;
  }
}, "/api/skills/[name]");

/** 删除用户技能(彻底删除目录)。内置技能不可删(read_only→403),请改用 PATCH 停用。 */
export const DELETE = withApiError(async function DELETE(_request: Request, { params }: Ctx) {
  const { name } = await params;
  if (!isValidSkillName(name)) return badName();
  try {
    await deleteSkill(name);
    return NextResponse.json({ ok: true, data: { removed: true } });
  } catch (err) {
    const mapped = mapSkillError(err);
    if (mapped) return mapped;
    throw err;
  }
}, "/api/skills/[name]");
