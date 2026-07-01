import { NextResponse } from "next/server";
import { withApiError } from "@/lib/api/with-api-error";
import { listSkillFiles, isValidSkillName, SkillError } from "@/lib/agent/skills-store";

type Ctx = { params: Promise<{ name: string }> };

/** 列技能目录下所有文件(树)。内置/用户都可读。 */
export const GET = withApiError(async function GET(_request: Request, { params }: Ctx) {
  const { name } = await params;
  if (!isValidSkillName(name)) return NextResponse.json({ ok: false, error: "技能名不合法" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, data: await listSkillFiles(name) });
  } catch (err) {
    if (err instanceof SkillError) {
      const status = err.code === "not_found" ? 404 : 400;
      return NextResponse.json({ ok: false, error: err.message }, { status });
    }
    throw err;
  }
}, "/api/skills/[name]/files");
