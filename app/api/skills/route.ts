import { NextResponse } from "next/server";
import { withApiError } from "@/lib/api/with-api-error";
import { createSkill, listSkills, SkillError } from "@/lib/agent/skills-store";

export const GET = withApiError(async function GET() {
  return NextResponse.json({ ok: true, data: await listSkills() });
}, "/api/skills");

export const POST = withApiError(async function POST(request: Request) {
  const body = (await request.json()) as { name?: string; description?: string; body?: string };
  const name = (body.name ?? "").trim();
  const description = (body.description ?? "").trim();
  const content = body.body ?? "";
  if (!name) {
    return NextResponse.json({ ok: false, error: "技能名不能为空" }, { status: 400 });
  }
  try {
    const detail = await createSkill(name, { description, body: content });
    return NextResponse.json({ ok: true, data: detail }, { status: 201 });
  } catch (err) {
    if (err instanceof SkillError) {
      const status = err.code === "exists" ? 409 : 400;
      return NextResponse.json({ ok: false, error: err.message }, { status });
    }
    throw err;
  }
}, "/api/skills");
