import { NextResponse } from "next/server";
import { withApiError } from "@/lib/api/with-api-error";
import { readSkillFile, writeSkillFile, deleteSkillFile, isValidSkillName, SkillError } from "@/lib/agent/skills-store";

type Ctx = { params: Promise<{ name: string; path: string[] }> };

function mapErr(err: unknown): NextResponse | null {
  if (err instanceof SkillError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "read_only" ? 403 : err.code === "invalid_path" ? 400 : 400;
    return NextResponse.json({ ok: false, error: err.message }, { status });
  }
  return null;
}

async function resolve(params: Ctx["params"]): Promise<{ name: string; rel: string } | null> {
  const { name, path } = await params;
  if (!isValidSkillName(name)) return null;
  return { name, rel: (path ?? []).join("/") };
}

/** 读技能内单个文件内容(文本)。 */
export const GET = withApiError(async function GET(_request: Request, { params }: Ctx) {
  const r = await resolve(params);
  if (!r) return NextResponse.json({ ok: false, error: "技能名不合法" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, data: await readSkillFile(r.name, r.rel) });
  } catch (err) {
    const mapped = mapErr(err);
    if (mapped) return mapped;
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ ok: false, error: "文件不存在" }, { status: 404 });
    }
    throw err;
  }
}, "/api/skills/[name]/files/[...path]");

/** 写技能内文件(新建或覆盖);仅用户技能可写。 */
export const PUT = withApiError(async function PUT(request: Request, { params }: Ctx) {
  const r = await resolve(params);
  if (!r) return NextResponse.json({ ok: false, error: "技能名不合法" }, { status: 400 });
  const body = (await request.json()) as { content?: string };
  try {
    await writeSkillFile(r.name, r.rel, body.content ?? "");
    return NextResponse.json({ ok: true, data: { path: r.rel } });
  } catch (err) {
    const mapped = mapErr(err);
    if (mapped) return mapped;
    throw err;
  }
}, "/api/skills/[name]/files/[...path]");

/** 删技能内文件;仅用户技能可删,SKILL.md 不可删。 */
export const DELETE = withApiError(async function DELETE(_request: Request, { params }: Ctx) {
  const r = await resolve(params);
  if (!r) return NextResponse.json({ ok: false, error: "技能名不合法" }, { status: 400 });
  try {
    await deleteSkillFile(r.name, r.rel);
    return NextResponse.json({ ok: true, data: { removed: true } });
  } catch (err) {
    const mapped = mapErr(err);
    if (mapped) return mapped;
    throw err;
  }
}, "/api/skills/[name]/files/[...path]");
